/**
 * signals-digest.js
 * Writes signals/latest.md: a digest of genuine warm signals (interested clicks,
 * watchlist visits, repeat visitors, complaints) for the Claude cloud routine to
 * read via raw.githubusercontent.com. Replaces the retired [Aevon SIGNAL] email
 * (repeat-visitors.js) because the routine's sandbox cannot reach supabase.co
 * directly. Sends NOTHING; the workflow commits the file.
 *
 * Window: last 24h, widened to 72h on Mondays so Friday-afternoon activity
 * is not lost over the weekend.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const supabase = require('./lib/supabase');

// Hot leads reported at FIRST genuine visit, not just repeats.
// Vickers (f424365f) declined 2026-07-17; removed so a stray re-view no longer
// headlines the briefing. Re-add a lead id here only while it is warm.
const WATCHLIST = {
  '9a3d60b0-874b-4347-b232-1e351b0e0c03': 'Jean Seguin / Vancouver Business Brokers',
  '23260e23-b1e3-4deb-9b69-582c92d2be2a': 'Restaurant Business Broker (Jean)',
};

function isBotUa(ua) {
  const u = (ua || '').toLowerCase();
  if (!u) return true;
  if (/x11;\s*linux|headless|bot|crawler|spider|python-requests|curl|wget|preview|scanner/.test(u)) return true;
  const m = u.match(/chrome\/(\d+)/);
  if (m && parseInt(m[1], 10) < 130) return true;
  return false;
}

function uaFamily(ua) {
  const u = (ua || '').toLowerCase();
  if (/iphone|ipad/.test(u)) return 'ios';
  if (/android/.test(u)) return 'android';
  if (/edge?\//.test(u)) return 'edge';
  if (/macintosh/.test(u)) return 'mac';
  if (/windows/.test(u)) return 'windows';
  return 'other';
}

function vancouverTime(iso) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Vancouver', weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(iso));
}

async function run() {
  const now = new Date();
  // Monday in Vancouver -> 72h window to cover the weekend + Friday afternoon.
  const vanDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', weekday: 'short' }).format(now);
  const windowH = vanDay === 'Mon' ? 72 : 24;
  const since = new Date(now.getTime() - windowH * 3600 * 1000).toISOString();

  const { data: events, error } = await supabase
    .from('email_events')
    .select('lead_id, event_type, created_at, metadata, leads(business_name, email, website, industry)')
    .in('event_type', ['clicked', 'interested', 'complained', 'sent'])
    .gte('created_at', since);
  if (error) throw new Error(`fetch events failed: ${error.message}`);

  const sentAt = new Map(); // lead_id -> [ms]
  for (const ev of events || []) {
    if (ev.event_type !== 'sent' || !ev.lead_id) continue;
    const arr = sentAt.get(ev.lead_id) || [];
    arr.push(new Date(ev.created_at).getTime());
    sentAt.set(ev.lead_id, arr);
  }

  // Genuine clicks: bot-UA filter + not within 10 min after that lead's own send.
  const byLead = new Map();
  for (const ev of events || []) {
    if (ev.event_type !== 'clicked' || !ev.lead_id) continue;
    if (isBotUa(ev.metadata?.ua)) continue;
    const t = new Date(ev.created_at).getTime();
    if ((sentAt.get(ev.lead_id) || []).some(s => t >= s && t - s < 10 * 60 * 1000)) continue;
    const g = byLead.get(ev.lead_id) || { lead: ev.leads, visits: [], uas: [] };
    g.lead = g.lead || ev.leads;
    g.visits.push(t);
    g.uas.push(ev.metadata?.ua || '');
    byLead.set(ev.lead_id, g);
  }

  // Scanner-burst: 3+ device families for one lead in the window = gateway, drop.
  for (const [leadId, g] of [...byLead]) {
    if (new Set(g.uas.map(uaFamily)).size >= 3) byLead.delete(leadId);
  }

  // Collapse hits <30 min apart into one session.
  const GAP = 30 * 60 * 1000;
  function sessions(times) {
    const s = [...times].sort((a, b) => a - b);
    let n = 0, prev = -Infinity;
    for (const t of s) { if (t - prev > GAP) n++; prev = t; }
    return n;
  }

  const interested = (events || []).filter(e => e.event_type === 'interested');
  const complained = (events || []).filter(e => e.event_type === 'complained');

  const watch = [], repeats = [];
  for (const [leadId, g] of byLead) {
    const n = sessions(g.visits);
    const last = Math.max(...g.visits);
    const L = g.lead || {};
    const row = { name: L.business_name || '(unknown)', email: L.email || '', industry: L.industry || '', n, last };
    if (WATCHLIST[leadId]) watch.push({ ...row, label: WATCHLIST[leadId] });
    else if (n >= 2) repeats.push(row);
  }
  repeats.sort((a, b) => b.n - a.n || b.last - a.last);

  const out = [];
  out.push(`# Aevon warm signals`);
  out.push(`generated_at: ${now.toISOString()}`);
  out.push(`window_hours: ${windowH}`);
  out.push('');
  if (complained.length) {
    out.push(`## DELIVERABILITY ALARM`);
    out.push(`${complained.length} spam complaint(s) in the window. Investigate before sending more.`);
    out.push('');
  }
  out.push(`## Watchlist activity (Vickers / Jean)`);
  if (watch.length) {
    watch.forEach(w => out.push(`- ${w.label}: ${w.n} genuine visit session(s), last ${vancouverTime(new Date(w.last).toISOString())}`));
  } else out.push('- none');
  out.push('');
  out.push(`## "I'm interested" clicks`);
  if (interested.length) {
    interested.forEach(ev => {
      const L = ev.leads || {};
      const note = ev.metadata?.note ? ` | note: "${ev.metadata.note}"` : '';
      out.push(`- ${L.business_name || '(unknown)'} <${L.email || ''}>${L.industry ? ` [${L.industry}]` : ''} at ${vancouverTime(ev.created_at)}${note}`);
    });
  } else out.push('- none');
  out.push('');
  out.push(`## Repeat visitors (2+ genuine sessions)`);
  if (repeats.length) {
    repeats.forEach(r => out.push(`- ${r.name} <${r.email}>${r.industry ? ` [${r.industry}]` : ''}: ${r.n} sessions, last ${vancouverTime(new Date(r.last).toISOString())}`));
  } else out.push('- none');
  out.push('');
  out.push('Bot filtering already applied (Linux/headless UAs, Chrome <130, clicks <10 min after send, 3+ device families = scanner). Never reference tracking when following up.');

  const dir = path.join(__dirname, 'signals');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'latest.md'), out.join('\n') + '\n');
  console.log(`Wrote signals/latest.md: ${watch.length} watchlist, ${interested.length} interested, ${repeats.length} repeat, ${complained.length} complaints (${windowH}h window).`);
}

run().catch(err => { console.error(err); process.exit(1); });
