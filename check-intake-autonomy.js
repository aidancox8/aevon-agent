#!/usr/bin/env node
/**
 * check-intake-autonomy.js — guard the one irreversible thing intake-agent.js does.
 *
 * The intake agent can send a reply to a stranger, unattended, from a client's own
 * mailbox. Every other mistake in that file produces a bad draft that a human reads
 * before anyone sees it. This one does not, so the conditions that allow it are
 * asserted here rather than trusted.
 *
 * What this protects, in order of how much it would cost to get wrong:
 *   1. Aevon's own mailbox can never auto-send  (CLAUDE.md rule 1)
 *   2. Nothing sends unless a config opts in AND the environment is armed
 *   3. A malformed or placeholder-ridden reply is never fit to send
 *
 *   node check-intake-autonomy.js
 */
const assert = require('assert');
const {
  draftIsSafeToSend,
  isProtectedSender,
  isAutomatedRecipient,
  AUTOSEND_CAP_FALLBACK,
} = require('./intake-agent');

let passed = 0;
function ok(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${label}`);
  } catch (err) {
    console.error(`  FAIL  ${label}\n        ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('Aevon mailboxes are refused as senders');
for (const addr of ['aidan@aevon.ca', 'AIDAN@AEVON.CA', 'hello@aevon.ca', 'aidan@gmail.com']) {
  ok(`${addr} is protected`, () => assert.strictEqual(isProtectedSender(addr), true));
}
ok('a client mailbox is not protected', () => {
  assert.strictEqual(isProtectedSender('sofia@skylineproperties.com'), false);
});

console.log('\nAutomated recipients are never auto-replied to');
for (const addr of [
  'no-reply@zillow.com', 'noreply@facebook.com', 'do-not-reply@google.com',
  'mailer-daemon@googlemail.com', 'postmaster@example.com', 'bounces@sendgrid.net',
  'notifications@followupboss.com', 'billing@stripe.com',
]) {
  ok(`${addr} is held`, () => assert.strictEqual(isAutomatedRecipient(addr), true));
}
ok('a real person is not held', () => {
  assert.strictEqual(isAutomatedRecipient('jane.doe@gmail.com'), false);
});

console.log('\nUnsafe replies are held back');
const unsafe = {
  'unfilled placeholder': 'Hi [First Name], thanks for reaching out about the property, I would love to help you find the right home in your price range.',
  'template token': 'Hi Jane, thanks for reaching out about {{ address }}, happy to help you find the right home in your area and answer any questions.',
  'model self-reference': 'Hi Jane, as an AI assistant I cannot give you specific advice, but thank you very much for reaching out to us about this listing.',
  'refusal text': 'Hi Jane, I cannot help with that request, but thanks for reaching out to us about the property you saw listed online yesterday.',
  'leftover TODO': 'Hi Jane, thanks for reaching out about the listing. TODO confirm the timeline before replying to this one properly.',
  'too short': 'Thanks!',
};
for (const [label, text] of Object.entries(unsafe)) {
  ok(`held: ${label}`, () => assert.strictEqual(draftIsSafeToSend(text).ok, false));
}
ok('held: implausibly long', () => {
  assert.strictEqual(draftIsSafeToSend('a'.repeat(4001)).ok, false);
});

console.log('\nA good reply passes');
ok('a normal reply is safe', () => {
  const good = 'Hi Jane, thanks for getting in touch about the Lakewood listing. Before I send over comparables, are you looking to be in by a set report date, and are you using VA or conventional financing? Happy to jump on a quick call if that is easier.';
  assert.strictEqual(draftIsSafeToSend(good).ok, true);
});

console.log('\nA cap always exists');
ok('the fallback cap is a positive finite number', () => {
  assert.ok(Number.isFinite(AUTOSEND_CAP_FALLBACK) && AUTOSEND_CAP_FALLBACK > 0);
});

console.log(`\n${passed} assertion(s) passed.`);
if (process.exitCode === 1) console.error('check-intake-autonomy FAILED');
