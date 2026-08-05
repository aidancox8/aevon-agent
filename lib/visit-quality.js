/**
 * lib/visit-quality.js  —  tell a real visitor from an email security scanner.
 *
 * Corporate mail filters (Defender, Mimecast, Proofpoint and friends) fetch every link in an
 * inbound email to check it before the recipient ever sees the message. Those fetches hit the
 * tracking endpoint and look exactly like a visit. Measured across 174 recorded visits, 82 of
 * them landed within five minutes of the send, which is the classic signature.
 *
 * Counting all of them as interest roughly doubles the apparent engagement rate and, worse,
 * puts businesses on a warm list who never actually looked at anything.
 *
 * No single signal is reliable on its own, so this looks for evidence a machine cannot easily
 * fake: a visit from a phone, a visit long after the email arrived, or visits on more than
 * one day. A scanner fires once, immediately, from a datacentre, and never comes back.
 */

const MOBILE = /iPhone|Android|Mobile|iPad/i;
const OBVIOUS_BOT = /HeadlessChrome|bot\b|crawler|spider|Python|curl|Go-http|axios|Java\/|Scan|Proofpoint|Mimecast|Barracuda/i;

/** Minutes after the send beyond which a visit is unlikely to be a pre-delivery scan. */
const HUMAN_DELAY_MIN = 60;

/**
 * Classify one lead's visits.
 * @param {{created_at: string, metadata?: object}[]} visits  all visit events for this lead
 * @param {string} firstSentAt  ISO timestamp of the first email sent to them
 * @returns {{human: boolean, reasons: string[], count: number}}
 */
function classifyVisits(visits, firstSentAt) {
  const list = Array.isArray(visits) ? visits : [];
  if (!list.length) return { human: false, reasons: [], count: 0 };

  const reasons = [];
  const uas = list.map(v => (v.metadata || {}).ua || '');

  if (uas.some(u => OBVIOUS_BOT.test(u))) {
    return { human: false, reasons: ['declared bot user agent'], count: list.length };
  }
  // A scanner does not run on someone's phone.
  if (uas.some(u => MOBILE.test(u))) reasons.push('visited from a phone');

  if (firstSentAt) {
    const late = list.some(v => (new Date(v.created_at) - new Date(firstSentAt)) / 60000 > HUMAN_DELAY_MIN);
    if (late) reasons.push('visited well after delivery');
  }
  // Coming back on a different day is the strongest signal available: a pre-delivery scan
  // happens once and never repeats.
  const days = new Set(list.map(v => String(v.created_at).slice(0, 10)));
  if (days.size > 1) reasons.push(`visited on ${days.size} separate days`);

  return { human: reasons.length > 0, reasons, count: list.length };
}

/** Rough interest ranking, so the strongest few can be picked out of a long list. */
function visitScore(cls) {
  if (!cls.human) return 0;
  return cls.reasons.length * 10 + Math.min(cls.count, 10);
}

module.exports = { classifyVisits, visitScore, HUMAN_DELAY_MIN };
