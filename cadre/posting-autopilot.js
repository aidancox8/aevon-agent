#!/usr/bin/env node
/**
 * cadre/posting-autopilot.js
 *
 * The posting-quote email on a daily schedule, run from GitHub Actions so it does not depend on
 * Aidan's laptop. Each run sends a few, the day is capped, Canada goes first, then the US.
 *
 *   node cadre/posting-autopilot.js                 dry run: print the next picks, send nothing
 *   node cadre/posting-autopilot.js --send          send up to --per-run (default 3)
 *
 * Guards, in order: the PT weekday/holiday send window (checked again right before each send),
 * the daily cap across runs, the shared posting rules in posting-copy.js, the cross-campaign
 * suppression list, and a Verifalia check on every address. Undeliverable addresses are marked
 * invalid and never retried; catch-all servers are sent (they accept, so they do not bounce).
 * Only --send sends. CI does not imply live (the 2026-10-14 CADRE_ARMED lesson).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const { blockReason, emailFor, region } = require('./posting-copy');
const { inSendWindow, pacificParts } = require('../lib/send-window');
const { loadSuppressions, isSuppressed } = require('../lib/suppression');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const SEND = process.argv.includes('--send');
const PER_RUN = parseInt(arg('--per-run', '3'), 10);
const DAILY_CAP = parseInt(process.env.POSTING_DAILY_CAP || arg('--cap', '20'), 10);
const MAX_AGE_DAYS = 75;
const REGIONS = ['CA', 'US'];
const BASIS = 'campaign:posting-quote-2026-10';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function allLeads() {
  let all = [], from = 0;
  for (;;) {
    const { data, error } = await sb.from('cadre_leads').select('*').range(from, from + 999);
    if (error) throw new Error(error.message);
    all = all.concat(data); if (data.length < 1000) return all; from += 1000;
  }
}

async function sentToday() {
  const { date } = pacificParts();
  // Midnight Pacific, close enough: PDT is UTC-7, PST UTC-8; take the earlier bound.
  const since = new Date(`${date}T07:00:00Z`).toISOString();
  const { count, error } = await sb.from('cadre_leads').select('id', { count: 'exact', head: true })
    .eq('personalization_basis', BASIS).gte('last_sent_at', since);
  if (error) throw new Error(error.message);
  return count;
}

async function verify(email) {
  const auth = 'Basic ' + Buffer.from(`${process.env.VERIFALIA_USER}:${process.env.VERIFALIA_PASS}`).toString('base64');
  let r = await fetch('https://api.verifalia.com/v2.6/email-validations?waitTime=30000', {
    method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [{ inputData: email }] }),
  });
  let j = await r.json();
  if (!j.overview) throw new Error(`verifalia ${r.status} ${JSON.stringify(j).slice(0, 160)}`);
  for (let i = 0; i < 12 && j.overview.status !== 'Completed'; i++) {
    await sleep(10000);
    j = await (await fetch(`https://api.verifalia.com/v2.6/email-validations/${j.overview.id}`, { headers: { Authorization: auth } })).json();
  }
  const e = (j.entries && (j.entries.data || j.entries) || [])[0];
  return e ? { classification: e.classification, status: e.status } : { classification: 'Unknown', status: 'no result' };
}

(async () => {
  if (SEND && !inSendWindow()) { console.log(`Outside the send window (${pacificParts().weekday} ${pacificParts().hour}:00 PT). Nothing sent.`); return; }
  const done = await sentToday();
  const room = Math.max(0, Math.min(PER_RUN, DAILY_CAP - done));
  console.log(`${done}/${DAILY_CAP} sent today, room for ${room} this run.`);
  if (SEND && room === 0) return;

  const SUPP = await loadSuppressions();
  const leads = await allLeads();
  const seen = new Set(leads.filter(l => l.last_sent_at && l.email).map(l => l.email.toLowerCase()));
  const pool = leads.filter(l => !blockReason(l, { maxPostingAgeDays: MAX_AGE_DAYS, regions: REGIONS })
    && !/autopilot verify/.test(l.notes || '') && !isSuppressed(l.email, l.business_name, SUPP) && !seen.has(l.email.toLowerCase()));
  const rank = l => (region(l) === 'CA' ? 0 : 1);
  pool.sort((a, b) => rank(a) - rank(b) || String(b.signal_date).localeCompare(String(a.signal_date)));
  console.log(`Pool: ${pool.length} (CA ${pool.filter(l => region(l) === 'CA').length}, US ${pool.filter(l => region(l) === 'US').length}).`);

  if (!SEND) {
    for (const l of pool.slice(0, Math.max(room, PER_RUN))) {
      const e = emailFor(l);
      console.log(`\n--- ${l.business_name} | ${l.city} | ${l.industry} | ${l.staff_estimate ?? '?'} staff | <${l.email}>\nSubject: ${e.subject}\n\n${e.body}`);
    }
    console.log('\nDRY RUN: nothing sent. Pass --send to send.');
    return;
  }

  const o = new google.auth.OAuth2(process.env.GMAIL_OAUTH_CLIENT_ID, process.env.GMAIL_OAUTH_CLIENT_SECRET);
  o.setCredentials({ refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN });
  const g = google.gmail({ version: 'v1', auth: o });
  let sent = 0;
  for (const l of pool) {
    if (sent >= room) break;
    const v = await verify(l.email);
    if (v.classification === 'Undeliverable' || (v.classification === 'Risky' && v.status !== 'ServerIsCatchAll') || v.classification === 'Unknown') {
      await sb.from('cadre_leads').update({ email_quality: v.classification === 'Undeliverable' ? 'invalid' : l.email_quality,
        notes: `${l.notes ? l.notes + ' | ' : ''}autopilot verify ${new Date().toISOString().slice(0, 10)}: ${v.classification} ${v.status}, not sent` }).eq('id', l.id);
      console.log(`skip ${l.business_name} <${l.email}>: ${v.classification} ${v.status}`);
      continue;
    }
    const e = emailFor(l);
    if (/—/.test(e.body)) { console.log(`skip ${l.business_name}: em dash in copy`); continue; }
    if (sent > 0) await sleep((4 + Math.random() * 6) * 60 * 1000); // 4 to 10 minutes apart
    if (!inSendWindow()) { console.log('Send window closed mid-run. Stopping.'); break; }
    const raw = [`From: Aidan Cox <aidan@aevon.ca>`, `To: ${l.email}`, `Subject: ${e.subject}`, 'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', e.body].join('\r\n');
    try {
      await g.users.messages.send({ userId: 'me', requestBody: { raw: Buffer.from(raw).toString('base64url') } });
      const now = new Date().toISOString();
      await sb.from('cadre_leads').update({ status: 'sent', last_sent_at: now, sequence_step: 1, personalization_basis: BASIS,
        email_subject: e.subject, email_body: e.body, notes: `${l.notes ? l.notes + ' | ' : ''}posting autopilot ${now.slice(0, 10)} (${v.classification})` }).eq('id', l.id);
      sent++;
      console.log(`${now} sent ${l.business_name} <${l.email}> ${region(l)} ${v.classification}`);
    } catch (err) { console.error(`FAILED ${l.business_name}: ${err.message}`); }
  }
  console.log(`Done. Sent ${sent} this run.`);
})().catch(e => { console.error(e.message); process.exit(1); });
