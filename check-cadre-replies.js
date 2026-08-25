#!/usr/bin/env node
/**
 * The reply scanner has no real replies to learn from yet, so its classifier is tested against
 * written-out examples instead. The one that matters is opt-out detection: the footer invites a
 * bare "no", and missing one means emailing somebody who asked to be left alone.
 *
 * This imports the real classifier rather than restating the regexes, so the test cannot pass
 * while the scanner is broken.
 */
const { classify } = require('./cadre/reply-scan.js');

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
console.log(`\n${CASES.length - bad}/${CASES.length} passed`);
process.exit(bad ? 1 : 0);
