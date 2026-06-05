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
  return /x11;\s*linux|headless|bot|crawler|spider|python-requests|curl|wget|preview|scanner/.test(u);
}

function vancouverTime(iso) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Vancouver', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(iso));
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

  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const repeats = [];
  for (const [leadId, g] of byLead) {
    const sessions = countSessions(g.visits);
    if (sessions < 2) continue;
    const last = Math.max(...g.visits.map(t => new Date(t).getTime()));
    if (last < dayAgo) continue; // only surface leads who came back recently
    repeats.push({ leadId, lead: g.lead || {}, count: sessions, last });
  }

  if (repeats.length === 0) {
    console.log('No repeat visitors today. No email sent.');
    return;
  }

  repeats.sort((a, b) => b.count - a.count || b.last - a.last);

  const lines = repeats.map(r => {
    const L = r.lead || {};
    const name = L.business_name || '(unknown business)';
    const site = L.website ? ` | ${L.website}` : '';
    const ind = L.industry ? ` [${L.industry}]` : '';
    return `• ${name}${ind}\n    ${L.email || 'no email'}${site}\n    ${r.count} visits, last ${vancouverTime(new Date(r.last).toISOString())}`;
  });

  const text = [
    `${repeats.length} lead${repeats.length > 1 ? 's' : ''} came back to the demo today (2+ visits). These are your warmest signals.`,
    '',
    ...lines,
    '',
    'A repeat visit means they looked, left, and came back. Worth a thoughtful, well-timed follow-up. Do NOT reference the visit (you only know via tracking) and do not over-chase a single return.',
  ].join('\n');

  const { error: sendErr } = await resend.emails.send({
    from: `${FROM_NAME} <${FROM}>`,
    reply_to: TO,
    to: TO,
    subject: `[Aevon SIGNAL] ${repeats.length} repeat visitor${repeats.length > 1 ? 's' : ''} today`,
    text,
  });
  if (sendErr) throw new Error(`send digest failed: ${sendErr.message}`);
  console.log(`Sent repeat-visitor digest: ${repeats.length} lead(s).`);
}

run().catch(err => { console.error(err); process.exit(1); });
