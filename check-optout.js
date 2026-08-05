#!/usr/bin/env node
// Guards a promise printed in every outbound email: "reply no and I won't email you again".
// If this ever fails, we are asking people to opt out and then emailing them anyway.

const { optOutReason } = require('./reply-processor');

// [reply, should it stop us emailing them]
const CASES = [
  ['no', true],
  ['No.', true],
  ['no thanks', true],
  ['Hi Aidan, no thanks', true],
  ['Not interested', true],
  ['nope', true],
  ['Please remove me from your list.', true],
  ['unsubscribe', true],
  ['Stop emailing me', true],
  ['Do not contact me again', true],
  ['take me off this list', true],
  // Must NOT be read as a decline: these are conversations, not opt-outs.
  ['No, we actually handle that in house. What would you build?', false],
  ['Sure, tell me more', false],
  ['Can you send pricing?', false],
  ['No idea who handles this, try Sandra', false],
  ['We have no capacity right now but check back in the fall', false],
  ['', false],
];

let bad = 0;
for (const [text, expected] of CASES) {
  const got = !!optOutReason(text);
  const ok = got === expected;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${expected ? 'stop ' : 'keep '} ${JSON.stringify(text).slice(0, 62)}`);
}
console.log(`\n${CASES.length - bad}/${CASES.length} passed`);
process.exit(bad ? 1 : 0);
