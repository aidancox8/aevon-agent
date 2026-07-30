/**
 * tempo/check-bounces.js
 * The Tempo Resend account has no webhook endpoint, so async bounces never
 * reach the database on their own. This polls Resend for the delivery status of
 * every email we sent in the last N days and parks bounced leads.
 *
 * Without this, a hard-bounced address stays `queued` and still receives
 * follow-ups 2 and 3, which is exactly what destroys a new domain's reputation.
 *
 * Usage: node tempo/check-bounces.js [--days 14]
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const axios = require('axios');
const supabase = require('../lib/supabase');

const KEY = process.env.TEMPO_RESEND_API_KEY || process.env.RESEND_API_KEY;
const DAYS = (() => {
  const i = process.argv.indexOf('--days');
  return i > -1 ? parseInt(process.argv[i + 1], 10) : 14;
})();

// Statuses Resend reports that mean "this address is bad, stop sending".
const DEAD = new Set(['bounced', 'failed']);

async function statusOf(id) {
  try {
    const { data } = await axios.get(`https://api.resend.com/emails/${id}`, {
      headers: { Authorization: `Bearer ${KEY}` }, timeout: 15000,
    });
    return (data.last_event || data.status || '').toLowerCase();
  } catch { return null; }
}

async function run() {
  if (!KEY) throw new Error('No Resend key in env.');
  const since = new Date(Date.now() - DAYS * 86400000).toISOString();

  const { data: events, error } = await supabase
    .from('tempo_email_events')
    .select('lead_id, resend_email_id')
    .eq('event_type', 'sent')
    .gte('created_at', since)
    .not('resend_email_id', 'is', null);
  if (error) throw new Error(error.message);

  // This job runs hourly over the same window, so every insert below has to be idempotent.
  // Pull the ids already recorded once, rather than querying per email.
  const { data: known } = await supabase
    .from('tempo_email_events')
    .select('resend_email_id, event_type')
    .in('event_type', ['delivered', 'bounced'])
    .gte('created_at', since);
  const alreadyLogged = new Set((known || []).map(k => `${k.event_type}:${k.resend_email_id}`));

  console.log(`[Tempo] Checking delivery status of ${events.length} email(s) from the last ${DAYS} days...\n`);

  let bounced = 0, opened = 0, checked = 0, delivered = 0;
  for (const ev of events) {
    const st = await statusOf(ev.resend_email_id);
    checked++;
    if (!st) continue;

    // Record delivery, not just failure. Without this the campaign has no delivery rate at
    // all: a silently blocked domain looks identical to a healthy one, because the only
    // signal being stored is the hard bounce. Anything past 'sent' proves it landed.
    if (['delivered', 'opened', 'clicked'].includes(st)
        && !alreadyLogged.has(`delivered:${ev.resend_email_id}`)) {
      await supabase.from('tempo_email_events').insert({
        lead_id: ev.lead_id, resend_email_id: ev.resend_email_id,
        event_type: 'delivered', metadata: { source: 'check-bounces', last_event: st },
      });
      alreadyLogged.add(`delivered:${ev.resend_email_id}`);
      delivered++;
    }

    if (DEAD.has(st)) {
      if (alreadyLogged.has(`bounced:${ev.resend_email_id}`)) continue;
      const { data: lead } = await supabase.from(TABLE_NAME).select('business_name, email').eq('id', ev.lead_id).single();
      await supabase.from(TABLE_NAME).update({
        status: 'bounced',
        scheduled_send_at: null,
        notes: `Hard bounce detected by check-bounces (${st}). No further sends.`,
      }).eq('id', ev.lead_id);
      await supabase.from('tempo_email_events').insert({
        lead_id: ev.lead_id, resend_email_id: ev.resend_email_id,
        event_type: 'bounced', metadata: { source: 'check-bounces', last_event: st },
      });
      alreadyLogged.add(`bounced:${ev.resend_email_id}`);
      bounced++;
      console.log(`  BOUNCED: ${lead?.business_name || ev.lead_id} <${lead?.email || '?'}>`);
    } else if (st === 'opened' || st === 'clicked') {
      await supabase.from(TABLE_NAME).update({ opened_at: new Date().toISOString() }).eq('id', ev.lead_id).is('opened_at', null);
      opened++;
    }
    await new Promise(r => setTimeout(r, 120)); // stay under Resend rate limits
  }

  console.log(`\nDone. Checked: ${checked} | Delivered (new): ${delivered} | Bounced (parked): ${bounced} | Opened/clicked: ${opened}`);
}

const TABLE_NAME = 'tempo_leads';

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
