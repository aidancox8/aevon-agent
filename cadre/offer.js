/**
 * cadre/offer.js — the current Cadre ask, in one place.
 *
 * Same reasoning as lib/offer.js on the Aevon side: stored copy outlives decisions. The Aevon
 * offer changed and days later 372 of 400 queued emails were still pitching the old one, because
 * nothing rewrites thousands of emails on a whim. Copy ends with an {{ASK}} token and the sender
 * substitutes whatever this file says at send time, so changing the offer is an edit here.
 *
 * WHY A FREE TRIAL IS DEFENSIBLE HERE WHEN THE FREE BUILD WAS NOT
 *
 * The Aevon free build was retired on 2026-08-19 for good reasons (sales/aevon-no-offer.md):
 * Hormozi's "if you struggle to give it away, your free stuff is too expensive", and Enns's
 * point that a first step should not be a sample twenty-fifth step. Both objections were about
 * the COST OF ACCEPTING, not the price. A free custom build meant explaining your process,
 * handing over data, staff testing time, and depending on one unknown person.
 *
 * A trial of software that already exists and already runs daily is a different object. There is
 * nothing to design, nothing to scope, and the thing being offered is the thing being sold.
 *
 * THE HONEST CONSTRAINT, WHICH THE COPY MUST RESPECT
 *
 * There is no multi-tenancy (cadre/features.md). "Free trial" implies self-serve signup, and
 * that does not exist. Every trial is a manual setup. So the ask is deliberately worded as
 * something Aidan does FOR them on their own data, which is true, rather than a signup link,
 * which is not. It also caps naturally: a handful of manual pilots is fine, fifty is not.
 */

/** Rotate deterministically by lead id, so a batch does not read as one mail merge. */
function pick(list, seed) {
  let h = 0;
  for (const ch of String(seed || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return list[h % list.length];
}

/**
 * Closing asks. Every one is answerable with a no, and none of them asks for a meeting, because
 * a low-commitment ask out-replies a calendar request (Gong). Two mention the pilot and two do
 * not: an offer in every single email reads as a campaign, and the question-only versions
 * consistently out-perform in the research.
 */
const ASKS = [
  "Is that a real annoyance there, or is it handled?",
  "Worth solving, or one of those things it is easier to live with?",
  "How much of a week does that actually take?",
  "If it is worth a look I will set it up on your own roster and you can run it for a couple of weeks. Worth seeing?",
  "Happy to load your own people and tickets into it so you can run it for two weeks before deciding anything. Want me to?",
  "Is that worth solving at your end, or already sorted?",
];

/** Follow-ups, shorter, and they must not repeat the first email's wording. */
const FOLLOWUP_ASKS = [
  "Still curious about the answer if you have one. A no is a fine answer.",
  "If I have guessed wrong just say so and I will leave it there.",
  "Offer stands if it is useful: two weeks on your own roster, set up by me, nothing to cancel.",
];

function askFor(step, seed) {
  return pick(step > 0 ? FOLLOWUP_ASKS : ASKS, seed);
}

/**
 * Substitute {{ASK}}. If the token is missing the copy predates this system, so the ask is
 * appended rather than dropped, UNLESS the body already ends in a question, in which case
 * appending a second one is worse than leaving it alone. That mistake shipped on the Aevon side:
 * every third email had a fresh pitch stapled on after "Either way, all the best."
 */
function applyAsk(body, step, seed) {
  if (!body) return body;
  const ask = askFor(step, seed);
  if (body.includes('{{ASK}}')) return body.replace(/\{\{ASK\}\}/g, ask);
  const trimmed = body.trim();
  if (/\?["')\]]?$/.test(trimmed)) return trimmed;
  return `${trimmed}\n\n${ask}`;
}

module.exports = { askFor, applyAsk, ASKS, FOLLOWUP_ASKS };
