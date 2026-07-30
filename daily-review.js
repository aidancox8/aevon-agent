#!/usr/bin/env node
/**
 * Daily review across both outreach campaigns.
 *
 * Read-only: never sends, never mutates a lead. Safe to run repeatedly.
 *
 *   node daily-review.js            today
 *   node daily-review.js --days 7   last 7 days
 *
 * Two things this had to get right, because the obvious version gets them wrong:
 *   1. Supabase caps a select at 1000 rows. Every read here pages to the end, otherwise
 *      a 9k-lead table silently reports as 5k and every rate is computed off a fraction.
 *   2. There is no 'sent' status. The sender writes last_sent_at and leaves the lead
 *      'queued' so it stays eligible for follow-ups. Counting status='sent' finds nothing
 *      and makes the bounce rate look catastrophic.
 */
const supabase = require('./lib/supabase');

const DAYS = (() => {
  const i = process.argv.indexOf('--days');
  return i > -1 ? Math.max(1, parseInt(process.argv[i + 1], 10) || 1) : 1;
})();
const SINCE = new Date(Date.now() - DAYS * 86400000).toISOString();
const TZ = 'America/Vancouver';

const ptDay = d => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ });
const TODAY = ptDay(Date.now());
const pct = (n, d) => (d ? (n / d * 100).toFixed(1) + '%' : 'n/a');

/** Read every row, paging past the 1000-row cap. */
async function readAll(table, cols) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(cols).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

const CAMPAIGNS = [
  { label: 'TEMPO', sub: 'clinic scheduling', leads: 'tempo_leads', events: 'tempo_email_events', perDay: 20, sendDays: 'Mon-Fri' },
  { label: 'AEVON', sub: 'AI consulting',     leads: 'leads',       events: 'email_events',       perDay: 85, sendDays: 'Mon-Fri' },
];

async function review(c, warnings) {
  const leads = await readAll(c.leads, 'status,email,last_sent_at,sequence_step');
  const events = await readAll(c.events, 'event_type,created_at');

  const withEmail = leads.filter(l => l.email);
  const sent      = leads.filter(l => l.last_sent_at);
  const sentToday = leads.filter(l => l.last_sent_at && ptDay(l.last_sent_at) === TODAY);
  const noEmail   = leads.filter(l => l.status === 'queued' && !l.email);
  const untouched = withEmail.filter(l => !l.last_sent_at && l.status === 'queued');

  const ev = t => events.filter(e => e.event_type === t);
  const recent = events.filter(e => e.created_at >= SINCE);
  const recentBy = recent.reduce((a, e) => { a[e.event_type] = (a[e.event_type] || 0) + 1; return a; }, {});

  const nSent = ev('sent').length, nDeliv = ev('delivered').length;
  const nBounce = ev('bounced').length, nClick = ev('clicked').length;
  const nReply = ev('replied').length, nOpen = ev('opened').length;

  console.log(`\n── ${c.label}  (${c.sub}) ${'─'.repeat(Math.max(0, 34 - c.sub.length))}`);
  console.log(`   list        ${leads.length} leads · ${withEmail.length} with email · ${leads.length - withEmail.length} without`);
  console.log(`   progress    ${sent.length} contacted · ${untouched.length} still to reach`);
  if (untouched.length && c.perDay) {
    const days = Math.ceil(untouched.length / c.perDay);
    console.log(`   runway      ~${days} send-days left at ${c.perDay}/day (${c.sendDays})`);
  }
  console.log(`   today       ${sentToday.length} sent`);
  console.log(`   last ${String(DAYS).padEnd(2)}d    ` +
    (Object.keys(recentBy).length ? Object.entries(recentBy).map(([k, v]) => `${k}=${v}`).join('  ') : 'no events'));

  if (nSent) {
    // Distinguish "nothing was delivered" from "delivery is not being recorded". Printing
    // 0.0% for the second case reads as a catastrophic outage that isn't happening.
    const tracked = nDeliv > 0 || nBounce > 0;
    console.log(`   lifetime    sent ${nSent} · delivered ${tracked ? pct(nDeliv, nSent) : 'not tracked'}` +
                ` · bounced ${tracked ? pct(nBounce, nSent) : 'not tracked'}` +
                ` · clicked ${pct(nClick, nSent)} · replied ${pct(nReply, nSent)} (${nReply})`);
    if (!tracked && nSent >= 10) {
      warnings.push(`${c.label}: ${nSent} sends with no delivery or bounce events recorded — deliverability is unmonitored, so a blocked domain would look identical to a healthy one.`);
    }
  }

  // ── things that need a human ───────────────────────────────────────────────
  if (nSent >= 50 && nBounce / nSent > 0.05) {
    warnings.push(`${c.label}: bounce rate ${pct(nBounce, nSent)} is over the 5% line that gets a sender throttled. Prune unverified addresses before adding volume.`);
  }
  if (noEmail.length) {
    warnings.push(`${c.label}: ${noEmail.length} queued lead(s) have no address and can never send (${pct(noEmail.length, leads.length)} of the list). Run the email hunter or drop them.`);
  }
  if (nSent > 100 && nOpen === 0 && nClick > 0) {
    warnings.push(`${c.label}: ${nClick} clicks but zero open events — open tracking is off at the provider, so engagement is invisible.`);
  }
  // A weekday with no send by evening means the cron did not fire.
  const dow = new Date().toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' });
  const isWeekday = !['Sat', 'Sun'].includes(dow);
  if (isWeekday && sentToday.length === 0 && untouched.length > 0) {
    warnings.push(`${c.label}: nothing sent today (${dow}) despite ${untouched.length} leads ready — check the send workflow ran.`);
  }
  if (untouched.length === 0 && withEmail.length) {
    warnings.push(`${c.label}: every emailable lead has been contacted. The campaign is out of runway — add leads or it goes quiet.`);
  }
}

(async () => {
  const warnings = [];
  console.log(`\n${'='.repeat(66)}`);
  console.log(`DAILY REVIEW · ${new Date().toLocaleString('en-CA', { timeZone: TZ })} PT · window ${DAYS}d`);
  console.log('='.repeat(66));

  for (const c of CAMPAIGNS) {
    try { await review(c, warnings); }
    catch (e) { console.log(`\n── ${c.label}\n   ! ${e.message}`); warnings.push(`${c.label}: review failed — ${e.message}`); }
  }

  console.log(`\n${'─'.repeat(66)}`);
  if (warnings.length) {
    console.log(`NEEDS ATTENTION (${warnings.length})\n`);
    warnings.forEach((w, i) => console.log(`  ${i + 1}. ${w}`));
  } else {
    console.log('NEEDS ATTENTION — nothing. Both campaigns look healthy.');
  }
  console.log(`${'='.repeat(66)}\n`);
})().catch(e => { console.error('review failed:', e.message); process.exit(1); });
