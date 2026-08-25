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
  // The closing ask is a token now, substituted at send time from cadre/offer.js, so the body
  // ends with {{ASK}} rather than a question mark. Requiring one here rejected every email the
  // moment the offer moved into a token.
  if (!body.includes('{{ASK}}') && !/\?\s*$/.test(body.trim())) {
    return 'no closing ask: needs the {{ASK}} token or a question';
  }

  // THE CHECK THAT MATTERS. Their words must survive intact.
  const quoteWords = lead.signal_quote.trim().split(/\s+/).length;
  const need = Math.min(6, Math.max(3, quoteWords - 2));
  const run = longestVerbatimRun(lead.signal_quote, body);
  if (run < need) return `only ${run} consecutive words of their quote survived, need ${need}`;


  // Aevon IS a company, so "we" is legitimate and is not blocked. What is blocked is any claim
  // of a CUSTOMER BASE, because there are zero clients. "We often hear this" is true, since
  // Aidan works inside a 75-staff clinic and talks to practitioners all week. "Our clients say"
  // is not, and never will be until someone signs.
  if (/\b(our (clients?|customers?)|clients like|customers like|many of our|we work with|companies we (work|serve)|our users)\b/i.test(body)) {
    return 'claims a customer base that does not exist';
  }

  // A statement ending in a question mark reads as machine-written. Two generated bodies had
  // "I build software that ... flags gaps before they become problems?"
  for (const line of body.split('\n')) {
    if (/^\s*I build software that\b/i.test(line) && /\?\s*$/.test(line)) {
      return 'a statement ends with a question mark';
    }
  }

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

/**
 * Which English to write in.
 *
 * Canadian, British and American English are three different registers, and mixing them is a
 * tell. A British reader notices "license" as a noun and "center"; an American reader notices
 * "organisation" and "programme". The sender is Canadian, so Canadian spelling is the default
 * and is close enough to British to pass, but American copy must be deliberately American.
 *
 * The signal quote is left EXACTLY as published regardless, including their spelling. It is
 * their sentence, not ours, and correcting it would break the one thing this campaign relies on.
 */
function localeFor(lead) {
  const where = `${lead.city || ''} ${lead.notes || ''}`.toUpperCase();
  if (/\[US\]|\b(WA|OR|ID|MT|UT|CO|AZ|NV|TX|OH|PA|IL|IN|MI|WI|MN|MO|TN|GA|NC|AL|LA|OK|KS|IA|CA|FL|NY)\b/.test(where)
      && !/\b(BC|AB|SK|MB|ON|QC|NS|NB|NL|PE)\b/.test(where)) return 'us';
  if (/\[UK\]|\[IE\]|ENGLAND|SCOTLAND|WALES|LONDON|MANCHESTER|BIRMINGHAM|LEEDS|GLASGOW|BRISTOL|DUBLIN|CORK|GALWAY/.test(where)) return 'uk';
  if (/\[AU\]|NEW SOUTH WALES|VICTORIA|QUEENSLAND|AUSTRALIA/.test(where)) return 'uk';
  return 'ca';
}

const SPELLING = {
  ca: 'Canadian English. "licence" for the noun and "license" for the verb, "centre", "labour", "organization" with a z.',
  uk: 'British English. "licence" for the noun and "license" for the verb, "centre", "labour", "organisation" and "programme" with an s.',
  us: 'American English. "license" for both noun and verb, "center", "labor", "organization" and "program". Never "licence", never "centre", never "programme".',
};

/**
 * Four ways to write the same email.
 *
 * The research is blunt that this is the SECOND most important thing, not the first: emails
 * triggered by a real buying signal reply at 3-5x any well-written template, and every email
 * here is signal-triggered already. Framework choice is worth a few points on top of that, not
 * a multiple.
 *
 * Variety earns its place for a different reason. Fifteen emails a day in one identical shape
 * reads as a campaign to a human and as a pattern to a filter. Four shapes, rotated by lead id
 * so the same company always gets the same one, breaks that up without losing the premise.
 *
 * What each is and why it is here:
 *  - TRIGGER: leads with the event, that they are hiring for this. The most honest of the four,
 *    because the posting IS the reason we are writing.
 *  - PAS: problem, agitate, solve. Reported as the strongest first-touch structure in B2B SaaS.
 *    Agitation is capped at one line; more than that reads as manipulation.
 *  - QUESTION: opens on their sentence and spends the email asking rather than telling. Question
 *    framing lifts replies roughly 20%.
 *  - SHORT: under 55 words, no argument at all, just their line and one question.
 *
 * BAB (before-after-bridge) is deliberately absent. It needs a customer story, there are no
 * customers, and inventing one is the single thing that must never happen.
 */
const APPROACHES = [
  {
    name: 'trigger',
    shape: [
      'Line 1: "Hi {FIRST},"',
      'Line 2: Say you saw the posting, then QUOTE THEIR SENTENCE exactly.',
      'Line 3: BRIDGE from their quote to onboarding. In one plain sentence, say the records problem',
      '        they advertised is what manual onboarding looks like from the outside. Base it only on',
      '        facts given above and invent nothing about their workforce.',
      'Line 4: One sentence, starting "I build software that", on the ONBOARDING and lifecycle, not on certificate tracking.',
      'Line 5: The literal token {{ASK}} on its own line. Do NOT write a question of your own.',
    ].join('\n'),
  },
  {
    name: 'pas',
    shape: [
      'Line 1: "Hi {FIRST},"',
      'Line 2: State the problem in their own words: say where you saw it, then QUOTE THEIR SENTENCE exactly.',
      'Line 3: ONE line on what it costs when onboarding is manual: how long a new person takes to',
      '        be useful, or what gets missed. Concrete and understated. No fear-mongering.',
      'Line 4: One sentence, starting "I build software that", on running onboarding end to end so the records look after themselves.',
      'Line 5: The literal token {{ASK}} on its own line. Do NOT write a question of your own.',
    ].join('\n'),
  },
  {
    name: 'question',
    shape: [
      'Line 1: "Hi {FIRST},"',
      'Line 2: Say you saw the posting and QUOTE THEIR SENTENCE exactly.',
      'Line 3: Ask how they onboard a new starter today. Genuinely curious, not rhetorical, not leading.',
      'Line 4: One short sentence, starting "I build software that", under twenty words. This',
      '        version is mostly question, not pitch.',
      'Line 5: The literal token {{ASK}} on its own line. Do NOT write a question of your own.',
    ].join('\n'),
  },
  {
    name: 'short',
    shape: [
      'Line 1: "Hi {FIRST},"',
      'Line 2: Say you saw the posting and QUOTE THEIR SENTENCE exactly.',
      'Line 3: One sentence, starting "I build software that", on the ONBOARDING and lifecycle, not on certificate tracking.',
      'Line 4: The literal token {{ASK}} on its own line. Do NOT write a question of your own.',
      'TOTAL BODY UNDER 55 WORDS. No observation line at all. Nothing to argue with.',
    ].join('\n'),
  },
];

/** Same lead always gets the same approach, so re-running does not change their email. */
function approachFor(lead) {
  let h = 0;
  for (const ch of String(lead.id || lead.business_name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return APPROACHES[h % APPROACHES.length];
}

function buildPrompt(lead) {
  const first = (lead.contact_name || '').trim().split(/\s+/)[0];
  const approach = approachFor(lead);
  const shape = approach.shape.replace(/\{FIRST\}/g, first || 'there');
  return `Write one short cold email. Return ONLY valid JSON: {"subject": "...", "body": "..."}

WHO IT IS TO
Company: ${lead.business_name}
${first ? `Person: ${first}${lead.contact_role ? `, ${lead.contact_role}` : ''}` : 'No named contact, open with "Hi there,"'}
Location: ${lead.city || 'Canada'}
Industry: ${lead.industry}
${lead.staff_estimate ? `Roughly ${lead.staff_estimate} staff.` : ''}

WHAT THEY PUBLISHED, in a recent job ad. This is the whole reason we are writing:
"${lead.signal_quote}"

WHAT WE SELL, and what to LEAD with

Lead with ONBOARDING, not certificate tracking.

The quote you are given is almost always about training records or certifications. That is the
SIGNAL, meaning it is why we found them and why the email is relevant. It is not the pitch.
Certificate tracking on its own is a filing cabinet, and there are dedicated tools that do only
that. Onboarding is what an HR or safety manager is actually measured on: 20% of all staff
turnover happens in the first 45 days, and 52% of new hires say admin dominated their first week.

The product runs the whole employee lifecycle on ONE record per person:
  - Role-based onboarding. A new welder and a new receptionist get different paths.
  - The training for that role is assigned as part of it, not chased separately afterwards.
  - Completing the course auto-completes the onboarding step. Nobody re-keys anything.
  - The credential is enrolled with its renewal date already set, so the reminders start
    themselves at 60, 30 and 7 days and copy the manager a month before it lapses.
  - Policies, documents and equipment are collected in the same flow.

So the argument in the email is: the records problem they advertised is a SYMPTOM. It shows up in
the spreadsheet because onboarding is manual end to end, and fixing the spreadsheet fixes the
symptom.

Reminders and expiry tracking may be mentioned as the tail of that sentence. They must never be
the whole of it.

THE SHAPE, follow it exactly:
${shape}

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
