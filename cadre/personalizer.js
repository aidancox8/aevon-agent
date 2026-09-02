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

  // FORMATTING IS NOT COSMETIC. A background run on 2026-08-25 wrote 27 bodies with no blank
  // line anywhere: greeting, quote, claim and ask stacked as one block. On a phone that is a
  // grey wall, and a wall is the fastest way to be deleted unread. Every one of them passed
  // every other check here, which is how they nearly went out.
  if (!/\n\s*\n/.test(body.trim())) return 'no blank line between paragraphs, the body is one wall';
  const paras = body.trim().split(/\n\s*\n/).filter(Boolean);
  if (paras.length < 3) return `only ${paras.length} paragraph(s), needs at least 3`;
  const longest = paras.reduce((m, p) => Math.max(m, p.trim().split(/\s+/).length), 0);
  if (longest > 45) return `a paragraph runs ${longest} words, too long to read on a phone`;

  // The quote belongs woven into a sentence, not dropped in quotation marks. Quoting it as a
  // quotation is the single clearest mail-merge tell: a person paraphrases what they read.
  if (/[:]\s*["“]/.test(body) || /\bit says:?\s*["“]/i.test(body)) {
    return 'the signal quote is presented as a quotation, which reads as a mail merge';
  }
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
      'Line 2: Say you saw the posting, then QUOTE THE FRAGMENT GIVEN, exactly as given, in quotation marks.',
      'Line 3: THE HOOK in one plain sentence: that ad means someone will be doing this by hand, and',
      '        the tracking and chasing half of it is what software is for. Invent nothing about them.',
      'Line 4: One sentence, starting "I built Cadre, which", on credentials on one record per person',
      '        with renewals and reminders that run themselves.',
      'Line 5: The literal token {{ASK}} on its own line. Do NOT write a question of your own.',
    ].join('\n'),
  },
  {
    name: 'pas',
    shape: [
      'Line 1: "Hi {FIRST},"',
      'Line 2: State the problem in their own words: say where you saw it, then QUOTE THE FRAGMENT GIVEN, exactly as given, in quotation marks.',
      'Line 3: ONE line on what it costs to track this by hand: a lapsed ticket found at an audit, or',
      '        a renewal nobody chased. Concrete and understated. No fear-mongering.',
      'Line 4: One sentence, starting "I built Cadre, which", on credentials on one record per person',
      '        with renewals and reminders that run themselves.',
      'Line 5: The literal token {{ASK}} on its own line. Do NOT write a question of your own.',
    ].join('\n'),
  },
  {
    name: 'question',
    shape: [
      'Line 1: "Hi {FIRST},"',
      'Line 2: Say you saw the posting and QUOTE THE FRAGMENT GIVEN, exactly as given, in quotation marks.',
      'Line 3: Ask how they track renewals today, spreadsheet or something else. Genuinely curious, not leading.',
      'Line 4: One short sentence, starting "I built Cadre, which", under twenty words. This',
      '        version is mostly question, not pitch.',
      'Line 5: The literal token {{ASK}} on its own line. Do NOT write a question of your own.',
    ].join('\n'),
  },
  {
    name: 'short',
    shape: [
      'Line 1: "Hi {FIRST},"',
      'Line 2: Say you saw the posting and QUOTE THE FRAGMENT GIVEN, exactly as given, in quotation marks.',
      'Line 3: One sentence, starting "I built Cadre, which", on credentials on one record per person with renewals that run themselves.',
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


/**
 * Trim a scraped signal quote to something a human would actually quote.
 *
 * Quotes arrive truncated at the source: "Tracking certifications and license renewals (e." went
 * out verbatim on 2026-09-01 and reads as broken. Others run to thirty words of JD boilerplate.
 * Cut at the last natural boundary inside 14 words, drop a dangling open bracket, and never end
 * on a fragment.
 */
function cleanQuote(q) {
  let t = String(q || '').replace(/\s+/g, ' ').replace(/[…]+$/, '').trim();
  t = t.replace(/\s*\([^)]*$/, '');              // dangling "(e." style opener
  const words = t.split(' ');
  if (words.length > 14) {
    const head = words.slice(0, 14).join(' ');
    const cut = Math.max(head.lastIndexOf(','), head.lastIndexOf(';'), head.lastIndexOf(' and '), head.lastIndexOf('.'));
    t = cut > 25 ? head.slice(0, cut) : head;
  }
  return t.replace(/[,;:\s]+$/, '').replace(/^[a-z]/, (c) => c.toUpperCase());
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
"${cleanQuote(lead.signal_quote)}"

WHAT WE SELL, and what to LEAD with

Lead with EXACTLY what they said. The quote is a certification or training-records problem, so
the email is about certification and training records. Do not pivot to onboarding, lifecycle,
or anything they did not mention. Rewritten 2026-09-02 after 49 sends and 0 replies: emails that
quoted a licensing problem and then pitched onboarding read as a non sequitur, and the product
page at aevon.ca/cadre says "certification tracking software", so the email must say so too.

THE HOOK, and it is the only argument to make: they published a job ad for someone to keep
these records by hand. That means they are about to pay a salary, in part, for expiry tracking
and renewal chasing. Cadre is the part of that job software does: every credential on one record
per person, renewal dates set on entry, reminders that start themselves at 60, 30 and 7 days,
the manager copied a month out, and an audit-ready list on demand. The person they hire still
does the human parts. The spreadsheet is what goes.

Say it plainly and once. Do not claim it replaces the hire.

The Cadre sentence names ONE concrete thing, under 25 words. Pick the one that fits their quote:
renewals that chase themselves, or an audit-ready list on demand, or every credential on one
record per person. Never all of them. A feature list reads as a brochure and gets deleted.

THE SHAPE, follow it exactly:
${shape}

Each "Line" above is its own PARAGRAPH. Separate them with a BLANK line, i.e. two newline
characters (

) in the JSON string, never one. An email that arrives as a single block does
not get read on a phone, and the validator rejects it.

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
    // Never touch hand-written copy. On 2026-08-25 a background regeneration run replaced every
    // hand-written body with a generated one, and the only reason it was recoverable is that a
    // scratch file happened to survive. `.is('email_subject', null)` below was supposed to
    // prevent that on its own and did not, so the intent is now stated explicitly in a column
    // rather than inferred from whether a field is empty.
    .eq('copy_locked', false)
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
