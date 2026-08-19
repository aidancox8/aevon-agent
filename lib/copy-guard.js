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

const RETIRED = [
  { re: /\$\s?1,?500|\$\s?150\b|150\s*\/\s*mo|flat setup/i,
    why: 'quotes the retired $1,500 setup fee' },
  { re: /\bfree\b|no charge|at no cost|yours (?:to keep )?either way/i,
    why: 'promises the retired free build' },
];

/**
 * @param {string} body  the fully rendered body, after {{ASK}} and {{DEMO}} substitution
 * @returns {string|null} reason to hold, or null to send
 */
function retiredOfferReason(body) {
  const text = String(body || '');
  for (const r of RETIRED) if (r.re.test(text)) return r.why;
  return null;
}

module.exports = { retiredOfferReason, RETIRED };
