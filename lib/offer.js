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

// ── AEVON ────────────────────────────────────────────────────────────────────
// Offer: name one manual job, it gets built free, theirs either way.
// Never mention price. The whole point is that there is nothing to decide yet.
const AEVON_ASKS = [
  "If you tell me the one job your team does by hand, I'll build a working version of it for you, free. Which one would you pick?",
  "Name the one manual job you'd hand over tomorrow and I'll build it for you, free, yours either way.",
  "I'll build one of these for you free while I'm early and taking on a few. What's the job that eats the most time?",
  "Tell me the one thing your team still does by hand and I'll build it, free. It's yours whether we work together or not.",
  "What's the one manual job you'd get rid of first? I'll build a working version of it for you, no charge.",
];

// Follow-ups. Shorter, and they must not repeat the first email's wording verbatim.
const AEVON_FOLLOWUP_ASKS = [
  "Still happy to build one for you free if there's a job worth handing over. What would it be?",
  "The offer stands if you want it: name one manual job and I'll build it, free.",
  "If nothing comes to mind that's fine. If something does, I'll build it for you at no cost.",
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
 * Substitute {{ASK}} in a body. If the token is missing the email predates this system, so
 * the ask is appended rather than dropped: a cold email with no ask is worse than one with a
 * slightly awkward join.
 */
function applyAsk(body, campaign, step, seed) {
  const ask = askFor(campaign, step, seed);
  if (!body) return body;
  if (body.includes('{{ASK}}')) return body.replace(/\{\{ASK\}\}/g, ask);
  return `${body.trim()} ${ask}`;
}

module.exports = { askFor, applyAsk, AEVON_ASKS, TEMPO_ASKS };
