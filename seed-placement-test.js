#!/usr/bin/env node
/**
 * Seed test: is campaign mail reaching the inbox, or the spam folder?
 *
 * "Delivered" in Resend means the receiving server ACCEPTED the message. It says nothing
 * about which folder it landed in, and spam placement counts as delivered. That distinction
 * is the whole question: since late July, replies AND out-of-office autoresponders have both
 * gone to zero while sends continued, which is what worsening placement looks like and is not
 * what falling interest looks like.
 *
 * test-send-self.js cannot answer this. It sends to aidan@aevon.ca, the same domain the mail
 * comes from, so it never faces the external filters that matter.
 *
 * Sends through the real path: same Resend key, same from-address, same HTML wrapper, same
 * opt-out footer. The only thing that differs is the recipient.
 *
 *   node seed-placement-test.js --dry
 *   node seed-placement-test.js --send  you@gmail.com  you@outlook.com
 */
require('dotenv').config();
const { Resend } = require('resend');
const { toHtml } = require('./sender');

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.FROM_EMAIL;
const SEND = process.argv.includes('--send');
const TO = process.argv.slice(2).filter(a => a.includes('@'));

// Deliberately shaped like real outreach: same length, same register, same footer. A short
// "test" note would be classified differently and would prove nothing.
const SUBJECT = 'same client details, three portals';
const BODY = `Every insurer wants the same client details in a slightly different format, so brokers end up typing the same information into three portals to place one policy.

I build small tools that do that specific job automatically. Fixed price, and I show you it working before you decide anything.

Is that actually a problem worth solving at your shop, or have you already sorted it?

Not interested? Just reply no and I won't email you again.`;

(async () => {
  if (!TO.length) {
    console.error('Give at least one recipient. Use addresses you can actually open.');
    process.exit(1);
  }
  console.log(`from: Aidan from Aevon <${FROM}>\nsubject: ${SUBJECT}\n`);
  if (!SEND) { console.log(BODY); console.log(`\nDRY RUN. Would send to: ${TO.join(', ')}`); return; }

  for (const to of TO) {
    const { data, error } = await resend.emails.send({
      from: `Aidan from Aevon <${FROM}>`,
      reply_to: FROM,
      to,
      subject: SUBJECT,
      text: BODY,
      html: toHtml(BODY, null, null, null),
    });
    console.log(error ? `FAILED ${to}: ${error.message}` : `sent ${to.padEnd(34)} ${data && data.id}`);
  }
  console.log(`
Now open each mailbox and record where it landed:
  Inbox / Promotions or Updates / Spam / never arrived
Promotions is a soft fail. Spam explains the reply drought outright.`);
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
