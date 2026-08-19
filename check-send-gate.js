#!/usr/bin/env node
// Guards the gate on anything Claude sends unattended from Gmail.
//
// Every "block" case below is a failure that already happened or came close in this project.
// If any of these ever pass, an unattended reply could repeat it.
const { canSendReply } = require('./lib/send-gate');

const base = {
  toEmail: 'kevin@airresearchgroup.com',
  businessName: 'Air Research Group Inc.',
  inboundSubject: 'Re: transferring NPRI data',
  inboundBody: 'Yes that sounds useful, can you tell me more about how it would work?',
  replyBody: 'Happy to. The tool takes your field readings and produces the NPRI format. Worth 15 minutes?',
  inboundMessageId: '19f8530dc6d0b2f7',
  sentToday: 0,
};
const w = (over = {}) => ({ ...base, ...over });

const CASES = [
  ['allow', w(), 'a plain reply to a human question'],

  // The Randy incident.
  ['block', w({ inboundSubject: 'Automatic reply: out of office' }), 'inbound is an out-of-office'],
  ['block', w({ inboundBody: 'I am currently out of the office until Monday.' }), 'inbound is an OOO body'],

  // Opt-outs get honoured, not answered.
  ['block', w({ inboundBody: 'no thanks' }), 'inbound is an opt-out'],
  ['block', w({ inboundBody: 'Please remove me from your list.' }), 'inbound asks for removal'],

  // The employer.
  ['block', w({ toEmail: 'someone@changepain.ca', businessName: 'Changepain' }), 'recipient is the employer'],
  ['block', w({ businessName: 'Artus Health Centre' }), 'recipient is the excluded clinic'],
  ['block', w({ toEmail: 'jean@vancouvercommercialbrokers.ca' }), 'recipient is handled personally'],

  // Never initiate.
  ['block', w({ inboundMessageId: null }), 'not a reply'],
  ['block', w({ replyBody: '   ' }), 'empty body'],

  // Fabricated history, the worst class.
  ['block', w({ replyBody: 'As discussed, here is the summary.' }), 'draft claims a prior conversation'],
  ['block', w({ replyBody: 'I have been speaking with Randy about this.' }), 'draft claims a relationship'],
  ['block', w({ replyBody: 'Great speaking with you last week about the rollout.' }), 'draft invents a call'],
  ['block', w({ replyBody: 'Our other clients in the sector see the same thing.' }), 'draft implies a client base'],

  // Commercial commitments are Aidan's to make.
  ['block', w({ replyBody: 'It would be $900 for the audit.' }), 'draft quotes a price'],
  ['block', w({ replyBody: 'I will have it to you by Friday, I promise.' }), 'draft commits to delivery'],
  ['block', w({ replyBody: 'I will send the contract over for you to sign.' }), 'draft uses contract language'],

  // Escalate rather than answer.
  ['block', w({ inboundBody: 'Our lawyer wants to review this first.' }), 'inbound raises a legal matter'],
  ['block', w({ inboundBody: 'How did you get my address? This is spam.' }), 'inbound is a complaint'],
  ['block', w({ inboundBody: 'Do you work with Changepain?' }), 'inbound mentions the employer'],

  ['block', w({ sentToday: 3 }), 'daily cap reached'],

  // Must still allow ordinary business language that merely resembles the forbidden patterns.
  ['allow', w({ replyBody: 'That discussion is worth having. When suits you?' }), 'the word discussion alone'],
  ['allow', w({ replyBody: 'I can walk you through how the room grid works.' }), 'plain explanation'],
];

let bad = 0;
for (const [expect, msg, label] of CASES) {
  const r = canSendReply(msg);
  const got = r.allowed ? 'allow' : 'block';
  const ok = got === expect;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${expect.padEnd(5)} ${label.padEnd(42)}${r.allowed ? '' : r.reason}`);
}
console.log(`\n${CASES.length - bad}/${CASES.length} passed`);
process.exit(bad ? 1 : 0);
