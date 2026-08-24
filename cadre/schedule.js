#!/usr/bin/env node
/**
 * cadre/schedule.js — spread written copy across send days.
 *
 * The sender picks up leads whose scheduled_send_at has passed. Without this, everything with
 * copy is due at once and the daily cap decides the order arbitrarily, which throws away the
 * qualification score.
 *
 * Two rules the other campaigns learned:
 *
 * WEEKDAYS ONLY. A cold email landing Saturday is read Monday alongside the weekend backlog, or
 * not at all.
 *
 * SPREAD ACROSS PROVIDERS. Sending the whole day's batch into one mail host looks worse than the
 * same volume spread out, and the list is concentrated: Microsoft-hosted domains were 880 of
 * 1,872 measured on the Aevon list. This interleaves by recipient domain so a single day's batch
 * does not hit one provider repeatedly.
 *
 * Strongest signal goes first, because if the argument does not work the answer should arrive
 * from the best examples rather than the worst.
 *
 *   node cadre/schedule.js --dry
 *   node cadre/schedule.js --per-day 12
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const supabase = require('../lib/supabase');

const TABLE = 'cadre_leads';
const DRY = process.argv.includes('--dry');
const PER_DAY = (() => {
  const i = process.argv.indexOf('--per-day');
  return i > -1 ? parseInt(process.argv[i + 1], 10) : parseInt(process.env.CADRE_DAILY_CAP || '10', 10);
})();
/** Keep already-scheduled leads where they are unless asked to redo them. */
const RESCHEDULE = process.argv.includes('--reschedule');

/** 09:40 Pacific on the Nth working day from today, inside the send window. */
function slot(dayIndex, withinDay, perDay) {
  const d = new Date();
  d.setUTCHours(16, 40, 0, 0);
  let added = 0;
  if (d < new Date()) added = -1;
  while (added < dayIndex) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  // Spread the day's batch over the morning rather than firing them in one second.
  d.setUTCMinutes(d.getUTCMinutes() + Math.round((withinDay / Math.max(1, perDay)) * 180));
  return d.toISOString();
}

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

(async () => {
  let query = supabase.from(TABLE)
    .select('id, business_name, email, qualification_score, scheduled_send_at, contact_name')
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
  console.log(`${DRY ? 'DRY RUN: ' : ''}scheduling ${ordered.length} lead(s) at ${PER_DAY}/day\n`);

  let n = 0;
  const perDayCount = {};
  for (const [i, lead] of ordered.entries()) {
    const dayIndex = Math.floor(i / PER_DAY);
    const withinDay = i % PER_DAY;
    const when = slot(dayIndex, withinDay, PER_DAY);
    const day = when.slice(0, 10);
    perDayCount[day] = (perDayCount[day] || 0) + 1;

    if (!DRY) {
      const { error: upErr } = await supabase.from(TABLE)
        .update({ scheduled_send_at: when, send_batch: dayIndex + 1 }).eq('id', lead.id);
      if (upErr) { console.error(`FAILED ${lead.business_name}: ${upErr.message}`); continue; }
    }
    if (i < 12 || DRY) {
      console.log(`  ${when.slice(0, 16).replace('T', ' ')}  ${String(lead.qualification_score || 0).padStart(2)}/10  ` +
        `${lead.business_name.slice(0, 32).padEnd(34)}${domainOf(lead.email)}`);
    }
    n++;
  }
  if (n > 12 && !DRY) console.log(`  ... and ${n - 12} more`);

  console.log(`\n${DRY ? 'Would schedule' : 'Scheduled'} ${n} across ${Object.keys(perDayCount).length} send day(s):`);
  for (const [day, count] of Object.entries(perDayCount).sort()) console.log(`  ${day}  ${count}`);
})().catch(e => { console.error('schedule failed:', e.message); process.exit(1); });
