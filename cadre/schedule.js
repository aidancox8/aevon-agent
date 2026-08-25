#!/usr/bin/env node
/**
 * cadre/schedule.js — decide when each written email actually goes out.
 *
 * The sender picks up leads whose scheduled_send_at has passed. Without this, everything with
 * copy is due at once and the daily cap decides the order arbitrarily, which throws away the
 * qualification score.
 *
 * WHAT THIS GETS RIGHT NOW AND DID NOT BEFORE. The first version put every send at 09:40 Pacific
 * because that is where the sender sits. For a lead in Ontario that is 12:40, in Nova Scotia
 * 13:40, in the UK 17:40. Since 75% of cold emails are opened within the first hour of arriving,
 * landing at the wrong local hour does not lower the reply rate so much as spend the send for
 * nothing. Every slot is now computed in the RECIPIENT'S zone. See cadre/timezone.js.
 *
 * The rules, and why each one is here:
 *
 * TUESDAY, WEDNESDAY, THURSDAY ONLY, 09:00-11:00 THEIR TIME. Tue-Thu reply 30-45% better than
 * Monday or Friday; weekends fall to 1.6% against 4.1%. Holidays are skipped.
 *
 * ONE GLOBAL DAILY CAP, NOT ONE PER ZONE. The cap protects the sending identity's reputation,
 * and the identity does not care which zone the recipients were in. A day fills up across all
 * zones together and the next lead rolls to the following send day.
 *
 * SPREAD ACROSS PROVIDERS. Sending a whole day's batch into one mail host looks worse than the
 * same volume spread out, and the list is concentrated: Microsoft-hosted domains were 880 of
 * 1,872 measured on the Aevon list. Ordering interleaves by recipient domain.
 *
 * SPREAD ACROSS THE WINDOW. Sends inside one day are fanned across the two hours rather than
 * fired in the same second, which is the single most obvious machine tell there is.
 *
 * Strongest signal goes first, because if the argument does not work the answer should arrive
 * from the best examples rather than the worst.
 *
 *   node cadre/schedule.js --dry
 *   node cadre/schedule.js --per-day 12 --reschedule
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const supabase = require('../lib/supabase');
const { zoneFor, nextSendSlot, localLabel } = require('./timezone');

const TABLE = 'cadre_leads';
const DRY = process.argv.includes('--dry');
const PER_DAY = (() => {
  const i = process.argv.indexOf('--per-day');
  return i > -1 ? parseInt(process.argv[i + 1], 10) : parseInt(process.env.CADRE_DAILY_CAP || '10', 10);
})();
/** Keep already-scheduled leads where they are unless asked to redo them. */
const RESCHEDULE = process.argv.includes('--reschedule');

/** How wide the 09:00 window is, in minutes. 120 puts the last send of a day at 11:00 local. */
const WINDOW_MIN = 120;

const domainOf = e => String(e || '').split('@')[1] || '';

/**
 * Interleave so consecutive sends go to different mail hosts where possible. Round-robins
 * across per-domain queues, taking the highest-scoring lead from each in turn.
 */
function interleaveByDomain(leads) {
  const byDomain = new Map();
  for (const l of leads) {
    const d = domainOf(l.email).toLowerCase();
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(l);
  }
  for (const q of byDomain.values()) q.sort((a, b) => (b.qualification_score || 0) - (a.qualification_score || 0));
  const queues = [...byDomain.values()].sort((a, b) => b.length - a.length);
  const out = [];
  while (out.length < leads.length) {
    let moved = false;
    for (const q of queues) if (q.length) { out.push(q.shift()); moved = true; }
    if (!moved) break;
  }
  return out;
}

/**
 * Place one lead at 09:00-11:00 in its own zone, on the earliest send day that still has room
 * under the global cap.
 *
 * `dayCounts` is shared across every zone on purpose: the cap is a property of the sender, not
 * of the recipient's country.
 */
function place(zone, dayCounts, perDay) {
  for (let nth = 0; nth < 120; nth++) {
    const base = nextSendSlot(zone, nth, 0);
    const day = base.toISOString().slice(0, 10);
    const taken = dayCounts.get(day) || 0;
    if (taken >= perDay) continue;                  // that day is full, try this zone's next slot
    dayCounts.set(day, taken + 1);
    // Fan out across the window by position in the day, so nothing shares a timestamp.
    const minute = Math.round((taken / Math.max(1, perDay)) * WINDOW_MIN);
    return { when: nextSendSlot(zone, nth, minute), day };
  }
  return null;
}

(async () => {
  let query = supabase.from(TABLE)
    .select('id, business_name, email, city, address, qualification_score, scheduled_send_at, contact_name, status')
    .eq('status', 'queued')
    .not('email_subject', 'is', null)
    .not('email', 'is', null);
  if (!RESCHEDULE) query = query.is('scheduled_send_at', null);

  const { data: leads, error } = await query.order('qualification_score', { ascending: false, nullsFirst: false });
  if (error) throw new Error(error.message);
  if (!leads.length) {
    console.log('Nothing to schedule. Everything with copy already has a send date.');
    console.log('Use --reschedule to redo dates for leads that already have one.');
    return;
  }

  const ordered = interleaveByDomain(leads);
  console.log(`${DRY ? 'DRY RUN: ' : ''}scheduling ${ordered.length} lead(s), max ${PER_DAY}/day, ` +
    `each at 09:00-11:00 in the recipient's own zone\n`);

  const dayCounts = new Map();
  const zoneTally = {};
  const perDayCount = {};
  let n = 0;

  for (const lead of ordered) {
    const zone = zoneFor(lead.city || lead.address, lead.address);
    zoneTally[zone] = (zoneTally[zone] || 0) + 1;

    const placed = place(zone, dayCounts, PER_DAY);
    if (!placed) { console.error(`FAILED ${lead.business_name}: no slot found`); continue; }
    const when = placed.when.toISOString();
    perDayCount[placed.day] = (perDayCount[placed.day] || 0) + 1;

    if (!DRY) {
      const { error: upErr } = await supabase.from(TABLE)
        .update({ scheduled_send_at: when, send_batch: Object.keys(perDayCount).sort().indexOf(placed.day) + 1 })
        .eq('id', lead.id);
      if (upErr) { console.error(`FAILED ${lead.business_name}: ${upErr.message}`); continue; }
    }
    if (n < 20 || DRY) {
      console.log(`  ${localLabel(zone, placed.when).padEnd(24)} ${String(lead.qualification_score || 0).padStart(2)}/10  ` +
        `${String(lead.business_name).slice(0, 30).padEnd(32)}${zone.replace(/^America\//, '')}`);
    }
    n++;
  }
  if (n > 20 && !DRY) console.log(`  ... and ${n - 20} more`);

  console.log(`\n${DRY ? 'Would schedule' : 'Scheduled'} ${n} across ${Object.keys(perDayCount).length} send day(s):`);
  for (const [day, count] of Object.entries(perDayCount).sort()) console.log(`  ${day}  ${count}`);
  console.log('\nBy recipient zone:');
  for (const [z, c] of Object.entries(zoneTally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(3)}  ${z}`);
})().catch(e => { console.error('schedule failed:', e.message); process.exit(1); });
