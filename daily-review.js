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
 *   1. An unpaged Supabase select truncates. Measured on this project the ceiling is 5,000
 *      rows (not the 1,000 this comment used to claim), and the leads table is at 9,082, so
 *      every read here pages to the end or the rates come out of a fraction of the list.
 *   2. There is no 'sent' status. The sender writes last_sent_at and leaves the lead
 *      'queued' so it stays eligible for follow-ups. Counting status='sent' finds nothing
 *      and makes the bounce rate look catastrophic.
 */
const supabase = require('./lib/supabase');
const { isBCHoliday, getVancouverDate } = require('./tempo/sender');
const { classifyVisits } = require('./lib/visit-quality');
const { isWorthSending, isActiveSegment } = require('./lib/segments');
const { autoresponderReason } = require('./reply-processor');

/**
 * Was this 'replied' event written by a person?
 *
 * 26 of the first 40 recorded replies were out-of-office notices, so the raw count runs about
 * three times high and points the wrong way on which industries respond: healthcare read as a
 * 1.83% responder on the raw count when not one human there has ever written back.
 *
 * Two filters, because neither is enough alone. The stored intent misses replies classified
 * before the autoresponder gate existed, five of which are still labelled 'referral' or
 * 'other' while carrying the subject "Automatic reply:". Re-running the gate catches those.
 */
function isHumanReply(e) {
  const m = e.metadata || {};
  if (m.intent === 'auto_reply') return false;
  return !autoresponderReason(m.subject, m.body || m.snippet || '');
}

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
  // perDay must track the DAILY_CAP secret (40) or the runway estimate lies. segmented=true
  // means new sequences only start in the industries that have replied, so the runway has to
  // count those leads and not the whole queue.
  { label: 'AEVON', sub: 'AI consulting',     leads: 'leads',       events: 'email_events',       perDay: 40, sendDays: 'Mon-Fri', segmented: true },
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
  const leads = await readAll(c.leads, 'id,business_name,status,email,last_sent_at,sequence_step,industry,email_quality');
  const events = await readAll(c.events, 'event_type,created_at,metadata,lead_id');

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
  const replyEvents = ev('replied');
  const humanReplies = replyEvents.filter(isHumanReply);
  const nReply = humanReplies.length, nOpen = ev('opened').length;
  const nAutoReply = replyEvents.length - nReply;

  // 'clicked' is not an email click. Every one of these is written by the track-visit edge
  // function when someone loads a landing page with ?ref=<leadId>, and carries no
  // resend_email_id. Reporting them as clicks reads as email engagement and understates
  // them: reaching the site is a warmer signal than opening a message.
  const clickEvents = events.filter(e => e.event_type === 'clicked');
  const nVisit = clickEvents.filter(e => (e.metadata || {}).source === 'site-visit').length;
  const nMailClick = clickEvents.length - nVisit;

  // Roughly half of recorded visits are corporate mail filters fetching the link before the
  // recipient sees the email. Reporting the raw count as engagement doubles the apparent
  // interest and, worse, would put businesses on a warm list who never looked at anything.
  const visitsByLead = {};
  clickEvents.forEach(e => { (visitsByLead[e.lead_id] = visitsByLead[e.lead_id] || []).push(e); });
  const sentByLead = {};
  events.filter(e => e.event_type === 'sent').forEach(e => {
    (sentByLead[e.lead_id] = sentByLead[e.lead_id] || []).push(e.created_at);
  });
  const firstSentByLead = {};
  events.filter(e => e.event_type === 'sent').forEach(e => {
    if (!firstSentByLead[e.lead_id] || e.created_at < firstSentByLead[e.lead_id]) {
      firstSentByLead[e.lead_id] = e.created_at;
    }
  });
  const humanVisitors = Object.entries(visitsByLead)
    .filter(([id, vs]) => classifyVisits(vs, firstSentByLead[id]).human);

  console.log(`\n── ${c.label}  (${c.sub}) ${'─'.repeat(Math.max(0, 34 - c.sub.length))}`);
  console.log(`   list        ${leads.length} leads · ${withEmail.length} with email · ${leads.length - withEmail.length} without`);
  console.log(`   progress    ${sent.length} contacted · ${untouched.length} still to reach`);

  // Runway must count only leads the sender will actually pick up. Measuring it against the
  // whole queue overstated it by more than double once the paused industries were excluded,
  // which is exactly the kind of comfortable number that hides an imminent dry campaign.
  const reachable = c.segmented ? untouched.filter(isWorthSending) : untouched;
  if (reachable.length && c.perDay) {
    const days = Math.ceil(reachable.length / c.perDay);
    const note = c.segmented && reachable.length !== untouched.length
      ? ` · ${untouched.length - reachable.length} more in paused industries or on generic addresses`
      : '';
    console.log(`   runway      ~${days} send-days left at ${c.perDay}/day (${c.sendDays})${note}`);
  }
  if (c.segmented && reachable.length && reachable.length < c.perDay * 10) {
    warnings.push(`${c.label}: only ${reachable.length} leads left in the industries that reply (~${Math.ceil(reachable.length / c.perDay)} send-days). Find more in financial/professional, legal, marketing or real estate before it goes quiet.`);
  }
  if (c.segmented && reachable.length === 0 && untouched.length) {
    warnings.push(`${c.label}: no leads left in any industry that has ever replied, though ${untouched.length} remain in paused ones. Either add leads or reconsider the segment filter in lib/segments.js.`);
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
                ` · real visitors ${humanVisitors.length} of ${Object.keys(visitsByLead).length} (rest are mail scanners)` +
                ` · replied ${pct(nReply, nSent)} (${nReply} human${nAutoReply ? `, ${nAutoReply} auto` : ''})`);
    if (!tracked && nSent >= 10) {
      warnings.push(`${c.label}: ${nSent} sends with no delivery or bounce events recorded — deliverability is unmonitored, so a blocked domain would look identical to a healthy one.`);
    }
  }

  // ── things that need a human ───────────────────────────────────────────────
  if (nSent >= 50 && nBounce / nSent > 0.05) {
    warnings.push(`${c.label}: bounce rate ${pct(nBounce, nSent)} is over the 5% line that gets a sender throttled. Prune unverified addresses before adding volume.`);
  }
  if (noEmail.length) {
    // Split the count, because only part of it is worth acting on. Enriching a lead in a
    // paused industry buys nothing: the sender would skip it even with an address.
    const worth = c.segmented ? noEmail.filter(l => isActiveSegment(l.industry)).length : noEmail.length;
    const detail = c.segmented && worth !== noEmail.length
      ? ` ${worth} are in live segments and worth enriching (roughly doubling the sendable list); the other ${noEmail.length - worth} are in paused industries, so finding their addresses buys nothing.`
      : '';
    warnings.push(`${c.label}: ${noEmail.length} queued lead(s) have no address and can never send (${pct(noEmail.length, leads.length)} of the list).${detail || ' Run the email hunter or drop them.'}`);
  }
  // The Resend webhook delivers 'delivered' and 'bounced' but no open or click events, so
  // email-level engagement is unmeasured. Worth knowing, but not urgent: site visits are
  // tracked independently and are the better signal anyway, which is why this only fires
  // when there is no engagement data of any kind.
  if (nSent > 100 && nOpen === 0 && nMailClick === 0) {
    warnings.push(nVisit > 0
      ? `${c.label}: no open or click events from the email provider (the webhook only carries delivered and bounced). Real visitors still tracked (${humanVisitors.length}), so this is a gap in email-level detail, not a blind spot.`
      : `${c.label}: no open, click or site-visit data at all — there is no way to tell whether anyone is engaging.`);
  }
  // A weekday with no send by evening means the cron did not fire. Two things have to be
  // excluded or this cries wolf and trains you to ignore it.
  //
  // Statutory holidays: the senders skip them by design. Reuses the same holiday table they
  // use rather than a second copy that can drift from it.
  //
  // Time of day: this warning is written for the 6:05pm PT digest, but the script gets run by
  // hand at any hour, and before the first send of the day "nothing sent" is just true rather
  // than wrong. GitHub's scheduler is also badly unpunctual here. send-outreach is cron'd
  // hourly from 16:00 UTC, but across two weeks the 16:00 run has never once fired and the
  // first run of the day lands between 17:21 and 17:43 UTC, with only 5 of the 8 scheduled
  // runs happening at all. Noon PT clears that drift with room to spare.
  const FIRST_SEND_EXPECTED_BY_PT = 12;
  const dow = new Date().toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' });
  const hourPT = parseInt(new Date().toLocaleString('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }), 10);
  const isWeekday = !['Sat', 'Sun'].includes(dow) && !isBCHoliday(getVancouverDate());
  if (isWeekday && sentToday.length === 0 && untouched.length > 0) {
    if (hourPT >= FIRST_SEND_EXPECTED_BY_PT) {
      warnings.push(`${c.label}: nothing sent today (${dow}) despite ${untouched.length} leads ready — check the send workflow ran.`);
    } else {
      console.log(`   note        nothing sent yet, but it is only ${hourPT}:00 PT and the first run usually lands ~10:30. Not flagged.`);
    }
  }
  if (untouched.length === 0 && withEmail.length) {
    warnings.push(`${c.label}: every emailable lead has been contacted. The campaign is out of runway — add leads or it goes quiet.`);
  }

  // ── warm signals: real people who came to the site ────────────────────────
  //
  // These were falling on the floor. signals-digest.js only reports repeat visitors, 2+
  // genuine sessions, so a single real visit is invisible to every report we have. Arctic
  // Sunshine Movers finished the whole 3-email sequence, was marked dont_contact, and then
  // loaded the site six hours after the final email. Nothing would ever have surfaced them.
  //
  // A human who clicks through is the warmest thing this machine produces, and the ones whose
  // sequence has ended are the only leads nobody will contact again. They are listed first
  // because they are the ones that need a decision rather than patience.
  const byId = Object.fromEntries(leads.filter(l => l.id).map(l => [l.id, l]));
  const warm = humanVisitors
    .map(([id, vs]) => ({ lead: byId[id], cls: classifyVisits(vs, firstSentByLead[id]),
                          last: vs.map(v => v.created_at).sort().slice(-1)[0] }))
    .filter(w => w.lead)
    .sort((a, b) => String(b.last).localeCompare(String(a.last)));

  // "Nobody will contact them again" stops being true the moment somebody does. Nine of these
  // were emailed by hand on 2026-08-09, outside the queue, which left their status and
  // sequence_step untouched, so a status-only test kept naming people already actioned and the
  // warning would have nagged forever. Anyone with a send AFTER their most recent visit has
  // been answered, however that send happened.
  const lastSentAfterVisit = (id, lastVisit) => sentByLead[id]
    && sentByLead[id].some(t => t > lastVisit);
  const finished = warm.filter(w =>
    (w.lead.status === 'dont_contact' || w.lead.sequence_step >= 3)
    && !lastSentAfterVisit(w.lead.id, w.last));
  if (warm.length) {
    console.log(`   warm        ${warm.length} real visitor(s)${finished.length ? `, ${finished.length} whose sequence has ended` : ''}`);
    warm.slice(0, 5).forEach(w => {
      const done = w.lead.status === 'dont_contact' || w.lead.sequence_step >= 3;
      console.log(`               ${done ? '!' : ' '} ${String(w.lead.business_name || '').slice(0, 34).padEnd(36)}`
        + `${String(w.last).slice(0, 10)}  ${w.cls.reasons.join('; ')}`);
    });
  }
  if (finished.length) {
    warnings.push(`${c.label}: ${finished.length} real visitor(s) finished the sequence and will never be contacted again — ${finished.slice(0, 3).map(w => w.lead.business_name).join(', ')}. They came to the site after the last email, so this is the warmest signal available and nothing is set up to act on it.`);
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
