#!/usr/bin/env node
// Every "hold" case below is copy that was sitting in the queue, due to send, on 2026-08-19.
const { retiredOfferReason } = require('./lib/copy-guard');

const CASES = [
  ['hold', "It's a $1,500 flat setup, live inside a week, and you own the software."],
  ['hold', "$1,500 flat setup, live in a week, and you own it."],
  ['hold', "It's $150/mo after that."],
  ['hold', "I'd build a tool that reads your incoming service inquiries and sorts them, free."],
  ['hold', "I'd like to build a working version for you, free of charge."],
  ['hold', "I'll build it and it's yours either way."],
  ['send', "I'd build a tool that reads your incoming service inquiries and sorts them for your dispatchers. Worth solving, or one of those things it's easier to just live with?"],
  ['send', "Either way, all the best."],           // the breakup sign-off must still ship
  ['send', "Roughly how much of a week does that eat?"],
  ['send', ''],

  // False positives the first version of this guard actually produced against the live queue.
  // Both are the recipient's own words, and both are the reason the email was worth sending.
  ['send', 'For Miller Plumbing, an agent answers and qualifies every "Request a FREE ESTIMATE" job inquiry.'],
  ['send', 'Point Grey keeps a busy schedule with Fear Free certified care, so appointment requests pile up.'],
  ['send', "I build software that frees up your front desk. Worth solving?"],
  ['send', 'Your booking page offers a free consultation, which means every enquiry needs triage.'],
  ['send', 'Feel free to ignore this if I have guessed wrong.'],

  // Still must hold: the promise, in the first person, in one sentence.
  ['hold', "I'm building a track record and would handle that build free for you."],
  ['hold', "I'm still taking on one more free build to round out my current set."],
  ['hold', 'I would set up a working version for you at no cost.'],
];

let bad = 0;
for (const [expect, body] of CASES) {
  const r = retiredOfferReason(body);
  const got = r ? 'hold' : 'send';
  const ok = got === expect;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${expect}  ${(r || '').padEnd(38)}${body.slice(0, 52)}`);
}
console.log(`\n${CASES.length - bad}/${CASES.length} passed`);
process.exit(bad ? 1 : 0);
