#!/usr/bin/env node
/**
 * cadre/personalizer.js — write the first email for signal-qualified leads.
 *
 * This differs from the other two campaigns' personalizers in one way that matters: the model is
 * NOT being asked to infer the prospect's pain. That inference is what the Aevon copy did, across
 * 3,506 sends and zero meetings. Here the pain is already in the database, verbatim, because the
 * company published it themselves in a job ad.
 *
 * So the model's job is narrow: wrap a sentence the prospect wrote in a short, plain email. The
 * sentence itself must survive untouched, and that is checked rather than trusted. A paraphrased
 * quote is worse than no email, because the entire premise of the campaign is that the opening
 * line is theirs and not ours.
 *
 * Every constraint below is either a rule from CLAUDE.md or a finding from the cold email
 * research summarised in cadre/drafts-v2.md. The validator enforces them deterministically after
 * generation, and the model gets three attempts before the lead is skipped.
 *
 *   node cadre/personalizer.js --dry --limit 3
 *   node cadre/personalizer.js --limit 20
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const supabase = require('../lib/supabase');
const { createGenerate } = require('../lib/gemini');

const TABLE = 'cadre_leads';
const DRY = process.argv.includes('--dry');
const SHOW = process.argv.includes('--show') || DRY;
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  return i > -1 ? parseInt(process.argv[i + 1], 10) : 25;
})();

const generate = createGenerate(process.env.GEMINI_API_KEY_AGENT || process.env.GEMINI_API_KEY);

/** Models emit curly quotes and non-breaking hyphens. Flatten to ASCII before anything else. */
function normalise(t) {
  return String(t)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, '-').replace(/ /g, ' ')
    .replace(/[ 	]+/g, ' ').trim();
}

/** Longest run of consecutive words from the quote that appears in the body, case-insensitive. */
function longestVerbatimRun(quote, body) {
  const q = quote.toLowerCase().replace(/\s+/g, ' ').split(' ');
  const b = ' ' + body.toLowerCase().replace(/\s+/g, ' ') + ' ';
  let best = 0;
  for (let i = 0; i < q.length; i++) {
    for (let j = q.length; j > i + best; j--) {
      const run = q.slice(i, j).join(' ');
      if (run.length > 3 && b.includes(run)) { best = Math.max(best, j - i); break; }
    }
  }
  return best;
}

const BANNED = [
  { re: /—/, why: 'em dash' },
  { re: /\$|\bCAD\b|per user|\/mo\b|per month/i, why: 'mentions price' },
  { re: /\b(our (other )?clients?|clients like|we work with|customers like)\b/i, why: 'implies a client base that does not exist' },
  { re: /\bfree\b(?!\s+up)/i, why: 'offers something free' },
  { re: /\b(salus|sitedocs|ecompliance|bamboohr|rippling|humi|assignar|hammertech)\b/i, why: 'names a competitor' },
  { re: /\bchangepain|change pain|artus\b/i, why: 'names the employer' },
  { re: /\b(as discussed|per our (call|conversation)|following up on our|great speaking)\b/i, why: 'claims a prior conversation' },
];

/**
 * Deterministic gate on generated copy. Returns a reason to reject, or null to accept.
 * The quote check is the important one; the rest are hygiene.
 */
function reject(subject, body, lead) {
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  const subjWords = subject.trim().split(/\s+/).length;
  const first = (lead.contact_name || '').trim().split(/\s+/)[0];

  if (subjWords > 4) return `subject is ${subjWords} words, research says 4 or fewer`;
  if (/[.!?]$/.test(subject.trim())) return 'subject ends with punctuation';
  if (words < 45) return `body is ${words} words, too thin`;
  if (words > 90) return `body is ${words} words, over the limit`;
  if (first && !new RegExp(`^Hi ${first}\\b`, 'i').test(body.trim())) return `does not open with "Hi ${first},"`;
  if (!first && !/^Hi\b/i.test(body.trim())) return 'no greeting';
  if (!/\?\s*$/.test(body.trim())) return 'does not end with a question';

  // THE CHECK THAT MATTERS. Their words must survive intact.
  const quoteWords = lead.signal_quote.trim().split(/\s+/).length;
  const need = Math.min(6, Math.max(3, quoteWords - 2));
  const run = longestVerbatimRun(lead.signal_quote, body);
  if (run < need) return `only ${run} consecutive words of their quote survived, need ${need}`;

  for (const b of BANNED) if (b.re.test(body) || b.re.test(subject)) return b.why;

  // One person writing to another. "Our software" and "our platform" imply a company with
  // staff and customers behind it, which is not true and reads as a template.
  if (/\b(our (software|platform|team|product|solution)|we offer|we provide|we help)\b/i.test(body)) {
    return 'writes as a company rather than as one person';
  }
  if (!/\bI\b/.test(body)) return 'never uses the first person';

  // The quote has to be introduced, not dropped in. One generated body opened with the bare
  // quote as line two and read as a broken template.
  if (!/\b(saw|noticed|read|came across)\b/i.test(body)) {
    return 'does not say where the quote came from';
  }

  // FABRICATION GUARD. A generated body claimed Kootenay Co-op has "many volunteer
  // coordinators", which is invented. Words describing workforce composition are only allowed
  // if they actually appear in what we know about this lead.
  const known = [lead.signal_quote, lead.notes, lead.industry, lead.business_name]
    .filter(Boolean).join(' ').toLowerCase();
  const CLAIMS = ['volunteer', 'part-time', 'part time', 'full-time', 'full time', 'casual',
    'seasonal', 'union', 'unionized', 'contractor', 'subcontractor', 'apprentice', 'shift work',
    'night shift', 'franchise', 'family-owned', 'family owned'];
  for (const c of CLAIMS) {
    if (body.toLowerCase().includes(c) && !known.includes(c)) {
      return `invented a fact about them: "${c}"`;
    }
  }
  return null;
}

function buildPrompt(lead) {
  const first = (lead.contact_name || '').trim().split(/\s+/)[0];
  return `Write one short cold email. Return ONLY valid JSON: {"subject": "...", "body": "..."}

WHO IT IS TO
Company: ${lead.business_name}
${first ? `Person: ${first}${lead.contact_role ? `, ${lead.contact_role}` : ''}` : 'No named contact, open with "Hi there,"'}
Location: ${lead.city || 'Canada'}
Industry: ${lead.industry}
${lead.staff_estimate ? `Roughly ${lead.staff_estimate} staff.` : ''}

WHAT THEY PUBLISHED, in a recent job ad. This is the whole reason we are writing:
"${lead.signal_quote}"

WHAT WE SELL
Software that keeps staff records, onboarding, training and credential renewals on ONE employee
record. A certification nearing expiry triggers the course that renews it, and completing the
course clears the credential with nobody re-keying anything. It reminds the person and copies
their manager a month before expiry, through email and Microsoft Teams.

THE SHAPE, follow it exactly:
Line 1: "Hi ${first || 'there'},"
Line 2: Say you SAW or NOTICED the posting, then QUOTE THEIR SENTENCE. Never drop the quote in
        without saying where it came from. Reproduce at least six consecutive
        words of it EXACTLY as written above. Do not reword, tidy, shorten or fix their grammar.
Line 3: One plain observation about why that gets harder. Base it ONLY on facts given above.
        Do NOT invent anything about their workforce: not volunteers, not part-timers, not
        contractors, not shifts, not union status, not anything else you were not told.
Line 4: One sentence on what the software does, written as "I build software that ...".
        Never "our software", never "we provide". One person, not a company. No feature list.
Line 5: A short question they can answer with a no.

HARD RULES
- Body between 55 and 80 words total.
- Subject 2 to 4 words, lowercase, no punctuation at the end. Concrete, drawn from their own
  words. Never a sentence, never a question, never "quick question" or "following up".
- Write as I, one person to another. Contractions. No corporate register.
- Never mention price, never offer anything free, never claim we have clients or customers,
  never name another software company, never claim a previous conversation.
- No em dashes anywhere. Use commas or full stops.
- Do not sign off. A signature is appended later.
- Do not invent anything about them beyond what is above.`;
}

module.exports = { reject, longestVerbatimRun, normalise };

// Only run when invoked directly, so the validator can be unit tested without hitting a model
// or the database.
if (require.main === module) (async () => {
  const { data: leads, error } = await supabase.from(TABLE)
    .select('id, business_name, city, industry, contact_name, contact_role, staff_estimate, signal_quote, notes, email, qualification_score')
    .eq('status', 'queued')
    .is('email_subject', null)
    .not('email', 'is', null)
    .not('signal_quote', 'is', null)
    .order('qualification_score', { ascending: false, nullsFirst: false })
    .limit(LIMIT);
  if (error) throw new Error(error.message);
  if (!leads.length) { console.log('Nothing to personalize.'); return; }

  console.log(`${DRY ? 'DRY RUN: ' : ''}writing copy for ${leads.length} lead(s)\n`);

  let ok = 0, skipped = 0;
  for (const [i, lead] of leads.entries()) {
    process.stdout.write(`[${i + 1}/${leads.length}] ${lead.business_name.slice(0, 36).padEnd(38)}`);
    let written = null, lastReason = '';

    for (let attempt = 0; attempt < 3 && !written; attempt++) {
      let raw;
      try { raw = await generate(buildPrompt(lead)); }
      catch (e) { lastReason = `model error: ${e.message}`; continue; }

      let parsed;
      try {
        const m = String(raw).match(/\{[\s\S]*\}/);
        parsed = JSON.parse(m ? m[0] : raw);
      } catch { lastReason = 'unparseable output'; continue; }

      const subject = normalise(parsed.subject || '');
      const body = normalise(parsed.body || '');
      const bad = reject(subject, body, lead);
      if (bad) { lastReason = bad; continue; }
      written = { subject, body };
    }

    if (!written) { console.log(`SKIPPED (${lastReason})`); skipped++; continue; }

    console.log(`ok  "${written.subject}"  ${written.body.split(/\s+/).length}w`);
    if (SHOW) console.log(`\n${written.body}\n`);

    if (!DRY) {
      const { error: upErr } = await supabase.from(TABLE).update({
        email_subject: written.subject,
        email_body: written.body,
        personalization_basis: 'verbatim published signal quote',
      }).eq('id', lead.id);
      if (upErr) { console.error(`      save failed: ${upErr.message}`); continue; }
    }
    ok++;
  }

  console.log(`\n${DRY ? 'Would write' : 'Wrote'} ${ok} | skipped ${skipped}`);
  if (!DRY && ok) console.log('Next: node cadre/schedule.js to spread them across send days.');
})().catch(e => { console.error('personalizer failed:', e.message); process.exit(1); });
