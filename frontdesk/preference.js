/**
 * frontdesk/preference.js, read "Wednesday morning works better" as a constraint on the slots.
 *
 * The first offer ends "Reply C to take the first, or tell me what works", and in rehearsal
 * (2026-09-08) "Wednesday morning works better for me" was classified as an existing
 * conversation and nothing happened. That is the one reply a real lead is most likely to send.
 *
 * Deliberately small: a weekday or today/tomorrow, a part of the day, or a clock time. Anything
 * it cannot read returns null and the message goes to the owner as it always did. No model call;
 * a wrong guess here books the wrong time, and a null just means a human reads it.
 */
const { partsIn, instantAt } = require('./slots');

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * @returns {{ dayOffset: number|null, hours: {start:string,end:string}|null, at: string|null, label: string } | null}
 *   dayOffset is days from today in the owner's zone; hours narrows the window; at is an exact HH:MM.
 */
function parsePreference(text, now = new Date(), timezone = 'America/Los_Angeles') {
  const t = String(text || '').toLowerCase();
  const today = partsIn(now, timezone);
  let dayOffset = null, hours = null, at = null;
  const label = [];

  // "Sep 12", "sept 12th", "9/12", "the 12th": a calendar date, resolved to the next such day.
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const md = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/) || t.match(/\b(\d{1,2})\/(\d{1,2})\b/) || t.match(/\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/);
  let dateHit = null;
  if (md) {
    let mo, d;
    if (md[0].includes('/')) { mo = parseInt(md[1], 10) - 1; d = parseInt(md[2], 10); }
    else if (/^the/.test(md[0])) { mo = today.mo - 1; d = parseInt(md[1], 10); if (d < today.d) mo += 1; }
    else { mo = MONTHS.indexOf(md[1].slice(0, 3)); d = parseInt(md[2], 10); }
    if (mo >= 0 && d >= 1 && d <= 31) {
      let y = today.y;
      if (mo < today.mo - 1 || (mo === today.mo - 1 && d < today.d)) y += 1;   // already passed this year
      const target = Date.UTC(y, mo, d, 12);
      const base = Date.UTC(today.y, today.mo - 1, today.d, 12);
      dateHit = Math.round((target - base) / 86400000);
    }
  }
  if (dateHit !== null && dateHit >= 0 && dateHit <= 60) { dayOffset = dateHit; label.push(new Date(Date.UTC(today.y, today.mo - 1, today.d + dateHit, 12)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })); }
  else if (/\btomorrow\b/.test(t)) { dayOffset = 1; label.push('tomorrow'); }
  else if (/\btoday\b/.test(t)) { dayOffset = 0; label.push('today'); }
  else {
    for (let i = 0; i < 7; i++) {
      const name = DAYS[i];
      if (new RegExp(`\\b${name.slice(0, 3)}(${name.slice(3)})?\\b`).test(t)) {
        dayOffset = (i - today.weekday + 7) % 7;
        if (dayOffset === 0 && !/\bthis\b/.test(t)) dayOffset = 7;   // "Wednesday" on a Wednesday means next week
        label.push(name[0].toUpperCase() + name.slice(1));
        break;
      }
    }
  }

  const clock = t.match(/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm|a\.m\.|p\.m\.)\b/) || t.match(/\bat\s+(1[0-2]|0?[1-9])(?::([0-5]\d))?\b/);
  if (clock) {
    let h = parseInt(clock[1], 10);
    const m = clock[2] || '00';
    const ap = (clock[3] || '').replace(/\./g, '');
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (!ap && h < 8) h += 12;                       // "at 3" from a broker's lead means 3pm
    at = `${String(h).padStart(2, '0')}:${m}`;
    label.push(`${((h + 11) % 12) + 1}:${m} ${h >= 12 ? 'PM' : 'AM'}`);
  } else if (/\bmorning\b/.test(t)) { hours = { start: '09:00', end: '12:00' }; label.push('morning'); }
  else if (/\b(afternoon|after lunch)\b/.test(t)) { hours = { start: '12:00', end: '17:00' }; label.push('afternoon'); }
  else if (/\b(evening|after work|after 5)\b/.test(t)) { hours = { start: '17:00', end: '20:00' }; label.push('evening'); }

  if (dayOffset === null && !hours && !at) return null;
  return { dayOffset, hours, at, label: label.join(' ') };
}

/**
 * Rules narrowed to the preference. Returns a copy of `rules` and, if a day was named, the
 * calendar date it means, so the caller can keep only that day's slots.
 */
function narrowRules(rules, pref, now = new Date()) {
  const tz = rules.timezone;
  const out = { ...rules, hours: { ...rules.hours } };
  if (pref.hours) {
    // Intersect with business hours rather than replace them: "evening" still ends at close.
    out.hours.start = pref.hours.start > rules.hours.start ? pref.hours.start : rules.hours.start;
    out.hours.end = pref.hours.end < rules.hours.end ? pref.hours.end : rules.hours.end;
  }
  if (pref.at) {
    const [h, m] = pref.at.split(':').map(Number);
    const end = new Date(Date.UTC(2000, 0, 1, h, m) + rules.slotMin * 60000);
    out.hours = { start: pref.at, end: `${String(end.getUTCHours()).padStart(2, '0')}:${String(end.getUTCMinutes()).padStart(2, '0')}` };
  }
  let day = null;
  if (pref.dayOffset !== null) {
    const today = partsIn(now, tz);
    const base = new Date(Date.UTC(today.y, today.mo - 1, today.d + pref.dayOffset, 12));
    const p = partsIn(base, tz);
    day = { y: p.y, mo: p.mo, d: p.d };
    out.days = [p.weekday];
    out.horizonDays = Math.max(rules.horizonDays || 10, pref.dayOffset + 1);
  }
  return { rules: out, day };
}

function onDay(date, day, tz) {
  if (!day) return true;
  const p = partsIn(date, tz);
  return p.y === day.y && p.mo === day.mo && p.d === day.d;
}

module.exports = { parsePreference, narrowRules, onDay, instantAt };
