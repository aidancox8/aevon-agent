/**
 * lib/send-gate.js — the deterministic gate on anything Claude sends from Gmail.
 *
 * Aidan enabled Gmail send with: "use it carefully. i cant always approve it, but for the first
 * few times ill have to." This is what makes unattended sending safe. Every check here is a
 * rule, not a judgement, because the failure modes this prevents were all judgement failures:
 *
 *   - A draft opened "I have been speaking with Randy" off the back of an out-of-office. There
 *     had been one unanswered cold email. That is a lie in writing to a stranger.
 *   - Changepain, Aidan's employer, sat queued in tempo_leads one send from being pitched.
 *   - Nine warm follow-ups went out through a one-off script and left no record, so a bounce
 *     from any of them would have been invisible to the digest and the bounce breaker.
 *
 * The gate is deliberately narrow. It permits exactly one thing: replying inside a thread a
 * human started. Anything else fails and goes to Drafts, which is the current behaviour, so the
 * worst case degrades to today rather than to a bad email.
 */

const { excludedOrgReason } = require('../tempo/dnc');

// Required lazily. reply-processor requires this module to warn on its own drafts, so a
// top-level require here would be circular and would resolve to an empty object at load time,
// leaving the two most important checks silently undefined.
const inbound = () => require('../reply-processor');

/** Never auto-reply to these, regardless of what they wrote. Handled personally. */
const HANDLED_PERSONALLY = [
  'jean@vancouvercommercialbrokers.ca',
  'info@restaurantbusinessbroker.ca',
  'sales@restaurantbusinessbroker.ca',
];

/**
 * Claims that must never appear in an unattended send.
 *
 * Two categories. Fabricated history, because we have almost none and inventing it is the worst
 * thing an assistant can do on someone's behalf. And commercial commitments, because pricing and
 * scope are Aidan's to set and a number in writing is hard to walk back.
 */
const FORBIDDEN = [
  { re: /\b(as (we )?discussed|per our (call|conversation|chat)|following up on our|since we (spoke|talked)|great (speaking|talking) (with|to) you|thanks for your time (last|on|yesterday))\b/i,
    why: 'claims a prior conversation' },
  { re: /\bI(&#39;| ?)?(ve| have) been (speaking|talking|working) with\b/i,
    why: 'claims a relationship' },
  { re: /\b(our (other )?clients?|clients like|we work with|customers like|another clinic we)\b/i,
    why: 'implies a client base that does not exist' },
  { re: /\$\s?\d|\bCA\$|\b\d+\s?(dollars|per month|\/mo|per user)\b/i,
    why: 'quotes a price' },
  { re: /\b(I(&#39;| ?)?ll have it (by|to you)|guarantee|I promise|by (monday|tuesday|wednesday|thursday|friday|next week)\b)/i,
    why: 'makes a delivery commitment' },
  { re: /\b(contract|invoice|terms|sign(ed)? (the|an) agreement|retainer)\b/i,
    why: 'touches contractual language' },
];

/** Topics that need a human, not a fast reply. */
const ESCALATE = [
  { re: /\b(lawyer|legal|solicitor|counsel|lawsuit|liability|breach|privacy (act|complaint)|PIPA|PIPEDA|CASL)\b/i,
    why: 'raises a legal matter' },
  { re: /\b(changepain|change pain|artus)\b/i, why: 'mentions the employer or an excluded clinic' },
  { re: /\b(complain|unacceptable|report you|spam(med)?|stop emailing|harass)\b/i, why: 'is a complaint' },
];

const DAILY_CAP = 3;

/**
 * Decide whether an unattended reply may be sent.
 *
 * @param {object} m
 * @param {string} m.toEmail        recipient
 * @param {string} m.businessName   lead's business name, for the org exclusion
 * @param {string} m.inboundSubject subject of the message being replied to
 * @param {string} m.inboundBody    body of the message being replied to
 * @param {string} m.replyBody      what we intend to send
 * @param {string} m.inboundMessageId Gmail message id we are replying to
 * @param {number} m.sentToday      replies already sent unattended today
 * @returns {{allowed: boolean, reason: string}}
 */
function canSendReply(m = {}) {
  const no = reason => ({ allowed: false, reason });

  // 1. Reply only. Never initiate. Without a message to reply to this is cold outreach,
  //    which is the sender pipeline's job and is never Claude's to start.
  if (!m.inboundMessageId) return no('not a reply to an existing message');
  if (!m.replyBody || !m.replyBody.trim()) return no('empty reply body');

  // 2. A human has to have written to us. This is the Randy guard: an out-of-office is not a
  //    conversation, and treating one as though it were is how the fabrication happened.
  const auto = inbound().autoresponderReason(m.inboundSubject, m.inboundBody);
  if (auto) return no(`inbound is an autoresponder (${auto})`);

  // 3. Someone asking to be left alone gets left alone, not answered.
  const optOut = inbound().optOutReason(m.inboundBody);
  if (optOut) return no(`inbound is an opt-out (${optOut})`);

  // 4. Never the employer or the excluded clinic, by name or by domain.
  const org = excludedOrgReason(m.businessName, m.toEmail);
  if (org) return no(org);

  // 5. Named people Aidan handles himself.
  if (HANDLED_PERSONALLY.includes(String(m.toEmail || '').toLowerCase().trim())) {
    return no('recipient is handled personally');
  }

  // 6. Escalate rather than answer.
  for (const e of ESCALATE) {
    if (e.re.test(m.inboundBody || '') || e.re.test(m.inboundSubject || '')) {
      return no(`needs a human: inbound ${e.why}`);
    }
  }

  // 7. Nothing we would not want in writing.
  for (const f of FORBIDDEN) {
    if (f.re.test(m.replyBody)) return no(`draft ${f.why}`);
  }

  // 8. Volume. Three a day is above the observed reply rate, so this should never bind in
  //    normal operation; it binds when something has gone wrong.
  if ((m.sentToday || 0) >= DAILY_CAP) return no(`daily cap reached (${DAILY_CAP})`);

  return { allowed: true, reason: 'reply to a human, no forbidden claims' };
}

module.exports = { canSendReply, DAILY_CAP, FORBIDDEN, ESCALATE, HANDLED_PERSONALLY };
