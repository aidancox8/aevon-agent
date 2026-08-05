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
const { isBCHoliday, getVancouverDate } = require('./tempo/sender');

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

/**
 * Read what the queue actually says, not just how many rows it has.
 *
 * Every count in this report looked healthy on the day 372 of 400 queued emails were still
 * pitching a retired offer and quoting a price that no longer applied. Row counts cannot see
 * that. This samples the copy itself and compares it against what the offer is supposed to
 * be, so a prompt change that never reached the backlog shows up the next morning instead of
 * after someone happens to read a sent email.
 */
async function auditQueuedCopy(c, warnings) {
  const rows = await readAll(c.leads, 'status,email,email_body,last_sent_at');
  const queued = rows.filter(l => l.status === 'queued' && l.email && !l.last_sent_at && l.email_body);
  if (queued.length < 20) return;

  // Only OUR retired prices. Matching any dollar figure flagged an email that quoted the
  // prospect's own pricing back to them, which is personalization working, not a defect.
  const priced   = queued.filter(l => /\$\s?1,?500\b|\$\s?150\b|150\s*\/\s*mo/i.test(l.email_body));
  const demo     = queued.filter(l => /90[- ]?second demo|\bwatch a demo\b|reply with ['"]?yes/i.test(l.email_body));
  const untokened = queued.filter(l => !l.email_body.includes('{{ASK}}'));

  const pctOf = n => `${((n / queued.length) * 100).toFixed(0)}%`;
  console.log(`   queue copy  ${queued.length} unsent · ${pctOf(queued.length - untokened.length)} carry the live offer token`);

  if (priced.length) {
    warnings.push(`${c.label}: ${priced.length} queued email(s) quote a price (${pctOf(priced.length)}). The offer is free work, so these contradict it. Run strip-price.js.`);
  }
  if (demo.length) {
    warnings.push(`${c.label}: ${demo.length} queued email(s) still ask people to watch a demo (${pctOf(demo.length)}), which is not the current offer. Run swap-ask.js.`);
  }
  // A large untokenized share means new copy is being written with the offer baked in again,
  // which is exactly how the queue drifted from the offer in the first place.
  if (untokened.length > queued.length * 0.2) {
    warnings.push(`${c.label}: ${untokened.length} queued email(s) (${pctOf(untokened.length)}) have no {{ASK}} token, so they will not pick up an offer change. Run tokenize-asks.js.`);
  }
}

async function review(c, warnings) {
  const leads = await readAll(c.leads, 'status,email,last_sent_at,sequence_step');
  const events = await readAll(c.events, 'event_type,created_at,metadata');

  const withEmail = leads.filter(l => l.email);
  const sent      = leads.filter(l => l.last_sent_at);
  const sentToday = leads.filter(l => l.last_sent_at && ptDay(l.last_sent_at) === TODAY);
  const noEmail   = leads.filter(l => l.status === 'queued' && !l.email);
  const untouched = withEmail.filter(l => !l.last_sent_at && l.status === 'queued');

  const ev = t => events.filter(e => e.event_type === t);
  const recent = events.filter(e => e.created_at >= SINCE);
  const recentBy = recent.reduce((a, e) => { a[e.event_type] = (a[e.event_type] || 0) + 1; return a; }, {});

  const nSent = ev('sent').length, nDeliv = ev('delivered').length;
  const nBounce = ev('bounced').length;
  const nReply = ev('replied').length, nOpen = ev('opened').length;

  // 'clicked' is not an email click. Every one of these is written by the track-visit edge
  // function when someone loads a landing page with ?ref=<leadId>, and carries no
  // resend_email_id. Reporting them as clicks reads as email engagement and understates
  // them: reaching the site is a warmer signal than opening a message.
  const clickEvents = events.filter(e => e.event_type === 'clicked');
  const nVisit = clickEvents.filter(e => (e.metadata || {}).source === 'site-visit').length;
  const nMailClick = clickEvents.length - nVisit;

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
                ` · site visits ${pct(nVisit, nSent)} · replied ${pct(nReply, nSent)} (${nReply})`);
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
  // The Resend webhook delivers 'delivered' and 'bounced' but no open or click events, so
  // email-level engagement is unmeasured. Worth knowing, but not urgent: site visits are
  // tracked independently and are the better signal anyway, which is why this only fires
  // when there is no engagement data of any kind.
  if (nSent > 100 && nOpen === 0 && nMailClick === 0) {
    warnings.push(nVisit > 0
      ? `${c.label}: no open or click events from the email provider (the webhook only carries delivered and bounced). Site visits still tracked (${nVisit}), so this is a gap in email-level detail, not a blind spot.`
      : `${c.label}: no open, click or site-visit data at all — there is no way to tell whether anyone is engaging.`);
  }
  // A weekday with no send by evening means the cron did not fire. Statutory holidays have
  // to be excluded or this cries wolf on every one of them: the senders skip holidays by
  // design, so flagging that as a fault trains you to ignore the warning. Reuses the same
  // holiday table the senders use, rather than a second copy that can drift from it.
  const dow = new Date().toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' });
  const isWeekday = !['Sat', 'Sun'].includes(dow) && !isBCHoliday(getVancouverDate());
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
    try { await review(c, warnings); await auditQueuedCopy(c, warnings); }
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
