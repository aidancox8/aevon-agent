#!/usr/bin/env node
/**
 * Every send must land Tue-Thu, 09:00-11:00, in the RECIPIENT'S local time.
 *
 * The first scheduler put everything at 09:40 Pacific because that is where the sender sits,
 * which is 12:40 in Ontario, 13:40 in Nova Scotia and 17:40 in the UK. Given 75% of cold emails
 * are opened within the first hour, arriving at the wrong local hour does not reduce the reply
 * rate so much as spend the send for nothing.
 */
const { zoneFor, nextSendSlot, localLabel } = require('./cadre/timezone');

const PLACES = [
  ['Vancouver BC', 'America/Vancouver'],
  ['Kamloops BC', 'America/Vancouver'],
  ['Red Deer AB', 'America/Edmonton'],
  ['Saskatoon SK', 'America/Regina'],
  ['Winnipeg MB', 'America/Winnipeg'],
  ['Mississauga ON', 'America/Toronto'],
  ['Montreal QC', 'America/Toronto'],
  ['Halifax NS', 'America/Halifax'],
  ["St. John's NL", 'America/St_Johns'],
  ['Dayton OH', 'America/New_York'],
  ['Houston TX', 'America/Chicago'],
  ['Seattle WA', 'America/Los_Angeles'],
  ['Phoenix AZ', 'America/Phoenix'],
  ['Manchester', 'Europe/London'],
  ['Dublin', 'Europe/Dublin'],
];

let bad = 0;
console.log('place            zone                   resolved  first slot, LOCAL to them');
for (const [place, expected] of PLACES) {
  const zone = zoneFor(place, '');
  const zoneOk = zone === expected;
  const when = nextSendSlot(zone, 0, 0);
  const label = localLabel(zone, when);

  // Parse the local hour and weekday back out of the formatted label.
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour12: false, hour: '2-digit', weekday: 'short' })
    .formatToParts(when);
  const hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const dow = parts.find(p => p.type === 'weekday').value;

  const hourOk = hour >= 9 && hour < 11;
  const dayOk = ['Tue', 'Wed', 'Thu'].includes(dow);
  const ok = zoneOk && hourOk && dayOk;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${place.padEnd(16)}${zone.padEnd(23)}${zoneOk ? 'yes' : 'NO '}      ${label}`);
}

// Slots must advance, not repeat.
const z = 'America/Toronto';
const slots = [0, 1, 2].map(n => nextSendSlot(z, n, 0).getTime());
const advancing = slots[0] < slots[1] && slots[1] < slots[2];
if (!advancing) bad++;
console.log(`${advancing ? 'ok  ' : 'FAIL'} consecutive slots advance`);

// The minute offset must stay inside the window.
const late = nextSendSlot(z, 0, 110);
const lateHour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: z, hour12: false, hour: '2-digit' }).format(late), 10);
const inWindow = lateHour >= 9 && lateHour < 11;
if (!inWindow) bad++;
console.log(`${inWindow ? 'ok  ' : 'FAIL'} +110 minutes stays inside 09:00-11:00 (got ${lateHour}:xx)`);

console.log(`\n${PLACES.length + 2 - bad}/${PLACES.length + 2} passed`);
process.exit(bad ? 1 : 0);
