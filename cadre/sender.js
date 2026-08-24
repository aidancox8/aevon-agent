#!/usr/bin/env node
/**
 * cadre/sender.js — the Cadre (HR / credentials) sender.
 *
 * Third campaign, same shape as sender.js (Aevon) and tempo/sender.js (Tempo), so the three
 * can be compared honestly in the daily review. Everything learned on the other two is carried
 * over rather than rediscovered:
 *
 *  - PLAIN TEXT ONLY, no html part. Proven by seed test 2026-08-18: the identical message
 *    reached the inbox as plain text and was spam-foldered by Gmail and QUARANTINED AS PHISHING
 *    by Microsoft as HTML, because the signature stacked anchor text that disagreed with its
 *    href plus a remote image. Guarded permanently by check-email-shape.js.
 *  - Bounce breaker. Halts above 5%, because a bad list damages the sending domain for every
 *    campaign, not just this one.
 *  - Excluded-org gate on every send, not just at intake. Changepain sat queued in tempo_leads
 *    and received two emails before anyone noticed.
 *  - Off-domain and freemail address guard. The email hunter has picked up Google Fonts author
 *    addresses out of a stylesheet and a US telecom's address for a BC lab.
 *  - Retired-copy guard. Stored copy has outlived three offer decisions on the Aevon side.
 *
 * Two things are deliberately different here.
 *
 * DAILY CAP IS TINY. Aevon ran at 85/day into a scraped list and produced zero meetings across
 * 3,506 sends. This list is signal-qualified and hand-checked, so the constraint is not volume,
 * it is whether the argument works. 5 a day makes every reply legible.
 *
 * A SIGNAL QUOTE IS MANDATORY. The premise of the campaign is quoting the prospect's own
 * published words back to them. A lead whose quote is missing, or whose copy does not actually
 * contain the quote, is not sendable. That is checked here, not assumed.
 *
 *   node cadre/sender.js              dry run
 *   node cadre/sender.js --send       send for real
 *   node cadre/sender.js --limit 3    cap this run
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Resend } = require('resend');
const supabase = require('../lib/supabase');
const { excludedOrgReason } = require('../tempo/dnc');

const TABLE = 'cadre_leads';
const EVENTS = 'cadre_email_events';
const resend = new Resend(process.env.RESEND_API_KEY);

const FROM = process.env.FROM_EMAIL || 'aidan@aevon.ca';
const FROM_NAME = 'Aidan Cox';
const REPLY_TO = 'aidan@aevon.ca';

const IS_CI = !!process.env.GITHUB_ACTIONS;
const LIVE = IS_CI || process.argv.includes('--send');
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  return i > -1 ? parseInt(process.argv[i + 1], 10) : null;
})();

/** Deliberately small. See the header: the constraint is the argument, not the volume. */
const DAILY_CAP = parseInt(process.env.CADRE_DAILY_CAP || '5', 10);
const BOUNCE_LIMIT = 0.05;
const BOUNCE_WINDOW = 100;

const FREEMAIL = /@(gmail|hotmail|outlook|yahoo|icloud|live|aol|proton|gmx)\./i;
const PLACEHOLDER = /^(your|email|name|test|example|info@example)/i;

const FOOTER = [
  '',
  '--',
  'Aidan Cox',
  'Aevon, Vancouver BC',
  'Staff records, training and credentials in one system. Runs daily at a 75 staff clinic in BC.',
  'aevon.ca',
  '',
  'Not relevant? Reply with a no and I will not email again.',
].join('\n');

const rootDomain = h => String(h || '').replace(/^https?:\/\//, '').replace(/^www\./, '')
  .split('/')[0].toLowerCase().split('.').slice(-2).join('.');

/**
 * Every reason a lead must not be sent to, checked at send time rather than trusted from
 * intake. Each of these corresponds to something that actually went wrong on another campaign.
 */
function blockReason(lead) {
  if (!lead.email) return 'no address';
  if (PLACEHOLDER.test(lead.email)) return 'placeholder address';
  if (FREEMAIL.test(lead.email)) return 'freemail address, likely a scraping artifact';
  if (lead.website && rootDomain(lead.email.split('@')[1]) !== rootDomain(lead.website)) {
    return `address domain does not match ${rootDomain(lead.website)}`;
  }
  const org = excludedOrgReason(lead.business_name, lead.email);
  if (org) return org;

  if (!lead.signal_quote || lead.signal_quote.trim().length < 20) return 'no signal quote';
  if (!lead.email_subject || !lead.email_body) return 'no copy written';

  // The campaign's whole premise. If the body does not carry their own words, this is just
  // another cold email and should not go out under this campaign's name.
  const key = lead.signal_quote.trim().toLowerCase().split(/\s+/).slice(0, 6).join(' ');
  if (key && !lead.email_body.toLowerCase().includes(key.split(' ').slice(0, 3).join(' '))) {
    return 'copy does not reference the signal quote';
  }
  return null;
}

async function log(leadId, type, metadata) {
  const { error } = await supabase.from(EVENTS).insert({ lead_id: leadId, event_type: type, metadata });
  if (error) console.error(`  (event log failed: ${error.message})`);
}

async function bounceRate() {
  const { data } = await supabase.from(EVENTS)
    .select('event_type').in('event_type', ['sent', 'bounced'])
    .order('created_at', { ascending: false }).limit(BOUNCE_WINDOW * 2);
  const rows = data || [];
  const sent = rows.filter(r => r.event_type === 'sent').length;
  const bounced = rows.filter(r => r.event_type === 'bounced').length;
  return { rate: sent ? bounced / sent : 0, sent, bounced };
}

(async () => {
  if (!LIVE) console.log('DRY RUN: no email will be sent. Pass --send to send for real.\n');

  const { rate, sent: sentN, bounced } = await bounceRate();
  if (sentN >= 20 && rate > BOUNCE_LIMIT && !process.env.ALLOW_HIGH_BOUNCE) {
    console.error(`HALTED: bounce rate ${(rate * 100).toFixed(1)}% (${bounced}/${sentN}) is above ${BOUNCE_LIMIT * 100}%.`);
    console.error('A bad list damages the sending domain for all three campaigns. Clean it first.');
    process.exit(1);
  }
  if (sentN) console.log(`Bounce rate ${(rate * 100).toFixed(1)}% over last ${sentN} sends (limit ${BOUNCE_LIMIT * 100}%).`);

  const today = new Date().toISOString().slice(0, 10);
  const { data: todaySent } = await supabase.from(EVENTS)
    .select('id').eq('event_type', 'sent').gte('created_at', today + 'T00:00:00Z');
  const already = (todaySent || []).length;
  const room = Math.max(0, DAILY_CAP - already);
  if (!room) { console.log(`Daily cap reached (${already}/${DAILY_CAP}).`); return; }

  const now = new Date().toISOString();
  const { data: due, error } = await supabase.from(TABLE)
    .select('id, business_name, email, website, contact_name, contact_role, city, signal_quote, signal_url, email_subject, email_body, qualification_score, scheduled_send_at')
    .eq('status', 'queued')
    .not('email_subject', 'is', null)
    .not('email', 'is', null)
    .lte('scheduled_send_at', now)
    .order('qualification_score', { ascending: false, nullsFirst: false })
    .order('scheduled_send_at', { ascending: true })
    .limit(200);
  if (error) throw new Error(error.message);

  const batch = (due || []).slice(0, LIMIT ? Math.min(LIMIT, room) : room);
  if (!batch.length) { console.log('Nothing scheduled and due.'); return; }

  console.log(`${LIVE ? 'Sending' : 'Would send'} ${batch.length} (${already}/${DAILY_CAP} sent today)\n`);

  let sent = 0, blocked = 0, failed = 0;
  for (const lead of batch) {
    const block = blockReason(lead);
    if (block) {
      console.log(`  [block] ${lead.business_name} - ${block}`);
      blocked++;
      if (LIVE) {
        await log(lead.id, 'held', { reason: block, email: lead.email });
        await supabase.from(TABLE).update({ notes: `HELD BY SENDER: ${block}` }).eq('id', lead.id);
      }
      continue;
    }

    const body = lead.email_body.trim() + FOOTER;
    process.stdout.write(`  ${lead.business_name.slice(0, 34).padEnd(36)}${lead.email.padEnd(34)}`);

    if (!LIVE) { console.log(`[dry] "${lead.email_subject}"`); sent++; continue; }

    const { data, error: sendErr } = await resend.emails.send({
      from: `${FROM_NAME} <${FROM}>`,
      reply_to: REPLY_TO,
      to: lead.email,
      subject: lead.email_subject,
      // PLAIN TEXT ONLY. No html key, ever. See the header.
      text: body,
    });

    if (sendErr) {
      console.log(`FAILED: ${sendErr.message}`);
      await log(lead.id, 'error', { error: sendErr.message, email: lead.email });
      failed++;
      continue;
    }
    console.log('sent');
    await log(lead.id, 'sent', {
      email: lead.email, subject: lead.email_subject, resend_id: data && data.id,
      contact: lead.contact_name || null, signal_url: lead.signal_url || null,
    });
    await supabase.from(TABLE).update({
      status: 'sent', last_sent_at: new Date().toISOString(),
      sequence_step: 1, resend_email_id: data && data.id,
    }).eq('id', lead.id);
    sent++;
  }

  console.log(`\nDone. Sent: ${sent} | Blocked: ${blocked} | Failed: ${failed}`);
})().catch(e => { console.error('cadre sender failed:', e.message); process.exit(1); });
