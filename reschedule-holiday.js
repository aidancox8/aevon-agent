/**
 * reschedule-holiday.js
 * Moves any queued leads scheduled for a weekend or BC holiday to the next sendable weekday.
 * Safe to re-run — only touches leads that are actually on a bad day.
 */

require('dotenv').config();
const supabase = require('./lib/supabase');

const SEND_HOUR_UTC = 16; // 9am PT

function getEaster(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m2 = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m2 + 114) / 31);
  const day = ((h + l - 7 * m2 + 114) % 31) + 1;
  return { m: month, d: day };
}

function firstMonday(y, m) {
  const date = new Date(y, m - 1, 1);
  while (date.getDay() !== 1) date.setDate(date.getDate() + 1);
  return date.getDate();
}

function isBCHoliday({ y, m, d }) {
  if (m === 1  && d === 1)  return true;
  if (m === 7  && d === 1)  return true;
  if (m === 9  && d === 30) return true;
  if (m === 11 && d === 11) return true;
  if (m === 12 && d === 25) return true;
  if (m === 12 && d === 26) return true;
  if (m === 2  && d === firstMonday(y, 2) + 14) return true;
  const easter = getEaster(y);
  const gfDate = new Date(y, easter.m - 1, easter.d - 2);
  if (m === gfDate.getMonth() + 1 && d === gfDate.getDate()) return true;
  if (m === 5) {
    const may24 = new Date(y, 4, 24);
    while (may24.getDay() !== 1) may24.setDate(may24.getDate() - 1);
    if (d === may24.getDate()) return true;
  }
  if (m === 8  && d === firstMonday(y, 8))  return true;
  if (m === 9  && d === firstMonday(y, 9))  return true;
  if (m === 10 && d === firstMonday(y, 10) + 7) return true;
  return false;
}

function isBadDay(dateStr) {
  const d = new Date(dateStr);
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return true;
  return isBCHoliday({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() });
}

function nextSendableDay(fromDate, dayCounts) {
  const candidate = new Date(fromDate);
  candidate.setUTCDate(candidate.getUTCDate() + 1);
  candidate.setUTCHours(SEND_HOUR_UTC, 0, 0, 0);

  for (let i = 0; i < 90; i++) {
    const dow = candidate.getUTCDay();
    if (dow >= 1 && dow <= 5 && !isBCHoliday({ y: candidate.getUTCFullYear(), m: candidate.getUTCMonth() + 1, d: candidate.getUTCDate() })) {
      const key = candidate.toISOString().slice(0, 10);
      const count = dayCounts.get(key) || 0;
      if (count < 20) {
        dayCounts.set(key, count + 1);
        return candidate.toISOString();
      }
    }
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }

  throw new Error('No open send slot found in the next 90 days');
}

async function run() {
  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, business_name, scheduled_send_at')
    .eq('status', 'queued')
    .not('scheduled_send_at', 'is', null);

  if (error) throw new Error(error.message);

  const bad = leads.filter(l => isBadDay(l.scheduled_send_at));

  if (bad.length === 0) {
    console.log('No leads scheduled on bad days. Nothing to do.');
    return;
  }

  console.log(`Found ${bad.length} lead(s) scheduled on weekends/holidays. Rescheduling...\n`);

  // Build day counts from leads NOT being moved
  const staying = leads.filter(l => !isBadDay(l.scheduled_send_at));
  const dayCounts = new Map();
  staying.forEach(l => {
    const key = l.scheduled_send_at.slice(0, 10);
    dayCounts.set(key, (dayCounts.get(key) || 0) + 1);
  });

  // Sort bad leads by their current scheduled_send_at so earlier ones get earlier slots
  bad.sort((a, b) => a.scheduled_send_at.localeCompare(b.scheduled_send_at));

  let moved = 0;
  for (const lead of bad) {
    const newDate = nextSendableDay(new Date(Date.now() - 86400000), dayCounts);
    await supabase.from('leads').update({ scheduled_send_at: newDate }).eq('id', lead.id);
    const display = new Date(newDate).toLocaleString('en-CA', { timeZone: 'America/Vancouver', dateStyle: 'medium' });
    console.log(`  ${lead.business_name} → ${display}`);
    moved++;
  }

  console.log(`\nDone. Moved ${moved} lead(s).`);
}

run().catch(err => { console.error(err.message); process.exit(1); });
