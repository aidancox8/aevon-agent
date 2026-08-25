/**
 * cadre/timezone.js — work out what time it is where the recipient is.
 *
 * WHY THIS EXISTS. The first scheduler put every send at 09:40 Pacific because that is where
 * the sender sits. For a lead in Ontario that lands at 12:40, in Nova Scotia at 13:40, and in
 * the UK at 17:40, which is the worst hour of their day. Roughly half the list was scheduled to
 * arrive at a time nobody opens email.
 *
 * The research is not ambiguous about this:
 *   - Tuesday, Wednesday and Thursday reply 30-45% higher than Monday or Friday.
 *   - Weekends drop to 1.6% against 4.1% on weekdays.
 *   - 9:00-11:00 in the RECIPIENT'S local time is the window across every large dataset.
 *   - 75% of cold emails are opened within the first hour, so arriving at the wrong local hour
 *     is not merely suboptimal, it wastes the send.
 *
 * IANA zone names are used rather than fixed offsets, so daylight saving is handled by the
 * platform instead of by arithmetic that goes wrong twice a year. Saskatchewan is the one to
 * watch: it does not observe DST, so it drifts relative to Alberta for half the year.
 */

/** Province and state to IANA zone. */
const ZONES = {
  // Canada
  BC: 'America/Vancouver', YT: 'America/Whitehorse',
  AB: 'America/Edmonton', NT: 'America/Yellowknife',
  SK: 'America/Regina',            // no DST, drifts from Alberta half the year
  MB: 'America/Winnipeg', NU: 'America/Iqaluit',
  ON: 'America/Toronto', QC: 'America/Toronto',
  NB: 'America/Halifax', NS: 'America/Halifax', PE: 'America/Halifax',
  NL: 'America/St_Johns',          // UTC-2:30, the half-hour offset
  // US
  WA: 'America/Los_Angeles', OR: 'America/Los_Angeles', CA: 'America/Los_Angeles',
  NV: 'America/Los_Angeles', ID: 'America/Boise', MT: 'America/Denver',
  UT: 'America/Denver', CO: 'America/Denver', AZ: 'America/Phoenix',  // AZ has no DST
  NM: 'America/Denver', WY: 'America/Denver',
  TX: 'America/Chicago', OK: 'America/Chicago', KS: 'America/Chicago',
  MO: 'America/Chicago', IA: 'America/Chicago', MN: 'America/Chicago',
  WI: 'America/Chicago', IL: 'America/Chicago', LA: 'America/Chicago',
  AR: 'America/Chicago', MS: 'America/Chicago', AL: 'America/Chicago',
  TN: 'America/Chicago', NE: 'America/Chicago', SD: 'America/Chicago', ND: 'America/Chicago',
  OH: 'America/New_York', MI: 'America/New_York', IN: 'America/New_York',
  KY: 'America/New_York', GA: 'America/New_York', FL: 'America/New_York',
  NC: 'America/New_York', SC: 'America/New_York', VA: 'America/New_York',
  WV: 'America/New_York', PA: 'America/New_York', NY: 'America/New_York',
  NJ: 'America/New_York', CT: 'America/New_York', MA: 'America/New_York',
  RI: 'America/New_York', VT: 'America/New_York', NH: 'America/New_York',
  ME: 'America/New_York', MD: 'America/New_York', DE: 'America/New_York',
};

/** Cities and regions that carry their own country, for leads with no province code. */
const PLACE_ZONES = [
  [/\b(london|manchester|birmingham|leeds|bristol|liverpool|sheffield|glasgow|edinburgh|cardiff|belfast|england|scotland|wales|united kingdom|\buk\b)\b/i, 'Europe/London'],
  [/\b(dublin|cork|galway|limerick|ireland)\b/i, 'Europe/Dublin'],
  [/\b(sydney|melbourne|brisbane|perth|adelaide|new south wales|victoria|queensland|australia)\b/i, 'Australia/Sydney'],
  [/\b(auckland|wellington|new zealand)\b/i, 'Pacific/Auckland'],
];

/** Best guess at the recipient's zone. Defaults to Toronto, where most of North America lives. */
function zoneFor(city, notes) {
  const text = `${city || ''} ${notes || ''}`;
  const code = String(city || '').match(/\b([A-Z]{2})\b/g);
  if (code) {
    for (const c of code) if (ZONES[c]) return ZONES[c];
  }
  for (const [re, zone] of PLACE_ZONES) if (re.test(text)) return zone;
  return 'America/Toronto';
}

/** What is the local wall-clock offset, in minutes, for this zone at this instant? */
function offsetMinutes(zone, at) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(at).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour === '24' ? 0 : p.hour, p.minute, p.second);
  return (asUTC - at.getTime()) / 60000;
}

/**
 * Holidays worth avoiding. Not exhaustive, deliberately: the cost of missing one is a send that
 * lands on a quiet day, and the cost of an over-long list is complexity nobody maintains.
 */
const HOLIDAYS = new Set([
  '2026-09-07', // Labour Day, CA and US
  '2026-08-31', // UK summer bank holiday
  '2026-10-12', // Thanksgiving CA, Columbus Day US
  '2026-11-11', // Remembrance Day CA, Veterans Day US
  '2026-11-26', '2026-11-27', // US Thanksgiving and the day after
  '2026-12-24', '2026-12-25', '2026-12-26',
  '2026-12-31', '2027-01-01',
]);

/**
 * The next good moment to send, in that recipient's own local time.
 *
 * @param {string} zone   IANA zone
 * @param {number} nth    0 = the next available slot, 1 = the one after, and so on
 * @param {number} minute where in the 09:00-11:00 window to land, 0-119
 * @returns {Date} the UTC instant
 */
function nextSendSlot(zone, nth = 0, minute = 0) {
  const HOUR = 9;                       // 09:00 local, inside the 9-11 window
  let cursor = new Date();
  let found = -1;

  for (let i = 0; i < 400; i++) {
    // Build the instant for HOUR local on the day `cursor` falls on, in that zone.
    const off = offsetMinutes(zone, cursor);
    const localNow = new Date(cursor.getTime() + off * 60000);
    const y = localNow.getUTCFullYear(), m = localNow.getUTCMonth(), d = localNow.getUTCDate();
    let candidate = new Date(Date.UTC(y, m, d, HOUR, 0, 0) - off * 60000);
    // Re-resolve the offset AT the candidate, in case the day crosses a DST boundary.
    const off2 = offsetMinutes(zone, candidate);
    if (off2 !== off) candidate = new Date(Date.UTC(y, m, d, HOUR, 0, 0) - off2 * 60000);
    candidate = new Date(candidate.getTime() + minute * 60000);

    const local = new Date(candidate.getTime() + offsetMinutes(zone, candidate) * 60000);
    const dow = local.getUTCDay();
    const iso = local.toISOString().slice(0, 10);
    const good = dow >= 2 && dow <= 4 && !HOLIDAYS.has(iso) && candidate > new Date();

    if (good) { found++; if (found === nth) return candidate; }
    cursor = new Date(cursor.getTime() + 24 * 3600 * 1000);
  }
  // Should never happen, but never return undefined into a scheduler.
  return new Date(Date.now() + 24 * 3600 * 1000);
}

/** Human-readable local time, for logging what the recipient will actually see. */
function localLabel(zone, at) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(at);
}

module.exports = { zoneFor, nextSendSlot, localLabel, offsetMinutes, ZONES, HOLIDAYS };
