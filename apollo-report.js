/**
 * apollo-report.js
 * Compares the Apollo cohort (source LIKE 'apollo%') against the scraped-lead baseline
 * on the metrics that matter: real human clicks and genuine replies per send.
 * This is the A/B that decides whether better targeting was the lever.
 *
 * Usage: node apollo-report.js
 */
require('dotenv').config();
const supabase = require('./lib/supabase');

function isBotUa(ua) {
  const u = (ua || '').toLowerCase();
  if (!u) return true;
  if (/x11;\s*linux|headless|bot|crawler|spider|preview|scanner/.test(u)) return true;
  const m = u.match(/chrome\/(\d+)/);
  if (m && parseInt(m[1], 10) < 130) return true;
  return false;
}

// Page through a table so we never rely on a giant IN() or the 1000-row default cap.
async function fetchAll(table, columns, filterFn) {
  const out = [];
  let from = 0;
  const size = 1000;
  for (;;) {
    let q = supabase.from(table).select(columns).range(from, from + size - 1);
    if (filterFn) q = filterFn(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < size) break;
    from += size;
  }
  return out;
}

function statsFor(bucket) {
  const s = bucket.sent.size;
  return {
    label: bucket.label, sent: s,
    human_clicks: bucket.click.size,
    genuine_replies: bucket.reply.size,
    reply_pct: s ? +(100 * bucket.reply.size / s).toFixed(2) : 0,
    click_pct: s ? +(100 * bucket.click.size / s).toFixed(2) : 0,
  };
}

async function run() {
  // Which lead ids are the Apollo cohort.
  const apolloLeads = await fetchAll('leads', 'id', q => q.like('source', 'apollo%'));
  const apolloSet = new Set(apolloLeads.map(r => r.id));
  console.log(`\nApollo cohort: ${apolloSet.size} leads | Baseline: everyone else\n`);

  const events = await fetchAll('email_events', 'lead_id, event_type, metadata',
    q => q.in('event_type', ['sent', 'clicked', 'replied', 'interested']).not('lead_id', 'is', null));

  const mk = label => ({ label, sent: new Set(), click: new Set(), reply: new Set() });
  const apollo = mk('Apollo (verified decision-makers)');
  const base = mk('Baseline (scraped)');

  for (const e of events) {
    const b = apolloSet.has(e.lead_id) ? apollo : base;
    if (e.event_type === 'sent') b.sent.add(e.lead_id);
    else if (e.event_type === 'interested') b.reply.add(e.lead_id);
    else if (e.event_type === 'replied' && e.metadata?.intent && !/auto_reply/.test(e.metadata.intent)) b.reply.add(e.lead_id);
    else if (e.event_type === 'clicked' && !isBotUa(e.metadata?.ua)) b.click.add(e.lead_id);
  }

  console.log('=== Apollo cohort vs scraped baseline ===');
  console.table([statsFor(apollo), statsFor(base)]);
  console.log('Read: if Apollo reply_pct clearly beats baseline, targeting was the lever -> scale it.');
  console.log('If both near 0 after a fair sample (~100+ sent), targeting was NOT the problem -> the offer/channel is.');
}
run().catch(e => { console.error(e.message); process.exit(1); });
