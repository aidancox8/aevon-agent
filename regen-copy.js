#!/usr/bin/env node
/**
 * Rewrite the pre-generated copy for queued leads that have not been contacted yet.
 *
 * Needed after a prompt change: personalizer.js only writes copy for leads that have none,
 * so leads personalized under an older prompt keep that copy until they send. At ~59 initial
 * sends a day, a backlog of ~3k is over a month of outreach using the old wording.
 *
 * Overwrites in place rather than clearing first. Nulling email_subject in bulk would make
 * every one of those leads invisible to the sender until regeneration caught up, which would
 * stop initial outreach for days. Here a lead always holds valid copy: either the old version
 * or the new one.
 *
 * Only touches leads that have never been sent to. A lead mid-sequence keeps the follow-ups
 * that match the email it already received.
 *
 *   node regen-copy.js --limit 50      rewrite the 50 highest-scoring
 *   node regen-copy.js --limit 50 --dry   generate and print, save nothing
 */
require('dotenv').config();
const supabase = require('./lib/supabase');
const { createGenerate } = require('./lib/gemini');
const { scrapeContext } = require('./lib/contact-finder');
const { buildPrompt } = require('./personalizer');

const generate = createGenerate(process.env.GEMINI_API_KEY);
const arg = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? parseInt(process.argv[i + 1], 10) : dflt;
};
const LIMIT = arg('--limit', 25);
const DRY = process.argv.includes('--dry');

// Free tier allows 15 requests/minute, so 4s is the theoretical floor. The first run of this
// script used 4.2s and its last ten calls all failed together, so the real ceiling is tighter
// than the arithmetic. 4.6s plus backoff costs a few minutes over a batch and avoids losing
// the tail of a long run.
const GAP = 4600;
let lastCall = 0;
let consecutiveFailures = 0;

async function rateLimited(prompt) {
  const wait = GAP - (Date.now() - lastCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
  try {
    const out = await generate(prompt);
    consecutiveFailures = 0;
    return out;
  } catch (e) {
    consecutiveFailures++;
    // Back off progressively. A burst of failures usually means the per-minute limit was
    // tripped, and hammering it just extends the outage.
    const backoff = Math.min(60000, 5000 * consecutiveFailures);
    console.log(`\n  (api error, waiting ${Math.round(backoff / 1000)}s: ${e.message.slice(0, 60)})`);
    await new Promise(r => setTimeout(r, backoff));
    throw e;
  }
}

function parseJsonObject(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/```json/gi, '').replace(/```/g, '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

const noDash = s => (s == null ? s : String(s).replace(/\s*[—–]\s*/g, ', '));
const opensWithUs = b => /^(aevon|we (build|are)|i'?m reaching)/i.test(String(b || '').trim());

(async () => {
  const { data: pool, error } = await supabase
    .from('leads')
    .select('id, business_name, industry, city, website, email, contact_name, contact_role, qualification_score, lead_insights, email_body')
    .eq('status', 'queued')
    .is('last_sent_at', null)
    .not('email', 'is', null)
    .not('email_subject', 'is', null)
    // Must match the sender's initial-pick order exactly (sender.js: score desc, then
    // scheduled_send_at asc). Only three distinct scores exist across ~3k un-sent leads
    // (9: 126, 8: 1152, 7: 1697), so sorting by score alone leaves the database free to
    // return each huge tier in arbitrary order. Rewriting then lands on leads that are not
    // the ones about to send, and old copy keeps going out for weeks while the backlog
    // technically shrinks. With the tiebreaker aligned, the next leads to send are always
    // the ones already rewritten.
    .order('qualification_score', { ascending: false, nullsFirst: false })
    .order('scheduled_send_at', { ascending: true })
    .limit(LIMIT * 6);
  if (error) throw new Error(error.message);
  if (!pool?.length) { console.log('Nothing to regenerate.'); return; }

  // Only rewrite copy that actually has the defect. Rewritten leads no longer match, which
  // makes this safe to re-run: each pass picks up where the last stopped, with no marker
  // column and no risk of paying for the same lead twice. Leads whose opener was already
  // fine are left alone.
  const leads = pool.filter(l => opensWithUs(l.email_body)).slice(0, LIMIT);
  if (!leads.length) { console.log(`Nothing stale in the top ${pool.length} by score. Done.`); return; }

  const staleBefore = leads.length;
  console.log(`${DRY ? 'DRY RUN: ' : ''}regenerating ${leads.length} lead(s) whose copy opens with the sender.\n`);

  let ok = 0, failed = 0, fixed = 0;
  for (const [i, lead] of leads.entries()) {
    process.stdout.write(`[${i + 1}/${leads.length}] ${lead.business_name.slice(0, 42)}... `);
    try {
      const site = lead.website ? await scrapeContext(lead.website).catch(() => null) : null;
      let content = null;
      for (let a = 0; a < 2 && !content; a++) {
        const raw = await rateLimited(buildPrompt(lead, site)).catch(() => null);
        const p = parseJsonObject(raw);
        if (p?.email_subject && p?.email_body) content = p;
      }
      if (!content) { console.log('FAILED (no valid content)'); failed++; continue; }

      const wasStale = opensWithUs(lead.email_body);
      const nowClean = !opensWithUs(content.email_body);
      if (wasStale && nowClean) fixed++;

      if (DRY) { console.log(`ok ${nowClean ? '' : '(still opens with sender)'}`); ok++; continue; }

      // scheduled_send_at is deliberately left alone: these leads already hold a slot in the
      // queue and rescheduling them would reshuffle send order for no reason.
      const { error: upErr } = await supabase.from('leads').update({
        email_subject: noDash(content.email_subject),
        email_body: noDash(content.email_body),
        followup_subject: noDash(content.followup_subject),
        followup_body: noDash(content.followup_body),
        followup2_subject: noDash(content.followup2_subject) || null,
        followup2_body: noDash(content.followup2_body) || null,
        lead_insights: content.lead_insights || null,
        personalization_basis: content.personalization_basis || null,
      }).eq('id', lead.id);
      if (upErr) throw new Error(upErr.message);
      console.log(`ok ${nowClean ? '' : '(still opens with sender)'}`);
      ok++;
    } catch (e) {
      console.log(`FAILED (${e.message})`);
      failed++;
    }
  }
  console.log(`\nDone. rewritten ${ok} | failed ${failed} | openers fixed ${fixed}/${staleBefore}`);
})().catch(e => { console.error('regen failed:', e.message); process.exit(1); });
