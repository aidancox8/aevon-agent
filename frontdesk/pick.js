/**
 * frontdesk/pick.js, which of the offered slots did the lead just pick?
 *
 * The offer ends "Reply C to take the first, or tell me what works." Real replies (rehearsal
 * 2026-09-09) include "Sep 10 115 works", "the second one", "1:15", "the later one", "first",
 * "9:30 works". None of those is C, and one of them ("115") is not a time any parser reads. So
 * this matches the reply against the slots actually offered, by ordinal, by clock time with or
 * without the colon, by am/pm, or by "later/earlier". Returns the slot index or null.
 */
const { partsIn } = require('./slots');

const ORDINALS = [
  [/\b(first|1st|the earlier|earlier one|the early|morning one)\b/i, 0],
  [/\b(second|2nd|the later|later one|the late|afternoon one|other one)\b/i, 1],
  [/\b(third|3rd)\b/i, 2],
];

/** "115", "1:15", "1.15", "915", "9:30", "1315". Returns [h, m] in 24h or null. */
function clockIn(text) {
  const t = String(text).toLowerCase();
  let m = t.match(/\b(1[0-2]|0?[1-9])[:.]([0-5]\d)\s*(am|pm)?\b/) || t.match(/\b(1[0-2]|0?[1-9])([0-5]\d)\s*(am|pm)?\b/) || t.match(/\b(1[0-2]|0?[1-9])\s*(am|pm)\b/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] && /^\d\d$/.test(m[2]) ? parseInt(m[2], 10) : 0;
  const ap = (m[3] || (m[2] && !/^\d/.test(m[2]) ? m[2] : '') || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return { h, min, ap: ap || null };
}

/**
 * @param text   the lead's reply
 * @param slots  ISO instants that were offered, in order
 * @param tz     the client's zone
 */
function pickSlot(text, slots, tz) {
  if (!slots || !slots.length) return null;
  const t = String(text || '').trim();
  if (/^\s*(c|yes|y|confirm|ok|okay|sure|sounds good|that works|works|1|one|the first)\s*[.!]?\s*$/i.test(t)) return 0;
  if (/^\s*(2|two|the second)\s*[.!]?\s*$/i.test(t) && slots.length > 1) return 1;
  for (const [re, i] of ORDINALS) if (re.test(t) && i < slots.length) return i;
  const c = clockIn(t);
  if (c) {
    const idx = slots.findIndex((iso) => {
      const p = partsIn(new Date(iso), tz);
      if (p.mi !== c.min) return false;
      if (c.ap) return p.h === c.h;
      return p.h === c.h || p.h === c.h + 12;   // "1:15" for a 13:15 slot
    });
    if (idx > -1) return idx;
  }
  return null;
}

module.exports = { pickSlot, clockIn };
