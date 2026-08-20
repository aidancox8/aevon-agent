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
 * Mid-sequence leads are included, but only their UNSENT fields are rewritten. The filter here
 * used to be `last_sent_at IS NULL`, which skipped every lead past email 1 and left their
 * queued follow-ups frozen on whatever offer was current when they were generated. That is how
 * 1,092 second emails kept quoting a setup fee retired seventeen days earlier, and it is why
 * the send-time guard in lib/copy-guard.js would otherwise hold those leads permanently rather
 * than for a day: nothing was ever going to rewrite them. The already-sent field is left alone,
 * because the stored copy is the only record of what the recipient actually received.
 *
 *   node regen-copy.js --limit 50      rewrite the 50 highest-scoring
 *   node regen-copy.js --limit 50 --dry   generate and print, save nothing
 */
require('dotenv').config();
const supabase = require('./lib/supabase');
const { createGenerate } = require('./lib/gemini');
const { scrapeContext } = require('./lib/contact-finder');
const { retiredOfferReason } = require('./lib/copy-guard');
const { applyAsk } = require('./lib/offer');
// Either campaign. Their buildPrompt signatures differ slightly (Tempo takes a usesJane
// flag), so the call is normalised below rather than duplicating this whole script.
const TABLE = (() => {
  const i = process.argv.indexOf('--table');
  const t = i > -1 ? process.argv[i + 1] : 'leads';
  if (!['leads', 'tempo_leads'].includes(t)) throw new Error('--table must be leads or tempo_leads');
  return t;
})();
const buildPrompt = TABLE === 'tempo_leads'
  ? (lead, site) => require('./tempo/personalizer').buildPrompt(lead, site, false)
  : require('./personalizer').buildPrompt;

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

// Give up once the API is clearly done for the day rather than backing off forever. Without
// this the first scheduled run ground for five and a half hours against an exhausted daily
// quota and was killed by the job timeout, which meant the whole step accomplished nothing
// AND reported as cancelled rather than failed, so the alert never fired.
const MAX_CONSECUTIVE_FAILURES = parseInt(process.env.REGEN_MAX_FAILURES || '8', 10);
class QuotaExhausted extends Error {}

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
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      throw new QuotaExhausted(`${consecutiveFailures} calls failed in a row, stopping`);
    }
    // Back off progressively. A short burst usually means the per-minute limit was tripped,
    // and hammering it just extends the outage. Capped low so a doomed run ends quickly.
    const backoff = Math.min(20000, 4000 * consecutiveFailures);
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
// Both campaigns' old openers. Aevon's led with the company name; Tempo's led with a
// greeting to nobody then a self-introduction ("Hi there. I'm Aidan from Aevon, where we
// build Tempo..."). A detector matching only the first would report Tempo as already clean
// and quietly skip its entire backlog.
const OLD_OPENER = /^(aevon\b|we (build|are)\b|i'?m reaching|hi there|hello there|hi,? i'?m|i'?m aidan|my name is)/i;
// Copy is also stale if it quotes the retired product's pricing. Only three leads currently
// have a clean opener AND a price, but checking one and not the other would leave them
// invisible to every future pass, and a live email quoting $1,500 now contradicts an offer
// of free work.
const OLD_PRICE = /\$1,?500|\$150\b|150\s*\/\s*mo/i;
const opensWithUs = b => {
  const t = String(b || '').trim();
  return OLD_OPENER.test(t) || OLD_PRICE.test(t);
};

(async () => {
  const { data: pool, error } = await supabase
    .from(TABLE)
    .select('id, business_name, industry, city, website, email, contact_name, contact_role, qualification_score, lead_insights, email_body, followup_body, followup2_body, sequence_step')
    .eq('status', 'queued')
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
  // Two defects qualify. The opener one is cosmetic. The second is not: lib/copy-guard.js
  // refuses at send time to ship copy that contradicts the current offer, and this script is
  // the only thing that can clear that. If a held lead is not eligible here it is held
  // forever, silently, which is worse than sending the stale copy would have been.
  const BODY = ['email_body', 'followup_body', 'followup2_body'];
  const dueBody = l => l[BODY[Number(l.sequence_step) || 0]];
  const isStaleOffer = l => TABLE === 'leads'
    && !!retiredOfferReason(applyAsk(dueBody(l) || '', 'aevon', Number(l.sequence_step) || 0, l.id));

  const leads = pool.filter(l => opensWithUs(l.email_body) || isStaleOffer(l)).slice(0, LIMIT);
  if (!leads.length) { console.log(`Nothing stale in the top ${pool.length} by score. Done.`); return; }

  const staleBefore = leads.length;
  console.log(`${DRY ? 'DRY RUN: ' : ''}regenerating ${leads.length} lead(s): ${leads.length - leads.filter(isStaleOffer).length} opening with the sender, ${leads.filter(isStaleOffer).length} contradicting the current offer.\n`);

  let ok = 0, failed = 0, fixed = 0;
  for (const [i, lead] of leads.entries()) {
    process.stdout.write(`[${i + 1}/${leads.length}] ${lead.business_name.slice(0, 42)}... `);
    try {
      const site = lead.website ? await scrapeContext(lead.website).catch(() => null) : null;
      let content = null;
      for (let a = 0; a < 2 && !content; a++) {
        const raw = await rateLimited(buildPrompt(lead, site)).catch(e => {
          if (e instanceof QuotaExhausted) throw e;
          return null;
        });
        const p = parseJsonObject(raw);
        if (p?.email_subject && p?.email_body) content = p;
      }
      if (!content) { console.log('FAILED (no valid content)'); failed++; continue; }

      const wasStale = opensWithUs(lead.email_body);
      const nowClean = !opensWithUs(content.email_body);
      if (wasStale && nowClean) fixed++;

      if (DRY) {
        console.log(`ok ${nowClean ? '' : '(still opens with sender)'}`);
        if (process.argv.includes('--show')) {
          const rendered = applyAsk(content.email_body, 'aevon', 0, lead.id);
          console.log('    SUBJECT: ' + content.email_subject);
          console.log('    ' + rendered);
          console.log('    GUARD: ' + (retiredOfferReason(rendered) || 'clean') + ' | has token: ' + content.email_body.includes('{{ASK}}'));
        }
        ok++; continue;
      }

      // scheduled_send_at is deliberately left alone: these leads already hold a slot in the
      // queue and rescheduling them would reshuffle send order for no reason.
      // Write only what has not gone out yet. Overwriting a sent email would destroy the one
      // record of what the recipient read, and would make any later reply unreadable.
      const step = Number(lead.sequence_step) || 0;
      const patch = {
        lead_insights: content.lead_insights || null,
        personalization_basis: content.personalization_basis || null,
      };
      if (step < 1) {
        patch.email_subject = noDash(content.email_subject);
        patch.email_body = noDash(content.email_body);
      }
      if (step < 2) {
        patch.followup_subject = noDash(content.followup_subject);
        patch.followup_body = noDash(content.followup_body);
      }
      patch.followup2_subject = noDash(content.followup2_subject) || null;
      patch.followup2_body = noDash(content.followup2_body) || null;

      const { error: upErr } = await supabase.from(TABLE).update(patch).eq('id', lead.id);
      if (upErr) throw new Error(upErr.message);
      console.log(`ok ${nowClean ? '' : '(still opens with sender)'}`);
      ok++;
    } catch (e) {
      if (e instanceof QuotaExhausted) {
        console.log(`STOPPING: ${e.message}`);
        console.log('The API budget looks spent. The next scheduled run continues where this stopped.');
        break;
      }
      console.log(`FAILED (${e.message})`);
      failed++;
    }
  }
  console.log(`\nDone. rewritten ${ok} | failed ${failed} | openers fixed ${fixed}/${staleBefore}`);
})().catch(e => { console.error('regen failed:', e.message); process.exit(1); });
