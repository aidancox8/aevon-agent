#!/usr/bin/env node
/**
 * The reply scanner has no real replies to learn from yet, so its classifier is tested against
 * written-out examples instead. The one that matters is opt-out detection: the footer invites a
 * bare "no", and missing one means emailing somebody who asked to be left alone.
 *
 * This imports the real classifier rather than restating the regexes, so the test cannot pass
 * while the scanner is broken.
 */
const { classify, bouncedRecipient, isBounce } = require('./cadre/reply-scan.js');

const CASES = [
  ['No', 'opt_out'],
  ['no.', 'opt_out'],
  ['Not interested, thanks.', 'opt_out'],
  ['Please remove me from your list.', 'opt_out'],
  ['no thanks, we are all set', 'opt_out'],
  ['Please stop emailing me.', 'opt_out'],
  ['Unsubscribe', 'opt_out'],
  ['We are good, we just bought BambooHR.', 'opt_out'],
  ['Interested. What does it cost?', 'interested'],
  ['Sounds good, happy to have a look next week.', 'interested'],
  ['Can you send me more info?', 'interested'],
  ['You want to speak to Dana, she handles this.', 'referral'],
  ['Forwarding this to our ops manager.', 'referral'],
  ['What is this in reference to?', 'reply'],
  // The quoted original must not decide the classification.
  ['Sure, send it over.\n\n> Not relevant? Reply with a no and I will not email again.', 'interested'],
  // "no" inside a sentence is not an opt-out.
  ['We have no HR system at all right now, which is the problem.', 'reply'],
];

let bad = 0;
for (const [text, want] of CASES) {
  const got = classify(text);
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${want.padEnd(11)}${ok ? '' : `got ${got.padEnd(11)}`}"${text.replace(/\n/g, ' | ').slice(0, 58)}"`);
}
// ── Bounce attribution ────────────────────────────────────────────────────────
//
// A bounce is from a mail server, not the prospect, so the From, the domain and the Subject all
// belong to Google. It has to be attributed by the recipient named inside the report. That was
// missing at first, and because the sender's 5% breaker counts `bounced` events, a bounce nobody
// recorded read as a perfectly healthy list. Resend's webhook recorded them independently and
// hid the hole; Gmail has no webhook, so this is the only thing that catches a dying list.
const H = pairs => ({ headers: Object.entries(pairs).map(([name, value]) => ({ name, value })) });

const BOUNCES = [
  ['X-Failed-Recipients header',
    H({ 'X-Failed-Recipients': 'nathan@mjroofing.net', From: 'mailer-daemon@googlemail.com' }),
    '', 'nathan@mjroofing.net'],

  ['RFC 3464 Final-Recipient',
    H({ From: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' }),
    'Content-Type: message/delivery-status\r\nReporting-MTA: dns; googlemail.com\r\n'
      + 'Final-Recipient: rfc822; gabe@northmountainconstruction.ca\r\nAction: failed\r\n',
    'gabe@northmountainconstruction.ca'],

  ['Original-Recipient when Final-Recipient is absent',
    H({ From: 'postmaster@outlook.com' }),
    'Original-Recipient: rfc822; hr@collicutt.com\r\nAction: failed\r\n',
    'hr@collicutt.com'],

  ['falls back to the quoted original, skipping our own and the reporting server',
    H({ From: 'mailer-daemon@googlemail.com' }),
    'Your message to aidan@aevon.ca could not be delivered.\r\n'
      + 'The response was from mailer-daemon@googlemail.com\r\n'
      + 'To: laura.kleiner@agwest.com\r\n',
    'laura.kleiner@agwest.com'],
];

console.log('');
for (const [label, payload, raw, want] of BOUNCES) {
  const got = bouncedRecipient(payload, raw);
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `  wanted ${want}, got "${got}"`}`);
}

// And they have to be recognised as bounces before any of that runs.
const DETECT = [
  ['mailer-daemon is a bounce', H({}), 'mailer-daemon@googlemail.com', true],
  ['postmaster is a bounce', H({}), 'postmaster@outlook.com', true],
  ['a delivery-status report is a bounce',
    H({ 'Content-Type': 'multipart/report; report-type=delivery-status' }), 'noreply@x.com', true],
  ['a normal reply is not a bounce', H({}), 'nathan@mjroofing.net', false],
];
for (const [label, payload, from, want] of DETECT) {
  const ok = isBounce(payload, from) === want;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
}

const total = CASES.length + BOUNCES.length + DETECT.length;
console.log(`\n${total - bad}/${total} passed`);
process.exit(bad ? 1 : 0);
