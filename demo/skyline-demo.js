/**
 * demo/skyline-demo.js,  15 minute screen-share demo for Sofia (Skyline Properties)
 *
 * Walks the whole loop end to end on a made-up inbound text: qualify, draft, offer a
 * calendar slot, confirm, then show what would post to GoHighLevel. Nothing here touches
 * her systems. There is no GHL account, no API key, no request. Every "Would POST" block
 * below is a payload we print and nothing else. The calendar and the lead are both made up
 * for the walkthrough; nothing here is a real Skyline customer or a real booking.
 *
 * Reuses intake-agent.js's own classifier (handleInquiry) and the skyline config, so the
 * qualification shown here is the same prompt path the real build runs, not a demo-only
 * stand-in.
 *
 * Usage:
 *   node demo/skyline-demo.js --text "just got orders to JBLM, need a 3br off base"
 *   node demo/skyline-demo.js --text "..." --from "Marcus Ellison <+1 253-555-0142>"
 *   node demo/skyline-demo.js               paste on stdin, blank line ends it
 *   node demo/skyline-demo.js --yes         skip the confirm prompt (dry rehearsal)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const args = process.argv.slice(2);
const YES = args.includes('--yes');
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};

// intake-agent.js picks its client config by reading `--config` off process.argv itself
// (it is normally run directly, not required). Requiring it here still goes through that
// same parsing, so inject `--config skyline` into argv for the require and put argv back
// straight after, rather than duplicating its CONFIGS block in this file.
const originalArgv = process.argv;
process.argv = [...originalArgv, '--config', 'skyline'];
const { handleInquiry, nameOf, addressOf } = require('../intake-agent');
process.argv = originalArgv;

// Copied verbatim from intake-agent.js's readStdin: a BLANK LINE ends the message when
// typed interactively, EOF ends it when piped. Kept identical so the demo behaves the
// same way a prospect already expects from --try.
function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    if (process.stdin.isTTY) {
      console.log('Paste the inquiry, then press Enter twice (an empty line ends it):\n');
      process.stdin.on('data', (c) => {
        buf += c;
        if (/\r?\n\s*\r?\n$/.test(buf) && buf.trim()) { process.stdin.pause(); resolve(buf.trim()); }
      });
    } else {
      process.stdin.on('data', (c) => { buf += c; });
    }
    process.stdin.on('end', () => resolve(buf.trim()));
  });
}

// Confirm step reads exactly one line, unlike the blank-line-terminated inbound text above.
function readLine() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.once('line', (line) => { rl.close(); resolve(line); });
    rl.once('close', () => resolve(''));
  });
}

// ── Calendar math ────────────────────────────────────────────────
// Every timestamp in skyline-calendar.json is already Pacific wall-clock (the "-07:00" is
// there so the file is honest about which zone, not so anything converts it). Parsing with
// Date.UTC on the raw Y/M/D/h/m and never touching the host machine's own timezone keeps
// the arithmetic simple and correct regardless of what machine this runs on.
function parseWallClock(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) throw new Error(`bad timestamp: ${iso}`);
  const [, y, mo, d, h, mi] = m.map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi));
}
function addMin(date, min) { return new Date(date.getTime() + min * 60000); }
function dateKey(date) { return date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate(); }
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtTime(date) {
  let h = date.getUTCHours();
  const mi = date.getUTCMinutes();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${String(mi).padStart(2, '0')}${ampm}`;
}
function fmtDay(date) {
  return `${WEEKDAY[date.getUTCDay()]} ${MONTH[date.getUTCMonth()]} ${date.getUTCDate()}`;
}
function fmtSlot(date) { return `${fmtDay(date)} ${fmtTime(date)}`; }
// Matches the -07:00 convention used in skyline-calendar.json, not a real UTC conversion:
// the Date object holds Pacific wall-clock numbers stored via Date.UTC as an arithmetic
// trick (see parseWallClock above), so toISOString() would mislabel them as UTC.
function toISOPacific(date) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${p2(date.getUTCMonth() + 1)}-${p2(date.getUTCDate())}` +
    `T${p2(date.getUTCHours())}:${p2(date.getUTCMinutes())}:00-07:00`;
}

// Buffers only apply to the event types the rules name: a showing needs runway before it
// and recovery after it, a call needs a short reset after it, personal time blocks its own
// interval and nothing more.
function eventZones(ev, rules) {
  const coreStart = parseWallClock(ev.start);
  const coreEnd = parseWallClock(ev.end);
  const pre = ev.type === 'showing' ? rules.bufferBeforeShowingMin : 0;
  const post = ev.type === 'showing' ? rules.bufferAfterShowingMin
    : ev.type === 'call' ? rules.bufferAfterCallMin : 0;
  return {
    core: [coreStart, coreEnd],
    preZone: pre > 0 ? [addMin(coreStart, -pre), coreStart] : null,
    postZone: post > 0 ? [coreEnd, addMin(coreEnd, post)] : null,
    pre, post, coreStart, coreEnd,
  };
}
function overlaps(aStart, aEnd, bStart, bEnd) { return aStart < bEnd && aEnd > bStart; }

/**
 * Walks every rules.slotMin candidate inside business hours, day by day across the whole
 * calendar file, and returns the first `rules.offer` slots that clear every event plus its
 * buffers. Also returns the buffer-only near-misses hit along the way (candidates that did
 * not touch an actual event but landed inside its buffer), so the demo can show the rule
 * doing work rather than just asserting it does.
 */
function findFreeSlots(events, rules) {
  const [hStartH, hStartM] = rules.hours.start.split(':').map(Number);
  const [hEndH, hEndM] = rules.hours.end.split(':').map(Number);
  const dayKeys = [...new Set(events.map((e) => dateKey(parseWallClock(e.start))))].sort();

  const offered = [];
  const skipped = [];

  for (const dk of dayKeys) {
    const y = Math.floor(dk / 10000), mo = Math.floor((dk % 10000) / 100), d = dk % 100;
    const dayStart = new Date(Date.UTC(y, mo - 1, d, hStartH, hStartM));
    const dayEnd = new Date(Date.UTC(y, mo - 1, d, hEndH, hEndM));
    if (!rules.days.includes(dayStart.getUTCDay())) continue;

    const dayEvents = events.filter((e) => dateKey(parseWallClock(e.start)) === dk)
      .map((e) => ({ ...e, zones: eventZones(e, rules) }));

    for (let t = dayStart; addMin(t, rules.slotMin) <= dayEnd; t = addMin(t, rules.slotMin)) {
      const slotStart = t, slotEnd = addMin(t, rules.slotMin);
      let status = 'free', reason = null;

      for (const ev of dayEvents) {
        const { core, preZone, postZone } = ev.zones;
        if (overlaps(slotStart, slotEnd, core[0], core[1])) { status = 'busy'; break; }
        if (preZone && overlaps(slotStart, slotEnd, preZone[0], preZone[1])) {
          status = 'buffer';
          reason = `${ev.zones.pre} min buffer before ${fmtTime(ev.zones.coreStart)} ${ev.type}`;
          break;
        }
        if (postZone && overlaps(slotStart, slotEnd, postZone[0], postZone[1])) {
          status = 'buffer';
          reason = `${ev.zones.post} min buffer after ${fmtTime(ev.zones.coreEnd)} ${ev.type}`;
          break;
        }
      }

      if (status === 'free') {
        offered.push(slotStart);
        if (offered.length >= rules.offer) return { offered, skipped };
      } else if (status === 'buffer') {
        skipped.push({ time: slotStart, reason });
      }
    }
  }
  return { offered, skipped };
}

// ── GHL mock payloads ───────────────────────────────────────────
function ghlContactUpsert(contact) {
  return {
    locationId: 'loc_XXXX',
    firstName: contact.firstName,
    lastName: contact.lastName || '',
    phone: contact.phone,
    tags: ['pcs-lead', 'va'],
    source: 'GoHighLevel SMS',
  };
}
function ghlNote(contactId, body) {
  return { locationId: 'loc_XXXX', contactId, body };
}
function ghlAppointment(contactId, startTime, title) {
  return {
    calendarId: 'cal_XXXX',
    locationId: 'loc_XXXX',
    contactId,
    startTime,
    title,
  };
}
function ghlMessage(contactId, message) {
  return { type: 'SMS', locationId: 'loc_XXXX', contactId, message };
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  const started = Date.now();

  // STEP 1, INBOUND
  const fromRaw = flag('from') || 'Marcus Ellison <+1 253-555-0142>';
  const fromName = nameOf(fromRaw) || fromRaw.replace(/<.*>/, '').trim() || 'A lead';
  const fromPhone = addressOf(fromRaw) || fromRaw;
  const text = flag('text') || await readStdin();
  if (!text) throw new Error('No message. Pass --text "..." or pipe one in on stdin.');

  console.log('Lead texts your GoHighLevel number:');
  console.log(text);
  console.log();

  // STEP 2, QUALIFY
  const msg = { fromName, fromEmail: fromPhone, subject: '(SMS)', body: text };
  const res = await handleInquiry(msg);
  const tag = res.intent === 'inquiry' ? (res.qualified ? 'QUALIFIED INQUIRY' : 'inquiry (not qualified)') : res.intent;

  console.log(`intent: ${tag}${res.reason ? '  ' + res.reason : ''}`);
  if (res.known && res.known.length) console.log(`known: ${res.known.join(' | ')}`);
  if (res.missing && res.missing.length) console.log(`still needed: ${res.missing.join(' | ')}`);
  console.log();

  if (!(res.intent === 'inquiry' && res.qualified && res.draft)) {
    console.log('Not a qualified inquiry with a draft, so there is nothing to offer a slot for. Stopping here.');
    console.log(`\nDONE. ${((Date.now() - started) / 1000).toFixed(1)}s elapsed.`);
    return;
  }

  // STEP 3, DRAFT
  console.log('Draft, waiting for Sofia\'s OK:');
  console.log(res.draft);
  console.log();

  // STEP 4, CALENDAR
  const calendarPath = path.join(__dirname, 'skyline-calendar.json');
  const rulesPath = path.join(__dirname, 'skyline-rules.json');
  const events = JSON.parse(fs.readFileSync(calendarPath, 'utf8'));
  const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
  const { offered, skipped } = findFreeSlots(events, rules);

  if (!offered.length) {
    console.log('No slot found in the calendar window that clears every buffer. Stopping here.');
    console.log(`\nDONE. ${((Date.now() - started) / 1000).toFixed(1)}s elapsed.`);
    return;
  }

  console.log(`Offered: ${offered.map(fmtSlot).join(', ')}`);
  for (const s of skipped.slice(0, 4)) {
    console.log(`skipped ${fmtTime(s.time)}: ${s.reason}`);
  }
  if (skipped.length > 4) console.log(`(${skipped.length - 4} more slot(s) skipped by the same buffers, not printed)`);
  console.log();

  // STEP 5, CONFIRM
  console.log("Sofia (by text): reply C to confirm the first slot, or N");
  let confirmLine;
  if (YES) {
    confirmLine = 'C';
    console.log('(--yes: auto-confirmed C for a dry rehearsal)');
  } else {
    confirmLine = await readLine();
  }
  console.log();

  if (confirmLine.trim().toUpperCase() !== 'C') {
    console.log('Held. Nothing sent.');
    return;
  }

  const chosenSlot = offered[0];

  // STEP 6, GHL (mocked, nothing is sent)
  console.log('Would POST to GoHighLevel:');
  console.log('(ids come from her account once we are signed; loc_XXXX and cal_XXXX below are placeholders)');
  console.log();

  const nameParts = fromName.trim().split(/\s+/);
  const contact = { firstName: nameParts[0] || fromName, lastName: nameParts.slice(1).join(' '), phone: fromPhone };
  const contactId = 'contact_XXXX';
  const noteBody = [
    ...(res.known || []).map((k) => `known: ${k}`),
    ...(res.missing || []).map((m) => `still needed: ${m}`),
  ].join('\n') || 'no qualification facts captured yet';

  console.log('POST /contacts/upsert');
  console.log(JSON.stringify(ghlContactUpsert(contact), null, 2));
  console.log();

  console.log(`POST /contacts/${contactId}/notes`);
  console.log(JSON.stringify(ghlNote(contactId, noteBody), null, 2));
  console.log();

  console.log('POST /calendars/events/appointments');
  console.log(JSON.stringify(ghlAppointment(contactId, toISOPacific(chosenSlot), `Skyline showing follow-up, ${fromName}`), null, 2));
  console.log();

  console.log('POST /conversations/messages');
  console.log(JSON.stringify(ghlMessage(contactId, res.draft), null, 2));
  console.log();

  // STEP 7, DONE
  console.log(`DONE. ${((Date.now() - started) / 1000).toFixed(1)}s elapsed.`);
}

main().catch((err) => { console.error('Fatal error:', err.message); process.exit(1); });
