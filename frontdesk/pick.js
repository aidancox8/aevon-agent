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

// An ordinal counts only when it stands for a slot: "the first", "first one", "1st", "morning one",
// alone or as the point of the sentence. "VA loan, first time" booked slot 1 in the battery
// (2026-09-09); that is not a pick. So: not followed by a noun that is not one/slot/option/time.
const NOT_A_SLOT = /\b(first|second|1st|2nd)[- ]?(time|timer|home|house|choice|thing|floor|responder|name|of all|week|month|year|day|call|step|off)\b/i;
const ORDINALS = [
  // "morning" and "afternoon" alone are a preference ("Wednesday morning works"), not a pick;
  // they count only as "the morning one" / "morning one".
  [/\b(the )?(first|1st|earlier|earliest)( one| slot| option| time)?\b|\b(the )?(morning|early) (one|slot|option)\b/i, 0],
  [/\b(the )?(second|2nd|later|latest|other)( one| slot| option| time)?\b|\b(the )?(afternoon|late) (one|slot|option)\b/i, 1],
  [/\b(the )?(third|3rd)( one| slot| option)?\b/i, 2],
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
  // Plain agreement takes the first: "yes", "yes that works", "ok sure", "sounds good". After "would
  // either of those work?" people mean the first unless they name the other.
  if (/^\s*(c|yes|yes please|yep|yeah|ya|y|confirm|ok|okay|ok sure|okay sure|sure|sounds good|that works|works|perfect|great|1|one|the first)(\s*(,|that|this|it)?\s*(works|is (fine|good|great|perfect)|sounds good|please|pls|thanks|thank you))?\s*[.!]*\s*$/i.test(t)) return 0;
  if (/^\s*(2|two|the second)\s*[.!]?\s*$/i.test(t) && slots.length > 1) return 1;
  if (!NOT_A_SLOT.test(t)) for (const [re, i] of ORDINALS) if (re.test(t) && i < slots.length) return i;
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
