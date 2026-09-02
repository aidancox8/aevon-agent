/**
 * lib/copy-guard.js — refuse to send copy that contradicts the current offer.
 *
 * Stored copy outlives decisions. This has now happened three times: the $1,500 setup fee
 * survived its retirement by more than two weeks and 895 emails, the 90-second demo pitch
 * survived the move to a free build, and the free build itself was argued in 2,308 queued
 * bodies the day it was dropped. Each time the fix was a one-off script, and each time the
 * next offer change reintroduced the same class of bug.
 *
 * A stripper cleans the queue once. This runs on every single send, so the worst case for the
 * next offer change is that some mail is held back rather than that it goes out contradicting
 * itself. Held mail is visible: the sender logs the reason and leaves the lead queued, so
 * regen-copy rewrites it on its normal schedule and it sends the following day.
 *
 * Add a pattern here whenever an offer is retired. Removing one is how you un-retire it.
 */

/**
 * A bare /\bfree\b/ was the first version of this and it was wrong. It held the two
 * best-personalized emails in the queue: one quoting a plumber's own "Request a FREE ESTIMATE"
 * button, and one naming a vet clinic's Fear Free certification. Those are exactly the details
 * that make a cold email worth reading, and the word there belongs to the recipient, not us.
 *
 * So match the promise, not the word: a free token only counts when the same sentence also has
 * someone in the first person doing the building. "Free up your time" is not a promise of free
 * work either, so it is excluded.
 */
const FREE_TOKEN = /\bfree\b(?!\s+up\b)|no charge|at no cost/i;
const FIRST_PERSON_BUILD =
  /\b(?:I|I'd|I’d|I'll|I’ll|I'm|I’m|we|we'd|we'll|we're)\b[^.!?]{0,120}?\b(?:build|built|building|handle|handling|set up|setup|make|run|version|tool|skeleton)\b/i;
const YOURS_ANYWAY = /\byours (?:to keep )?(?:either way|whether we work together)/i;

/** Split into sentences so a match in one cannot be excused by context in another. */
function sentences(text) {
  return String(text || '').match(/[^.!?\n]+[.!?]*/g) || [];
}

const RETIRED = [
  {
    why: 'quotes the retired $1,500 setup fee',
    test: text => /\$\s?1,?500|\$\s?150\b|150\s*\/\s*mo|\bflat setup\b/i.test(text),
  },
  {
    why: 'promises the retired free build',
    test: text =>
      YOURS_ANYWAY.test(text) ||
      sentences(text).some(s => FREE_TOKEN.test(s) && FIRST_PERSON_BUILD.test(s)),
  },
  {
    // Not a retired offer, a false claim. Established 2026-09-01 while scoping a real build:
    // only the inbox half exists, and SMS is gated behind 10 to 15 days of carrier
    // registration that no amount of work shortens. Three to four weeks is the honest number.
    // 398 queued emails still said a week.
    why: 'promises delivery in a week, which is not true',
    test: text => /\blive\s+in\s+a\s+week\b|\bup\s+and\s+running\s+in\s+a\s+week\b|\bwithin\s+a\s+week\b/i.test(text),
  },
  {
    // The personalizer's prompt shows an example containing {{how their business works}} as a
    // stand-in. The model occasionally copies it out verbatim instead of writing the phrase.
    // Nothing substitutes it, so it ships as a visible placeholder. Catch any {{...}} that is
    // not one of the two real tokens rather than listing artefacts one at a time.
    why: 'carries an unsubstituted template placeholder',
    test: text => /\{\{(?!ASK\}\}|DEMO\}\})[^}]*\}\}/.test(text),
  },
];

/**
 * @param {string} body  the fully rendered body, after {{ASK}} and {{DEMO}} substitution
 * @returns {string|null} reason to hold, or null to send
 */
function retiredOfferReason(body) {
  const text = String(body || '');
  for (const r of RETIRED) if (r.test(text)) return r.why;
  return null;
}

// Aevon only. Tempo's offer IS a free two-week pilot and is current, so wiring this into
// tempo/sender.js would hold every Tempo email ever sent.
module.exports = { retiredOfferReason, RETIRED };
