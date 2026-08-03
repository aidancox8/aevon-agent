#!/usr/bin/env node
/**
 * Sends a sample of each campaign's outreach to Aidan, rendered through the real send path,
 * so the signature and layout can be checked exactly as a prospect would see them.
 *
 * Recipient is hardcoded and asserted below. This script must never be able to reach a lead:
 * it renders real prospect copy, so a stray recipient argument would be an actual cold email
 * sent by accident. There is deliberately no way to pass a different address.
 *
 *   node test-send-self.js          send one Aevon and one Tempo sample
 *   node test-send-self.js --dry    render and print, send nothing
 */
require('dotenv').config();
const { Resend } = require('resend');
const supabase = require('./lib/supabase');
const { toHtml: aevonHtml } = require('./sender');
const { toHtml: tempoHtml } = require('./tempo/sender');

const TO = 'aidan@aevon.ca';
if (TO !== 'aidan@aevon.ca') throw new Error('recipient guard tripped');
const DRY = process.argv.includes('--dry');

const CAMPAIGNS = [
  {
    label: 'AEVON',
    table: 'leads',
    key: process.env.RESEND_API_KEY,
    from: process.env.FROM_EMAIL,
    render: (lead) => aevonHtml(lead.email_body, lead.id, lead.industry, lead.business_name),
  },
  {
    label: 'TEMPO',
    table: 'tempo_leads',
    key: process.env.TEMPO_RESEND_API_KEY || process.env.RESEND_API_KEY,
    from: process.env.TEMPO_FROM_EMAIL || process.env.FROM_EMAIL,
    render: (lead) => tempoHtml(lead.email_body, lead.id),
  },
];

(async () => {
  for (const c of CAMPAIGNS) {
    const { data, error } = await supabase
      .from(c.table)
      .select('id, business_name, industry, email_subject, email_body')
      .eq('status', 'queued').is('last_sent_at', null)
      .not('email_subject', 'is', null).not('email_body', 'is', null)
      .order('qualification_score', { ascending: false, nullsFirst: false })
      .limit(1);
    if (error) { console.log(`${c.label}: could not read ${c.table}: ${error.message}`); continue; }
    const lead = data?.[0];
    if (!lead) { console.log(`${c.label}: no queued lead with copy to sample`); continue; }

    const subject = `[TEST] ${lead.email_subject}`;
    const html = c.render(lead);

    console.log(`\n── ${c.label} ${'─'.repeat(40)}`);
    console.log(`   sample lead : ${lead.business_name}`);
    console.log(`   from        : Aidan from Aevon <${c.from}>`);
    console.log(`   subject     : ${subject}`);
    console.log(`   signature   : ${/>Aidan<\/div>/.test(html) ? 'first name only' : 'CHECK, surname may still be present'}`);
    console.log(`   body:\n`);
    console.log(lead.email_body.split('\n').map(l => '     ' + l).join('\n'));

    if (DRY) { console.log('\n   [dry] not sent'); continue; }
    if (!c.key || !c.from) { console.log(`\n   ! missing Resend key or from-address, skipped`); continue; }

    const resend = new Resend(c.key);
    const { data: sent, error: sendErr } = await resend.emails.send({
      from: `Aidan from Aevon <${c.from}>`,
      to: TO,
      reply_to: 'aidan@aevon.ca',
      subject,
      text: lead.email_body,
      html,
    });
    if (sendErr) console.log(`\n   ! send failed: ${sendErr.message}`);
    else console.log(`\n   sent to ${TO} (resend id ${sent.id})`);
  }
  console.log('');
})().catch(e => { console.error('test send failed:', e.message); process.exit(1); });
