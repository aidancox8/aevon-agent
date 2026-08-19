/**
 * lib/offer.js  —  the current offer, in one place.
 *
 * Why this exists: the offer used to be written into every email at generation time, so
 * changing it meant regenerating thousands of pre-written emails. In practice that did not
 * happen. The prompt was updated to offer a free build and days later 372 of 400 queued
 * emails were still asking people to watch a 90-second demo, and ~3,000 still quoted a
 * $1,500 setup fee that no longer applied. The copy in the database silently outlived the
 * decision.
 *
 * Now the personalizer writes only the part that is genuinely per-lead (the opening that
 * reads their business) and ends with an {{ASK}} token. The sender substitutes the current
 * ask at send time. Changing the offer is an edit to this file: it applies to every unsent
 * email immediately, including the thousands already generated, with no backfill and no API
 * calls.
 *
 * Adding a variant here is safe. Removing one is safe. Changing the wording is safe.
 */

/** Rotate deterministically by lead id so a batch does not read as one mail merge, and the
 *  same lead always gets the same phrasing if a run is repeated. */
function pick(list, seed) {
  let h = 0;
  for (const ch of String(seed || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return list[h % list.length];
}

// ── AEVON ───────────────────────────────────────────────────────────
// Offer: none. The ask is a question, and the question is the whole ask.
//
// This replaced "name one manual job and I'll build a working version of it, free" on
// 2026-08-19, for the same reasons the free build was dropped on the Tempo side
// (sales/tempo-diagnostic-offer.md). Hormozi: "If you struggle to give your stuff away for
// free... your 'free' stuff is too expensive." A free custom build is not free to accept. It
// costs the owner an explanation of how their process works, access to their data, staff time
// to test it, and the risk of depending on one unknown person. Offered cold by a stranger it
// also has to survive the obvious question of why it is free, and the honest answer, that
// there is no track record yet, is the part that does the damage.
//
// Enns: a first step should be "a first step and not a sample twenty-fifth step". Building a
// working version of a process means first understanding the process, which is the actual
// work, done without their involvement and without being paid for it.
//
// What replaces it is not a cheaper offer, it is no offer. A cold first email cannot sell a
// paid diagnostic either, and should not try. The paid version of this belongs on a call
// (sales/clinic-assessment.md). The email asks a question a busy person can answer from their
// phone in one line, including "no", and takes no as a real answer. There is nothing to
// accept, so there is nothing to weigh up, and a reply commits them to nothing.
const AEVON_ASKS = [
  "Is that actually costing you anything, or is it just how it works and nobody minds?",
  "Is that a real annoyance over there, or have you got it handled already? Either answer is useful.",
  "Roughly how much of a week does that eat? Genuinely asking, I might have the wrong end of it.",
  "Worth solving, or one of those things it's easier to just live with?",
  "Curious whether that's a real problem for you or whether I've guessed wrong. Happy to hear it's the second one.",
];

// Follow-ups. Shorter, and they must not repeat the first email's wording verbatim.
const AEVON_FOLLOWUP_ASKS = [
  "Still curious about the answer if you have one. If it's a no, that's a fine answer too.",
  "If I've guessed wrong about that, say so and I'll leave it there. If not, what does it actually cost you in a week?",
  "One line is plenty, and no is a complete answer. Is that a real problem there or not?",
];

// ── TEMPO ────────────────────────────────────────────────────────────────────
// Offer: two weeks running it, set up around their clinic. Call it a pilot, never a trial:
// a trial implies self-serve signup for generic software, which is the opposite of the point.
const TEMPO_ASKS = [
  "I'll set Tempo up around your clinic and you can run it free for two weeks. Who builds your schedule now, and how long does it take them?",
  "Want me to set it up for your rooms and disciplines? Two weeks free, and nothing to cancel if you walk away.",
  "I'm setting up the first few clinics myself to get it right. Two weeks free, built around your week. Worth a look at yours?",
  "Say the word and I'll build your first week around your actual rooms and staff. Free for two weeks.",
];

const TEMPO_FOLLOWUP_ASKS = [
  "Offer's still open: two weeks free, set up around your clinic, nothing to cancel.",
  "If it's worth a look I'll build your first week around your real rooms and staff, free.",
  "Still happy to set it up around your clinic for a couple of weeks if you want to see it on your own schedule.",
];

/**
 * The ask for a given campaign and sequence step.
 * @param {'aevon'|'tempo'} campaign
 * @param {number} step  0 = first email, 1+ = follow-up
 * @param {string} seed  lead id, so phrasing varies across a batch but is stable per lead
 */
function askFor(campaign, step, seed) {
  const tempo = campaign === 'tempo';
  const list = step > 0
    ? (tempo ? TEMPO_FOLLOWUP_ASKS : AEVON_FOLLOWUP_ASKS)
    : (tempo ? TEMPO_ASKS : AEVON_ASKS);
  return pick(list, seed);
}

/**
 * Substitute {{ASK}} in a body.
 *
 * If the token is absent the ask is NOT appended, with one narrow exception below. Appending
 * was the original behaviour, on the reasoning that a cold email with no ask is worse than one
 * with an awkward join. That reasoning was wrong, and it was shipping badly broken mail:
 *
 *   - Zero of 5,470 queued third emails carried the token, and every one of them is a breakup
 *     note that ends "Either way, all the best." Appending stapled a fresh pitch on after the
 *     sign-off. That does not read as a slightly awkward join, it reads as broken automation.
 *   - Zero of 5,666 second emails carried it either, and 2,180 of those already ended in a
 *     question, so they went out asking two different things at once.
 *
 * Copy that already ends in a question has an ask. The failure the appending guarded against
 * is a body that just stops, so that is the only case where one is still added, and only on
 * the first email, where there is no earlier ask in the thread to fall back on.
 */
function applyAsk(body, campaign, step, seed) {
  if (!body) return body;
  const ask = askFor(campaign, step, seed);
  if (body.includes('{{ASK}}')) return body.replace(/\{\{ASK\}\}/g, ask);

  const trimmed = body.trim();
  if (step > 0) return trimmed;          // never staple an ask onto a follow-up
  if (/\?["')\]]?$/.test(trimmed)) return trimmed;  // already ends in a question
  return `${trimmed} ${ask}`;
}

module.exports = { askFor, applyAsk, AEVON_ASKS, TEMPO_ASKS };
