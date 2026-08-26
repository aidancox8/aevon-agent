#!/usr/bin/env node
/**
 * Guards the validator that stands between a language model and a stranger's inbox.
 *
 * Every "reject" case below is something a model actually produced, or a rule from CLAUDE.md
 * that would embarrass the business if it shipped. The quote case is the important one: the
 * entire premise of this campaign is that the opening line is the prospect's own published
 * sentence, so a paraphrase is worse than sending nothing.
 */
const { reject, normalise } = require('./cadre/personalizer');

const LEAD = {
  contact_name: 'Nathan Willman',
  signal_quote: 'Maintain employee training records and certifications',
  industry: 'trades', business_name: 'MJ Roofing', notes: '', staff_estimate: 120,
};
// Blank lines between paragraphs, because that is what a real email looks like. This fixture
// used to be single-spaced, which meant the "wall of text" rule had nothing to test against and
// 27 stored bodies with no paragraph break at all passed every check in the file.
const GOOD = `Hi Nathan,

Saw your Safety Officer posting, which asks whoever takes it to maintain employee training records and certifications.

With 120 roofers on tickets, that half of the job grows quietly until it is most of it.

I build software that clears the record when the course that renews it is completed.

Is that a real annoyance at MJ, or handled?`;

const swap = (from, to) => GOOD.replace(from, to);

const CASES = [
  // The 2026-08-25 background run produced all three of these and every one passed the old file.
  ['reject', 'employee training', `Hi there,
I came across your recent job posting and noticed that it says: "Maintain accurate records of employee training and certifications."
I build software that assigns role-based onboarding, auto-enrols training, and sends renewal reminders.
{{ASK}}`],
  // The same good copy, collapsed to single spacing. Nothing else about it changed, which is
  // the point: formatting alone decides whether this is readable on a phone.
  ['reject', 'training matrix', GOOD.replace(/\n\n/g, '\n')],
  ['reject', 'training matrix', `Hi Tim,

Saw your posting.

I build software that ties role-based onboarding paths to the required training so each new hire gets a personalised plan, completes courses that auto-sign off onboarding steps, and has credentials enrolled with automatic renewal reminders set for 60, 30 and 7 days before expiry.

{{ASK}}`],
  ['accept', 'training records', GOOD],
  // Model actually did this: invented volunteers at a grocery co-op.
  ['reject', 'training records', swap('120 roofers', '120 volunteers')],
  ['reject', 'training records', swap('120 roofers', 'many part-time crews')],
  // Model actually did this: wrote as a company that does not exist.
  ['reject', 'training records', swap('I build software', 'Our software helps')],
  ['reject', 'training records', swap('I build software', 'We provide a system')],
  // Model actually did this: dropped the quote in with no framing.
  ['reject', 'training records', GOOD.replace('Saw your Safety Officer posting, which asks whoever takes it to maintain', 'Maintain')],
  // The premise. A paraphrase is not the campaign.
  ['reject', 'training records', swap('maintain employee training records and certifications', 'keep track of tickets')],
  // Standing rules.
  ['reject', 'training records', swap('I build software', 'It is $200 a month and I build software')],
  ['reject', 'training records', swap('I build software', 'Our other clients say I build software')],
  ['reject', 'training records', swap('I build software', 'I build it free and I build software')],
  // Em dashes are STRIPPED by normalise() rather than rejected, which is the better outcome:
  // the copy is fixed instead of thrown away. Typography is asserted separately below.
  ['accept', 'training records', swap('grows quietly until', 'grows quietly \u2014 until')],
  ['reject', 'training records', swap('Hi Nathan,', 'Hi Dave,')],
  ['reject', 'training records', GOOD.replace('Is that a real annoyance at MJ, or handled?', 'Let me know.')],
  // Research findings.
  ['reject', 'a quick question about your training records please', GOOD],
  ['reject', 'training records.', GOOD],
];

let bad = 0;
for (const [expect, subject, body] of CASES) {
  const r = reject(normalise(subject), normalise(body), LEAD);
  const got = r ? 'reject' : 'accept';
  const ok = got === expect;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${expect.padEnd(6)} ${(r || 'accepted').slice(0, 62)}`);
}
console.log(`\n${CASES.length - bad}/${CASES.length} passed`);
process.exit(bad ? 1 : 0);
