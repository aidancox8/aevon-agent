#!/usr/bin/env node
/**
 * cadre/followups-4.js, hand-written touches 2 and 3 for the fourteen leads sent 2026-09-01 to
 * 2026-09-03 whose email 1 went out before follow-up copy existed for them. Same shape and
 * guard rails as cadre/followups.js; read that header for why these are written by hand.
 *
 * None of the fourteen has a named contact, so every one opens "Hi there". Each touch 2 adds one
 * concrete thing drawn from THEIR quote, never a restatement of it. Two are Quebec companies
 * whose ads were in French; email 1 went in English, so these do too.
 *
 *   node cadre/followups-4.js --dry
 *   node cadre/followups-4.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const supabase = require('../lib/supabase');

const DRY = process.argv.includes('--dry');

/** [id, business, touch-2 body, touch-3 body] */
const COPY = [
  ['b2c2989b-58e8-49f7-b927-aba296f84dd3', 'Sunny Corner Enterprises Inc',
`Hi there,

One thing I left out. The training records and the SDS library can sit on the same system, so an inspection is one screen rather than two binders and a spreadsheet.

At 250 people, audit-ready on demand is most of what that role is being hired to produce.

Worth ten minutes?`,
`Hi there,

Last one from me on this.

If the HSE records are already handled, or it is simply not this year's problem, no reply needed and I will leave it there.

If it is worth a look in a few months, say so and I will come back then.`],

  ['92293aed-1408-4a04-993f-c3e8b86f1f49', 'BAAF',
`Hi there,

One detail I did not include. For a licence scheme the useful part is that each renewal carries its own date from the day it is entered, so the reminders go out to the licence holder and to you without anyone building a calendar.

That is the difference between tracking renewals and chasing them.

Worth ten minutes?`,
`Hi there,

Last note from me.

If licence renewals are already under control, no reply needed and I will leave you alone.

If the timing is just wrong, tell me when and I will come back then.`],

  ['7aa999ea-6143-4da2-8391-85d417cc1864', 'Mark Motors Group',
`Hi there,

Worth adding one thing. Mandatory training can be assigned by role, so a new technician and a new advisor each get their own list, and the manager sees who is behind without asking.

Across a dealer group that is the part that stops being a monthly email.

Worth ten minutes?`,
`Hi there,

Last one from me on this.

If mandatory training is already tracked somewhere that works, no reply needed.

If it is worth a look later in the year, say so and I will come back then instead.`],

  ['9b44268f-c933-4bfa-b231-946c9ca55402', 'Malco Products Inc.',
`Hi there,

One thing I left out. A training matrix on a spreadsheet is only right on the day someone updates it. On a system it updates itself when a course is completed or a ticket lapses, so the matrix is the record rather than a copy of it.

Worth ten minutes?`,
`Hi there,

Last note from me.

If the matrix is fine as it is, no reply needed and I will leave it there.

If it is worth a look in a few months, tell me and I will come back then.`],

  ['c9b4cfa2-7a83-4ea1-844a-73af8065475a', 'Gabriel Miller Inc.',
`Hi there,

One detail I did not include. Competency cards can be tracked the same way as certifications: each card has an expiry, the person and the supervisor get reminded before it, and a lapsed card shows up as a gap on the floor plan rather than as nothing.

At 65 people that is a one-page view.

Worth ten minutes?`,
`Hi there,

Last one from me on this.

If training and competency cards are already handled, no reply needed.

If the timing is wrong, say when and I will come back then.`],

  ['04cc917d-5a93-4571-9deb-b90dee169d32', 'Arrow Machine and Fabrication Group',
`Hi there,

Worth adding one thing. Welder qualifications are the clearest case for this: each ticket has a process, a position and an expiry, and a lapsed one means a weld nobody can sign off. The system carries all three per welder and warns the shop before it lapses, not after.

Worth ten minutes?`,
`Hi there,

Last note from me.

If welder qualification records are already under control, no reply needed and I will leave you alone.

If it is worth a look later, tell me when and I will come back then.`],

  ['baa6da32-84c9-439c-93d8-975505ff0caf', 'JDS Energy & Mining',
`Hi there,

One thing I left out. Competency matrices and orientation records can live on the same person record as the certifications, so a site orientation, a ticket and a sign-off are three lines on one page rather than three systems.

At 300 people across sites, that is the screen a supervisor actually opens.

Worth ten minutes?`,
`Hi there,

Last one from me on this.

If training records and matrices are already handled, no reply needed.

If it is worth a look in a few months, say so and I will come back then instead.`],

  ['2f0837ce-5a18-40f2-86bf-657bcb02b79e', 'Convertus',
`Hi there,

One thing worth saying plainly. You already track training in E-Compliance, so the question is not whether to track it but whether the chasing still lands on a person. What I build takes the overdue and upcoming reminders off that person and sends them itself, to the employee and the manager, on a schedule you set.

If E-Compliance already does that well, ignore me.

Worth ten minutes?`,
`Hi there,

Last note from me.

If E-Compliance covers it, no reply needed and I will leave it there.

If the reminders are still manual and it is worth a look later, tell me when.`],

  ['aca29072-6aa8-4651-b22f-6090361bc5a1', 'Earthscape Play',
`Hi there,

Your ad asked for someone to build visibility into certifications and compliance. Worth adding one thing: that is close to what I build, and the difference is that the visibility comes with the record rather than being built on top of it afterwards.

Happy to show what that looks like for 150 people, or to stay out of the way of whoever you hire.

Worth ten minutes?`,
`Hi there,

Last one from me on this.

If you have hired for it and they are building it, no reply needed.

If it is worth a look before that, say so and I will come back.`],

  ['4e4fc657-e530-4c43-8fdd-8f02e6787c4e', 'Moneta Group',
`Hi there,

One detail I did not include. Continuing education credits and licence renewals can be tracked per advisor with the deadline on the record, so the reminder goes to the advisor first and to you second, and the documentation is attached where the deadline is.

That is most of the coordinating done before anyone asks.

Worth ten minutes?`,
`Hi there,

Last note from me.

If CE tracking and renewals are already under control, no reply needed and I will leave you alone.

If it is worth a look later in the year, tell me when.`],

  ['c1d9c5b5-5988-4131-b319-132aaab6ca16', 'HealthPoint',
`Hi there,

One thing I left out. Navigator recertifications and in-service days can be tracked on the same record, with the annual date set once and the reminders going to the navigator and their lead before it, so the ability to keep operating never depends on someone remembering.

Worth ten minutes?`,
`Hi there,

Last one from me on this.

If recertifications are already tracked somewhere that works, no reply needed.

If it is worth a look in a few months, say so and I will come back then instead.`],

  ['5ec72dfb-804e-48e2-93de-cbf278d851a0', 'Kandor Management',
`Hi there,

Worth adding one thing. Certifications and licence renewals can be tracked per person with the expiry on the record, so the reminders go out at sixty, thirty and seven days without anyone keeping a calendar, and an audit is one list.

Worth ten minutes?`,
`Hi there,

Last note from me.

If certification tracking is already handled, no reply needed and I will leave it there.

If the timing is just wrong, tell me when and I will come back then.`],

  ['899f72ce-683e-4da1-84d8-740f372a1610', 'Ventum Financial Corp.',
`Hi there,

One detail I did not include. Advisor designations and provincial licence renewals can be tracked per advisor with the renewal date on the record, so the advisor is reminded first, compliance second, and the proof is attached to the deadline rather than filed somewhere else.

Worth ten minutes?`,
`Hi there,

Last one from me on this.

If licence renewals and designations are already under control, no reply needed.

If it is worth a look later, say when and I will come back then.`],

  ['b7973971-05a5-45ed-af97-08dc4519ef1a', 'ODC Tooling and Molds',
`Hi there,

One thing I left out. Training logs, certifications and the SDS library can sit on the same system, so the manual and digital records your ad mentions become one record per person instead of two.

At 100 people that is the whole filing problem.

Worth ten minutes?`,
`Hi there,

Last note from me.

If the training logs and certifications are already handled, no reply needed and I will leave you alone.

If it is worth a look in a few months, tell me and I will come back then.`],
];

/** Same guard rails as cadre/followups.js. */
function reject(body) {
  const words = body.trim().split(/\s+/).length;
  if (words > 90) return `${words} words, too long for a follow-up`;
  if (/\bcircl(e|ing) back|following up|bumping this|touching base|per my last\b/i.test(body)) {
    return 'contains a filler follow-up phrase';
  }
  if (/\bour (clients|customers)\b|\bcompanies like\b|\bwe help \d/i.test(body)) {
    return 'implies customers that do not exist';
  }
  if (/\$|\bprice|\bpricing\b|\bper user\b/i.test(body)) return 'mentions price';
  if (/—/.test(body)) return 'contains an em dash';
  if (!/\n\n/.test(body)) return 'no paragraph breaks';
  return null;
}

(async () => {
  let ok = 0, bad = 0;
  for (const [id, business, fu1, fu2] of COPY) {
    const problems = [['touch 2', reject(fu1)], ['touch 3', reject(fu2)]].filter(([, p]) => p);
    if (problems.length) {
      bad++;
      for (const [which, p] of problems) console.error(`REJECT ${business} ${which}: ${p}`);
      continue;
    }
    if (DRY) { ok++; continue; }
    const { error } = await supabase.from('cadre_leads').update({
      followup_subject: 'follow-up',
      followup_body: fu1.trim(),
      followup2_subject: 'follow-up',
      followup2_body: fu2.trim(),
    }).eq('id', id).is('followup_subject', null);
    if (error) { console.error(`FAIL ${business}: ${error.message}`); bad++; continue; }
    ok++;
  }
  console.log(`${DRY ? 'Would write' : 'Wrote'} follow-ups for ${ok} lead(s), ${bad} rejected.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
