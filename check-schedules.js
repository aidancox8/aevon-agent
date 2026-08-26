#!/usr/bin/env node
/**
 * check-schedules.js — catch the whole class of timing bug, not one at a time.
 *
 * GitHub Actions cron has NO timezone support. It is always UTC. Every "9am PT" comment in these
 * workflows is really a fixed UTC hour that slides an hour in local terms when daylight saving
 * ends, and the failures are silent:
 *
 *   - sender.js paced the daily cap against SEND_HOURS = [9..16], Pacific hours compared to a
 *     Pacific clock. After DST ends the workflow fires 08:00-15:00 PT, so on the last real run
 *     the pacer believed a 16:00 run was still coming, sent half the remainder and held the rest
 *     back forever. Half the configured volume, every weekday, all winter, silently.
 *
 * This asserts the two things that can drift apart: any code listing the hours a workflow runs
 * must be in UTC, and any UTC hour list must match the cron it claims to mirror.
 *
 *   node check-schedules.js
 */
const fs = require('fs');
const path = require('path');

let bad = 0;
const check = (label, cond, detail = '') => {
  if (!cond) bad++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
};

/** Expand a cron hour field ("16-23", "8-19", "17", "1,5") into the hours it fires. */
function cronHours(spec) {
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const m = part.match(/^(\d+)-(\d+)$/);
    if (m) { for (let h = +m[1]; h <= +m[2]; h++) out.add(h); continue; }
    if (/^\d+$/.test(part)) out.add(+part);
    if (part === '*') for (let h = 0; h < 24; h++) out.add(h);
  }
  return [...out].sort((a, b) => a - b);
}

const wfDir = '.github/workflows';
const workflows = {};
for (const f of fs.readdirSync(wfDir)) {
  const y = fs.readFileSync(path.join(wfDir, f), 'utf8');
  const hours = new Set();
  for (const m of y.matchAll(/- cron: '(\S+) (\S+) [^']*'/g)) cronHours(m[2]).forEach(h => hours.add(h));
  if (hours.size) workflows[f] = [...hours].sort((a, b) => a - b);
}

// 1. The Aevon pacer must mirror send-outreach.yml exactly, in UTC.
const senderSrc = fs.readFileSync('sender.js', 'utf8');
check('sender.js paces in UTC, not in local hours',
  /SEND_HOURS_UTC/.test(senderSrc) && !/const SEND_HOURS\s*=/.test(senderSrc));
check('sender.js compares against a UTC clock, not a Vancouver one',
  /getUTCHours\(\)/.test(senderSrc) && !/timeZone: 'America\/Vancouver'[\s\S]{0,80}runsLeft/.test(senderSrc));

const declared = (senderSrc.match(/const SEND_HOURS_UTC = \[([^\]]+)\]/) || [])[1];
const declaredHours = declared ? declared.split(',').map(x => +x.trim()).sort((a, b) => a - b) : [];
const cronHrs = workflows['send-outreach.yml'] || [];
check('sender.js SEND_HOURS_UTC matches send-outreach.yml cron',
  JSON.stringify(declaredHours) === JSON.stringify(cronHrs),
  `code [${declaredHours}] vs cron [${cronHrs}]`);

// 2. The Cadre window must still span 09:00 in the earliest zone to 11:00 in the latest, in
//    BOTH halves of the year, because that is the window schedule.js books sends into.
const cadre = workflows['cadre-send.yml'] || [];
const zones = [['Europe/London', 'earliest'], ['America/Los_Angeles', 'latest']];
for (const [zone, which] of zones) {
  for (const [label, date] of [['summer', [2026, 8, 26]], ['winter', [2026, 11, 15]]]) {
    // What UTC hour is 09:00 (earliest) or 11:00 (latest) local on that date?
    const target = which === 'earliest' ? 9 : 11;
    let found = null;
    for (let h = 0; h < 24; h++) {
      const d = new Date(Date.UTC(date[0], date[1] - 1, date[2], h, 0, 0));
      const local = parseInt(new Intl.DateTimeFormat('en-US',
        { timeZone: zone, hour: '2-digit', hour12: false }).format(d), 10);
      if (local === target) { found = h; break; }
    }
    check(`cadre window covers ${target}:00 ${zone} in ${label}`,
      found !== null && cadre.includes(found), `needs UTC ${found}, cron has [${cadre[0]}-${cadre[cadre.length - 1]}]`);
  }
}

// 3. Nothing else may hardcode local send hours; that is the bug this file exists for.
for (const f of ['tempo/sender.js', 'cadre/sender.js']) {
  const src = fs.readFileSync(f, 'utf8');
  check(`${f} does not pace against hardcoded local hours`,
    !/SEND_HOURS\s*=\s*\[\s*9\s*,/.test(src));
}

console.log(`\n${bad ? `${bad} FAILED` : 'Schedules are DST-proof.'}`);
process.exit(bad ? 1 : 0);
