/**
 * frontdesk/slots.js, find the next free appointment slots around someone's real calendar.
 *
 * Lifted from demo/skyline-demo.js and made fit for live use. The demo walked only the days that
 * had events on them and treated Pacific wall-clock as UTC by arithmetic trick, which is fine for
 * a fixture and wrong for a calendar coming back from an API. This works on real instants, checks
 * business hours in the client's own IANA zone, starts from "now plus a little notice", and walks
 * a fixed horizon so an empty week still yields slots.
 *
 * The rules are the client's, not ours. A broker who books showings back to back and one who
 * needs twenty minutes to drive between them are both right; the config says which.
 *
 *   rules = {
 *     timezone: 'America/Los_Angeles',
 *     hours: { start: '09:00', end: '18:00' },     // in that zone
 *     days: [1,2,3,4,5,6],                         // 0 = Sunday
 *     slotMin: 15,                                 // granularity and default appointment length
 *     noticeMin: 120,                              // never offer something sooner than this
 *     horizonDays: 10,
 *     offer: 2,
 *     offerGapMin: 150,                            // offered slots at least this far apart
 *     bufferAfterCallMin: 5,
 *     bufferBeforeShowingMin: 20,
 *     bufferAfterShowingMin: 15,
 *   }
 *   events = [{ start: ISO, end: ISO, type: 'showing' | 'call' | 'personal' | 'hold' }]
 */

function addMin(d, m) { return new Date(d.getTime() + m * 60000); }

/** Wall-clock parts of an instant in a zone, without pulling in a date library. */
function partsIn(date, timezone) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday.slice(0, 3));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, weekday: wd };
}

/**
 * The instant at which a given wall-clock time occurs in a zone. Two-pass: guess in UTC, measure
 * the zone's offset at that guess, correct. Exact except within an hour of a DST change, which is
 * an acceptable imprecision for appointment slots.
 */
function instantAt(y, mo, d, h, mi, timezone) {
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi));
  const seen = partsIn(guess, timezone);
  const seenUTC = Date.UTC(seen.y, seen.mo - 1, seen.d, seen.h, seen.mi);
  const offset = seenUTC - guess.getTime();
  return new Date(guess.getTime() - offset);
}

function overlaps(aStart, aEnd, bStart, bEnd) { return aStart < bEnd && aEnd > bStart; }

/** Buffers apply only to the event types the rules name. A hold is treated like a showing. */
function zones(ev, rules) {
  const start = new Date(ev.start), end = new Date(ev.end);
  const type = ev.type === 'hold' ? 'showing' : ev.type;
  const pre = type === 'showing' ? (rules.bufferBeforeShowingMin || 0) : 0;
  const post = type === 'showing' ? (rules.bufferAfterShowingMin || 0)
    : type === 'call' ? (rules.bufferAfterCallMin || 0) : 0;
  return {
    core: [start, end],
    pre: pre ? [addMin(start, -pre), start] : null,
    post: post ? [end, addMin(end, post)] : null,
    preMin: pre, postMin: post, type,
  };
}

function fmt(date, timezone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(date).replace(',', '');
}

/**
 * Returns { offered: Date[], skipped: [{ time, reason }] }.
 * `skipped` lists the buffer near-misses, because a client watching it work wants to see the
 * rule refuse something, not just be told it exists.
 */
function findFreeSlots(events, rules, now = new Date()) {
  const tz = rules.timezone;
  const [hsH, hsM] = rules.hours.start.split(':').map(Number);
  const [heH, heM] = rules.hours.end.split(':').map(Number);
  const earliest = addMin(now, rules.noticeMin || 0);
  const evz = events.map((e) => ({ ...e, z: zones(e, rules) }));
  const offered = [], skipped = [];

  const today = partsIn(now, tz);
  for (let dayOffset = 0; dayOffset <= (rules.horizonDays || 10); dayOffset++) {
    // Step the calendar date in the zone, not the instant, so DST days keep their hours.
    const base = new Date(Date.UTC(today.y, today.mo - 1, today.d + dayOffset, 12));
    const p = partsIn(base, tz);
    if (!rules.days.includes(p.weekday)) continue;
    const dayStart = instantAt(p.y, p.mo, p.d, hsH, hsM, tz);
    const dayEnd = instantAt(p.y, p.mo, p.d, heH, heM, tz);

    for (let t = dayStart; addMin(t, rules.slotMin) <= dayEnd; t = addMin(t, rules.slotMin)) {
      if (t < earliest) continue;
      const tEnd = addMin(t, rules.slotMin);
      let status = 'free', reason = null;
      for (const ev of evz) {
        const { core, pre, post, preMin, postMin, type } = ev.z;
        if (overlaps(t, tEnd, core[0], core[1])) { status = 'busy'; break; }
        if (pre && overlaps(t, tEnd, pre[0], pre[1])) { status = 'buffer'; reason = `${preMin} min before the ${fmt(core[0], tz)} ${type}`; break; }
        if (post && overlaps(t, tEnd, post[0], post[1])) { status = 'buffer'; reason = `${postMin} min after the ${fmt(core[1], tz)} ${type}`; break; }
      }
      if (status === 'free') {
        // Two slots a quarter hour apart is one choice dressed as two. Space them out.
        const gap = (rules.offerGapMin || 0) * 60000;
        if (offered.some((o) => Math.abs(o.getTime() - t.getTime()) < gap)) continue;
        offered.push(t);
        if (offered.length >= (rules.offer || 2)) return { offered, skipped };
      } else if (status === 'buffer') {
        skipped.push({ time: t, reason });
      }
    }
  }
  return { offered, skipped };
}

module.exports = { findFreeSlots, fmt, addMin, instantAt, partsIn };
