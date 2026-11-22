#!/usr/bin/env node
/**
 * cadre/watchdog.js, the thing that notices when the Cadre pipeline has quietly stopped, so
 * Aidan does not have to ask.
 *
 * WHY THIS EXISTS. On 2026-11-12 an unquoted colon in a step name made cadre-muse-bridge.yml
 * invalid YAML. GitHub does not run an invalid workflow and does not email about it either, so
 * the bridge was dead for four days and nobody knew until Aidan asked why Muse was not working.
 * The same week the send pool sat at zero and the Muse queue at "0 of 0" with no alert.
 *
 * It emails aidan@aevon.ca (Resend) only when something is wrong:
 *   1. a workflow file that does not parse, or has no trigger or no jobs
 *   2. a scheduled workflow with no successful run for days, or a "push" failure on a workflow
 *      that has no push trigger (how GitHub reports an invalid file)
 *   3. no posting-quote email sent for 2+ working days, with the pool size
 *   4. the Muse queue empty, or Muse silent while it has companies; unread Muse replies are relayed
 *
 *   node cadre/watchdog.js [--only yaml] [--dry]     (--dry prints, never emails)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const YAML = require('yaml');

const DRY = process.argv.includes('--dry');
const ONLY_YAML = process.argv.includes('--only');
const ROOT = path.join(__dirname, '..');
const REPO = process.env.GITHUB_REPOSITORY || 'aidancox8/aevon-agent';
const problems = [];
const notes = [];
const DAY = 864e5;

// Scheduled workflows that must keep succeeding, and how many days of silence is too many
// (4 covers Friday to Monday plus GitHub's schedule delay). daily-review.yml runs weekly despite
// its name, so 3 days raised a false alarm on 2026-11-21; 9 covers a week plus delay.
const WATCHED = { 'cadre-muse-bridge.yml': 4, 'cadre-posting-autopilot.yml': 4, 'daily-review.yml': 9 };

function checkYaml() {
  const dir = path.join(ROOT, '.github', 'workflows');
  const pushTriggered = new Set();
  for (const f of fs.readdirSync(dir).filter(x => /\.ya?ml$/.test(x))) {
    try {
      const d = YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!d || !d.jobs || !d.on) { problems.push(`${f} has no trigger or no jobs, so GitHub will not run it.`); continue; }
      if (typeof d.on === 'object' && 'push' in d.on) pushTriggered.add(f);
    } catch (e) {
      problems.push(`${f} is not valid YAML, so GitHub will not run it: ${String(e.message).split('\n')[0]}`);
    }
  }
  return pushTriggered;
}

async function gh(url) {
  const r = await fetch(`https://api.github.com/repos/${REPO}${url}`, {
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub API ${r.status} on ${url}`);
  return r.json();
}

async function checkRuns(pushTriggered) {
  if (!process.env.GITHUB_TOKEN) { notes.push('No GITHUB_TOKEN here, workflow run history not checked.'); return; }
  for (const [f, maxDays] of Object.entries(WATCHED)) {
    const j = await gh(`/actions/workflows/${f}/runs?status=success&per_page=1`);
    const last = j.workflow_runs && j.workflow_runs[0];
    const age = last ? (Date.now() - new Date(last.created_at).getTime()) / DAY : Infinity;
    if (age > maxDays) problems.push(`${f} has not had a successful run for ${last ? Math.floor(age) + ' days' : 'as far back as GitHub shows'}.`);
  }
  const j = await gh('/actions/runs?event=push&status=failure&per_page=30');
  const seen = new Set();
  for (const r of j.workflow_runs || []) {
    const f = path.basename(r.path || '');
    if (Date.now() - new Date(r.created_at).getTime() > 3 * DAY || pushTriggered.has(f) || seen.has(f)) continue;
    seen.add(f);
    // A later success means the file was fixed after that rejection.
    const ok = await gh(`/actions/workflows/${f}/runs?status=success&per_page=1`);
    const lastOk = ok.workflow_runs && ok.workflow_runs[0];
    if (lastOk && new Date(lastOk.created_at) > new Date(r.created_at)) continue;
    problems.push(`GitHub rejected ${f} on a push (${r.created_at.slice(0, 10)}). That is how it reports a broken workflow file.`);
  }
}

/** Working days (Mon to Fri, Pacific) strictly between a date and today. */
function workingDaysSince(d) {
  const day = t => new Date(new Date(t).toLocaleString('en-US', { timeZone: 'America/Vancouver' })).setHours(0, 0, 0, 0);
  let n = 0;
  for (let t = day(d) + DAY; t < day(Date.now()); t += DAY) { const w = new Date(t).getDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}

async function checkSends() {
  const sb = require('../lib/supabase');
  const { data, error } = await sb.from('cadre_leads').select('last_sent_at').like('personalization_basis', 'campaign:posting-quote%')
    .not('last_sent_at', 'is', null).order('last_sent_at', { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  let pool = '?';
  try { pool = (execFileSync('node', [path.join(__dirname, 'posting-autopilot.js')], { encoding: 'utf8' }).match(/Pool: (\d+)/) || [])[1] || '?'; } catch (e) { notes.push(`Autopilot dry run failed: ${String(e.message).slice(0, 120)}`); }
  const last = data[0] && data[0].last_sent_at;
  const idle = last ? workingDaysSince(last) : 99;
  if (idle >= 2) problems.push(`No Cadre email has gone out for ${idle} working days (last one ${last ? last.slice(0, 10) : 'never'}). Sendable leads right now: ${pool}.`);
  else if (pool === '0') notes.push('The send pool is at zero; tomorrow has nothing to send unless the address guesser finds some overnight.');
}

async function checkMuse() {
  const q = fs.readFileSync(path.join(ROOT, 'muse', 'queue.md'), 'utf8');
  const m = q.match(/(\d+) companies \(of (\d+) waiting\)/);
  const queued = m ? parseInt(m[1], 10) : null;
  if (queued === 0) problems.push('Muse has no companies to work on. New companies come from the lead finders, which need a sweep.');
  if (!process.env.GMAIL_OAUTH_REFRESH_TOKEN) { notes.push('No Gmail credentials here, Muse email not checked.'); return; }
  const { google } = require('googleapis');
  const o = new google.auth.OAuth2(process.env.GMAIL_OAUTH_CLIENT_ID, process.env.GMAIL_OAUTH_CLIENT_SECRET);
  o.setCredentials({ refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN });
  const g = google.gmail({ version: 'v1', auth: o });
  const subj = async id => ((await g.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['Subject'] })).data.payload.headers.find(h => h.name === 'Subject') || {}).value;
  if (queued > 0) {
    const r = await g.users.messages.list({ userId: 'me', q: 'subject:"[Muse leads]" newer_than:4d', maxResults: 1 });
    if (!(r.data.messages || []).length) problems.push(`Muse has ${queued} companies queued but has not emailed results in 4 days. Its schedule may have stopped.`);
  }
  const r = await g.users.messages.list({ userId: 'me', q: '{subject:"[Muse reply]" subject:"[Muse note]"} is:unread newer_than:14d', maxResults: 10 });
  for (const msg of r.data.messages || []) notes.push(`Unread from Muse: ${await subj(msg.id)}`);
}

(async () => {
  const pushTriggered = checkYaml();
  if (!ONLY_YAML) {
    for (const [name, fn] of [['runs', () => checkRuns(pushTriggered)], ['sends', checkSends], ['muse', checkMuse]]) {
      try { await fn(); } catch (e) { problems.push(`The watchdog could not finish its ${name} check: ${String(e.message).slice(0, 160)}`); }
    }
  }
  const text = [
    problems.length ? `${problems.length} problem(s):` : 'No problems found.',
    ...problems.map(p => `- ${p}`), '',
    ...(notes.length ? ['Also:', ...notes.map(n => `- ${n}`), ''] : []),
    'Open a Claude session in the agent repo and say "fix the watchdog alert".',
  ].join('\n');
  console.log(text);
  const relay = notes.some(n => n.startsWith('Unread from Muse'));
  if (DRY || (!problems.length && !relay) || !process.env.RESEND_API_KEY) return;
  const r = await fetch('https://api.resend.com/emails', { method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Aevon <aidan@aevon.ca>', to: ['aidan@aevon.ca'],
      subject: problems.length ? `[Aevon ALERT] Cadre pipeline: ${problems.length} problem(s)` : '[Aevon] Muse sent a message', text }) });
  console.log(r.ok ? 'alert sent' : `alert failed ${r.status}`);
})().catch(e => { console.error(e.message); process.exit(1); });
