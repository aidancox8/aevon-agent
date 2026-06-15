/**
 * repeat-visitors.js
 * Finds leads who have visited a landing page MORE THAN ONCE (a genuine buy
 * signal) and emails a single end-of-day digest to aidan@aevon.ca. Runs once
 * daily (~5pm PT). Sends nothing when there are no repeat visitors.
 *
 * A visit is a 'clicked' event logged by the track-visit edge function (already
 * deduped at 30 min). We additionally drop obvious email-security scanners
 * (they pre-fetch links with a Linux/headless UA right after send), then alert
 * on any lead with 2+ genuine visits whose most recent visit was in the last
 * day — so a lead only re-alerts when they actually come back again.
 */

require('dotenv').config();
const { Resend } = require('resend');
const supabase = require('./lib/supabase');

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.FROM_EMAIL || 'onboarding@resend.dev';
const FROM_NAME = 'Aidan from Aevon';
const TO = 'aidan@aevon.ca';

// Scanner/bot user agents to ignore. Real prospects on these SMB demos are on
// Windows / macOS / iOS / Android; the pre-fetch scanners use desktop Linux or
// announce themselves as headless/bots.
function isBotUa(ua) {
  const u = (ua || '').toLowerCase();
  if (!u) return true; // no UA at all -> not a real browser visit
  if (/x11;\s*linux|headless|bot|crawler|spider|python-requests|curl|wget|preview|scanner/.test(u)) return true;
  // Email-security gateways re-scan links with spoofed, OUTDATED browser UAs
  // (observed: Chrome 79/117/124 rotating hourly). Real visitors run current
  // builds. Treat anything older than Chrome 130 as a scanner.
  const m = u.match(/chrome\/(\d+)/);
  if (m && parseInt(m[1], 10) < 130) return true;
  return false;
}

function vancouverTime(iso) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Vancouver', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(iso));
}

// ---- Open-tracking deliverability watch ----
// Open tracking (pixel) was enabled 2026-06-11. Its only real risk is landing mail
// in spam, which the send API CANNOT see directly (spam-foldered mail still counts
// as "delivered"). The one hard negative signal we can watch is the spam-complaint
// rate. Baseline before the pixel: 0 complaints / 588 sent, 88.8% delivered, 6.5%
// bounce. We compare the post-pixel cohort and alert if complaints appear.
const OPEN_TRACKING_SINCE = '2026-06-12T07:00:00Z'; // start of 2026-06-12 PT, first full post-pixel day
const BASELINE = { deliveryPct: 88.8, bouncePct: 6.5, complaintPct: 0 };

async function deliverabilityHealth() {
  const { data } = await supabase
    .from('email_events')
    .select('event_type')
    .in('event_type', ['sent', 'delivered', 'bounced', 'complained', 'opened'])
    .gte('created_at', OPEN_TRACKING_SINCE);
  const c = { sent: 0, delivered: 0, bounced: 0, complained: 0, opened: 0 };
  (data || []).forEach(e => { if (c[e.event_type] !== undefined) c[e.event_type]++; });
  if (c.sent < 50) {
    return { line: `Deliverability (open-tracking watch): only ${c.sent} sent since the pixel went on, too few to judge yet.`, alert: false };
  }
  const deliveryPct = +(100 * c.delivered / c.sent).toFixed(1);
  const bouncePct = +(100 * c.bounced / c.sent).toFixed(1);
  const complaintPct = +(100 * c.complained / c.sent).toFixed(3);
  const openPct = +(100 * c.opened / Math.max(c.delivered, 1)).toFixed(1);
  // The pixel's harm shows as spam complaints. >0.1% is the industry danger line.
  const alert = complaintPct > 0.1;
  const verdict = alert
    ? `>> ALERT: spam complaints at ${complaintPct}% (baseline 0%). The open-tracking pixel is likely hurting inbox placement. TURN OPEN TRACKING OFF in Resend (Domains > aevon.ca > disable Open Tracking).`
    : `Complaints ${complaintPct}% (baseline 0). No deliverability harm detected from the pixel.`;
  // Open tracking was unproven as of 2026-06-14 (a self-send test never produced an
  // open). This is the first real read: 0% on a meaningful delivered count means the
  // pixel is NOT working (Resend plan/config); a normal rate means it finally works.
  const openVerdict = c.opened === 0
    ? `OPENS: 0 of ${c.delivered} delivered. Open tracking is NOT recording. Likely a Resend plan/config issue, do not rely on open data.`
    : `OPENS: ${openPct}% (${c.opened}/${c.delivered}). Open tracking is working. (Apple Mail inflates this, treat as directional.)`;
  const line = [
    `Deliverability (open-tracking watch, ${c.sent} sent since pixel):`,
    `  delivered ${deliveryPct}% (baseline ${BASELINE.deliveryPct}) | bounce ${bouncePct}% (baseline ${BASELINE.bouncePct}) | complaints ${complaintPct}% (baseline 0)`,
    `  ${openVerdict}`,
    `  ${verdict}`,
  ].join('\n');
  return { line, alert, alertText: verdict };
}

async function run() {
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const { data: events, error } = await supabase
    .from('email_events')
    .select('lead_id, created_at, metadata, leads(business_name, email, website, industry)')
    .eq('event_type', 'clicked')
    .gte('created_at', since)
    .not('lead_id', 'is', null);
  if (error) throw new Error(`fetch clicked events failed: ${error.message}`);

  // Group genuine visits per lead.
  const byLead = new Map();
  for (const ev of events || []) {
    if (isBotUa(ev.metadata?.ua)) continue;
    const g = byLead.get(ev.lead_id) || { lead: ev.leads, visits: [] };
    g.lead = g.lead || ev.leads;
    g.visits.push(ev.created_at);
    byLead.set(ev.lead_id, g);
  }

  // Collapse events less than 30 min apart into one visit, so a double-logged
  // hit (same session) counts once and "2+ visits" means separate sessions.
  const GAP_MS = 30 * 60 * 1000;
  function countSessions(times) {
    const sorted = times.map(t => new Date(t).getTime()).sort((a, b) => a - b);
    let sessions = 0, prev = -Infinity;
    for (const t of sorted) {
      if (t - prev > GAP_MS) sessions++;
      prev = t;
    }
    return sessions;
  }

  // Hot leads we alert on at FIRST visit, not just repeats (warm conversations
  // where the user sent a tailored link and wants to know the moment it's opened).
  const WATCHLIST = [
    '9a3d60b0-874b-4347-b232-1e351b0e0c03', // Jean Seguin / Vancouver Business Brokers
    '23260e23-b1e3-4deb-9b69-582c92d2be2a', // Restaurant Business Broker (also Jean)
  ];

  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const repeats = [];
  for (const [leadId, g] of byLead) {
    const sessions = countSessions(g.visits);
    const last = Math.max(...g.visits.map(t => new Date(t).getTime()));
    if (last < dayAgo) continue; // only surface recent activity
    const watched = WATCHLIST.includes(leadId);
    if (sessions < 2 && !watched) continue;
    repeats.push({ leadId, lead: g.lead || {}, count: sessions, last, watched });
  }

  repeats.sort((a, b) => (b.watched ? 1 : 0) - (a.watched ? 1 : 0) || b.count - a.count || b.last - a.last);
  const lines = repeats.map(r => {
    const L = r.lead || {};
    const name = L.business_name || '(unknown business)';
    const site = L.website ? ` | ${L.website}` : '';
    const ind = L.industry ? ` [${L.industry}]` : '';
    const tag = r.watched ? '★ WATCHED LEAD · ' : '';
    return `• ${tag}${name}${ind}\n    ${L.email || 'no email'}${site}\n    ${r.count} visit${r.count > 1 ? 's' : ''}, last ${vancouverTime(new Date(r.last).toISOString())}`;
  });

  // Explicit "I'm interested" button clicks in the last day — the strongest
  // signal short of a reply. Listed first; includes any note they left.
  const { data: intEvents } = await supabase
    .from('email_events')
    .select('created_at, metadata, leads(business_name, email, website, industry)')
    .eq('event_type', 'interested')
    .gte('created_at', new Date(dayAgo).toISOString())
    .order('created_at', { ascending: false });
  const interested = intEvents || [];

  // Deliverability health (open-tracking pixel watch). Runs every day; can force an
  // alert email on its own even when there are no warm signals.
  const deliver = await deliverabilityHealth();

  if (repeats.length === 0 && interested.length === 0) {
    if (deliver.alert) {
      await resend.emails.send({
        from: `${FROM_NAME} <${FROM}>`, reply_to: TO, to: TO,
        subject: '[Aevon ALERT] open-tracking hurting deliverability',
        text: deliver.line + '\n\nNo warm signals today.',
      });
      console.log('No warm signals, but deliverability ALERT sent.');
      return;
    }
    console.log('No warm signals today. No email sent.');
    return;
  }

  const out = [];
  if (interested.length) {
    out.push(`${interested.length} lead${interested.length > 1 ? 's' : ''} clicked "I'm interested" today. Reach out to these first.`, '');
    interested.forEach(ev => {
      const L = ev.leads || {};
      const name = L.business_name || '(unknown business)';
      const note = ev.metadata && ev.metadata.note ? `\n    note: "${ev.metadata.note}"` : '';
      out.push(`★ ${name}${L.industry ? ` [${L.industry}]` : ''}\n    ${L.email || 'no email'}${L.website ? ` | ${L.website}` : ''}${note}\n    clicked ${vancouverTime(ev.created_at)}`);
    });
    out.push('');
  }
  if (repeats.length) {
    out.push(`${repeats.length} lead${repeats.length > 1 ? 's' : ''} came back to the demo today (2+ visits).`, '', ...lines, '',
      'A repeat visit means they looked, left, and came back. Worth a thoughtful follow-up. Do NOT reference the tracking, and do not over-chase a single return.');
  }

  // Always append the deliverability health line to the daily digest.
  out.push('', '----------', deliver.line);

  const subjBits = [];
  if (interested.length) subjBits.push(`${interested.length} interested`);
  if (repeats.length) subjBits.push(`${repeats.length} repeat visitor${repeats.length > 1 ? 's' : ''}`);
  if (deliver.alert) subjBits.push('DELIVERABILITY ALERT');

  const { error: sendErr } = await resend.emails.send({
    from: `${FROM_NAME} <${FROM}>`,
    reply_to: TO,
    to: TO,
    subject: `[Aevon SIGNAL] ${subjBits.join(' + ')}`,
    text: out.join('\n'),
  });
  if (sendErr) throw new Error(`send digest failed: ${sendErr.message}`);
  console.log(`Sent signal digest: ${interested.length} interested, ${repeats.length} repeat.`);
}

run().catch(err => { console.error(err); process.exit(1); });
