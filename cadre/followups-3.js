#!/usr/bin/env node
/**
 * cadre/followups-3.js — follow-up copy for the remaining 43 leads that had none.
 *
 * Closes the gap the first live day exposed: copy rounds two and three only wrote email 1, so
 * every one of these sequences would have needed follow-ups written under deadline pressure as
 * each touch 2 came due, from Sep 3 onward. Written once, ahead of all of them.
 *
 * Same rules as cadre/followups.js and followups-2.js:
 *   touch 2  ONE concrete thing email 1 did not say, chosen for that company. No restating the
 *            quote (the thread carries it), no "circling back".
 *   touch 3  says plainly it is the last one and asks for nothing. Consistently the
 *            highest-replying message in a cold sequence because of exactly that.
 *
 *   node cadre/followups-3.js --dry
 *   node cadre/followups-3.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const supabase = require('../lib/supabase');

const DRY = process.argv.includes('--dry');

/** [id, business, touch-2 body, touch-3 body] */
const COPY = [
  ['7bf8921d-953e-4dc0-9cbb-42bb6efdf3c0', 'Apex Industries',
`Hi there,

One thing I left out. The renewal is booked from the completion date, so at 400 people the scheduling half of the job runs itself and only the sessions need a human.

That is usually most of what the posting describes.

Worth ten minutes?`,
`Hi there,

Last one from me on this.

If safety training scheduling is already handled, no reply needed and I will leave it there.

If it is worth a look later in the year, say so and I will come back then.`],

  ['72c92a80-c0d1-4a55-af6c-24f136b70790', 'East Coast Wild Blueberry',
`Hi there,

One thing worth adding. Seasonal staff can carry their own onboarding path, so returning workers pick up where their record left off instead of being re-papered every year.

In food production that is usually where the audit gaps come from.

Worth ten minutes?`,
`Hi there,

Last note from me.

If quality training records are already in hand, no reply needed.

If it is worth revisiting before next season, tell me when.`],

  ['68336596-7787-4db9-8c5f-1c250e2f4284', 'Mariposa Dairy',
`Hi there,

One thing I did not say. HR and QA can look at the same records through their own views, so the collaboration your posting describes stops being two people reconciling two documents.

That reconciliation is usually the hidden job.

Worth ten minutes?`,
`Hi there,

Last one from me.

If the matrices are working as they are, no reply needed and I will leave it there.

If it is worth a look after the next audit, say so.`],

  ['1aade1af-801e-44ee-98b6-59194da1b7eb', 'Loadmaster Industries',
`Hi there,

One thing worth adding. The expiry warnings go to the employee as well as the office, at sixty, thirty and seven days, so nobody is the single point of failure on a date.

That is the part "assist with tracking" usually means.

Worth ten minutes?`,
`Hi there,

Last note from me on this.

If certification tracking is already under control, no reply needed.

If it is worth seeing later, tell me when and I will come back then.`],

  ['51cc36d5-4497-41b3-96d6-94ebca00999f', 'AGX Siteworx',
`Hi there,

One thing I left out. At 35 people this does not need an admin hire: the system watches the renewal dates and the crew list stays a filter, not a spreadsheet.

Small companies are usually where one lapsed card hurts most.

Worth ten minutes?`,
`Hi there,

Last one from me.

If field credentials are already handled, no reply needed and I will leave you alone.

If it is worth a look later, say so and I will come back then.`],

  ['c12b0f11-8480-4be5-b415-6407f45bdbd8', 'Quality Power Solutions',
`Hi there,

One thing worth adding. OSHA, First Aid and equipment qualifications each keep their own renewal clock on the same person's record, so three issuers stop needing three lists.

That is usually why the one list never stays right.

Worth ten minutes?`,
`Hi there,

Last note from me.

If certification tracking is fine as it is, no reply needed.

If it is worth revisiting later in the year, tell me when.`],

  ['8c3e29e7-ada5-45e3-b2f7-c53e91dd7bf4', 'Menk USA, LLC',
`Hi there,

One thing I did not mention. Completion writes the matrix, so coordinating, maintaining and tracking collapse into one thing that happens on its own.

The posting describes three jobs; the system makes them zero.

Worth ten minutes?`,
`Hi there,

Last one from me on this.

If the training matrix is under control, no reply needed and I will leave it there.

If it is worth a look later, say so.`],

  ['aeecd9df-494b-4f69-aac6-ef6dbcb185e2', 'Davco Industrial Construction Services',
`Hi there,

One thing worth adding. Orientation can be the first step of each role's onboarding path, so the competency record starts on day one instead of being reconstructed later.

At 200 people that is where the tracking usually breaks.

Worth ten minutes?`,
`Hi there,

Last note from me.

If training and competency records are already handled, no reply needed.

If it is worth seeing later, tell me when and I will come back then.`],

  ['f672bcf5-8cea-4693-94c6-df67fccacc13', 'Steeler Inc.',
`Hi there,

One thing I left out. A DQF audit becomes a page per driver: medical card, MVR, training and certifications on one record, each with its own renewal warning.

At 450 people that is the difference between an audit and a bad month.

Worth ten minutes?`,
`Hi there,

Last one from me.

If driver files are already under control, no reply needed and I will leave it there.

If it is worth a look later in the year, say so.`],

  ['6ca2e71e-8b14-402d-a8c4-5800e30b5be2', 'Access Community Care',
`Hi there,

One thing worth adding. Online modules and in-person certs land on the same record, so Open Future Learning completions and CPR cards stop living in two systems.

In community care that split is usually the whole problem.

Worth ten minutes?`,
`Hi there,

Last note from me on this.

If training assignments are already coordinated well, no reply needed.

If it is worth revisiting later, tell me when.`],

  ['c783a840-a8bd-4c11-9910-576793966cc8', 'ETRO Construction Ltd.',
`Hi there,

One thing I did not say. The schedule and the record are the same object: booking the session and closing it both happen on the employee, so the compliance documentation writes itself.

At 200 people that is one role made lighter, not one more tool.

Worth ten minutes?`,
`Hi there,

Last one from me.

If training records are already handled, no reply needed and I will leave it there.

If it is worth a look later, say so and I will come back then.`],

  ['ee8b2433-663c-4358-b8e4-9ecc9bddde66', 'Umbrella Family and Child Centres of Hamilton',
`Hi there,

One thing worth adding. It sits alongside the HRIS rather than replacing it: the files stay where they are, and the credential expiry watching happens somewhere built for it.

That is usually the objection worth answering first.

Worth ten minutes?`,
`Hi there,

Last note from me.

If credential tracking is already in hand, no reply needed.

If it is worth seeing later in the year, tell me when.`],

  ['ed8925e9-5aec-4cc1-a8b3-8aa6031de5e4', 'Design Build Solutions Limited',
`Hi there,

One thing I left out. At 30 people this is not an enterprise system: one screen, each person's licences with their renewal dates, warnings that send themselves.

Small firms are where a single lapsed licence costs the most.

Worth ten minutes?`,
`Hi there,

Last one from me on this.

If the records side is fine as it is, no reply needed and I will leave you alone.

If it is worth a look later, say so.`],

  ['c5ad0b23-edf0-49e4-87b0-3b1e7dca7f02', 'ADJ Industries Inc',
`Hi there,

One thing worth adding. The in-house sessions your posting mentions close their own records: attendance is the sign-off, and the next expiry date is set from it automatically.

Monitoring stops being someone's calendar.

Worth ten minutes?`,
`Hi there,

Last note from me.

If training expiry tracking is already handled, no reply needed.

If it is worth revisiting later, tell me when and I will come back then.`],

  ['a019f8fb-2485-468b-8520-67d55c9cc6a5', 'Groupe Madysta',
`Hi there,

One thing I did not mention. Probation end dates and training deadlines both count from the start date on the same record, so every HR deadline your posting lists shares one source of truth.

That is what makes the monitoring automatic rather than a checklist.

Worth ten minutes?`,
`Hi there,

Last one from me.

If HR deadline tracking is already under control, no reply needed and I will leave it there.

If it is worth a look later, say so.`],

  ['a4bc533b-d6a4-4595-b4e1-dab6acc79ba0', 'JBS Expedite LTD',
`Hi there,

One thing worth adding. Each DQF document warns on its own clock, to the driver and dispatch, so "up to date" stops depending on the day somebody last checked.

At 120 drivers that is the whole job.

Worth ten minutes?`,
`Hi there,

Last note from me on this.

If the DQFs are already handled, no reply needed.

If it is worth seeing later, tell me when.`],

  ['89cfca21-324d-4db2-b9ad-9e1a37213fda', 'MacLean Engineering & Marketing Co. Limited',
`Hi there,

One thing I left out. Operational and maintenance training can live on the same employee records with different owners, so each program keeps its own view without keeping its own spreadsheet.

At 550 people the spreadsheets are usually the real system.

Worth ten minutes?`,
`Hi there,

Last one from me.

If training records are already under control, no reply needed and I will leave it there.

If it is worth a look later in the year, say so.`],

  ['3d11f818-44d4-4639-8480-8dc5264edaca', 'Lonestar Electric Industrial Supply',
`Hi there,

One thing worth adding. The overdue chase sends itself: assignment, acknowledgment and completion are all on the record, so the follow-up your posting describes is a notification, not a task.

Five manual jobs become none.

Worth ten minutes?`,
`Hi there,

Last note from me.

If the training matrix is working as it is, no reply needed.

If it is worth revisiting later, tell me when and I will come back then.`],

  ['b432e332-0607-43d9-8c88-ff9db2c1df95', 'South East Construction L.P.',
`Hi there,

One thing I did not say. The matrix is generated from completions, so it is identical whoever opens it, and the support role your posting mentions stops being a second keeper of the same document.

Two hands on one spreadsheet is how they drift.

Worth ten minutes?`,
`Hi there,

Last one from me on this.

If the matrix is under control, no reply needed and I will leave it there.

If it is worth a look later, say so.`],

  ['cb5a9ebb-9d5a-4f0a-8c6d-51fbb4490ff4', 'Twilight Drilling Ltd.',
`Hi there,

One thing worth adding. Tickets that differ by site and role live on the same record as the HR documentation, so "is this crew cleared for this pad" has an answer without a phone call.

On drilling schedules that call is always at the worst time.

Worth ten minutes?`,
`Hi there,

Last note from me.

If ticket documentation is already handled, no reply needed.

If it is worth seeing later, tell me when.`],

  ['38fd6d42-75b3-4bbf-962e-195da0569eda', 'Acorn Stairlifts (Canada) Inc.',
`Hi there,

One thing I left out. The oversight half of the role gets a dashboard rather than a filing job: who has done what, what is due, where the gaps are, live.

The maintaining half disappears into the system.

Worth ten minutes?`,
`Hi there,

Last one from me.

If training records are already handled, no reply needed and I will leave it there.

If it is worth a look later in the year, say so.`],

  ['e1918268-b198-4fd8-89e0-e1fe05711149', 'Control Panels USA Inc.',
`Hi there,

One thing worth adding. The compliance-gaps column becomes the system's own view: completion and renewal already live on the record, so the gap is computed, not compiled.

That is the column nobody trusts in a hand-kept matrix.

Worth ten minutes?`,
`Hi there,

Last note from me on this.

If the training matrix is fine as it is, no reply needed.

If it is worth revisiting later, tell me when.`],

  ['0b31bb12-4bdc-46fe-b1d8-6289c235d645', 'BLOX LLC',
`Hi there,

One thing I did not mention. "Retrievable on demand" is the default state: any auditor question about any of the 400 is a filter, answered in the meeting rather than after it.

Standards like yours are easy to write and hard to keep by hand.

Worth ten minutes?`,
`Hi there,

Last one from me.

If training records are already retrievable on demand, no reply needed and I will leave it there.

If it is worth a look later, say so.`],

  ['0fb37924-005d-44f2-b6e3-21295296520d', 'Lochridge-Priest, Inc.',
`Hi there,

One thing worth adding. Each trade carries its own onboarding path and certification set, so at 500 people across trades the record stays right per person instead of averaged across the company.

That is usually why "accurate" is the hard word in the posting.

Worth ten minutes?`,
`Hi there,

Last note from me.

If training records are already under control, no reply needed.

If it is worth seeing later in the year, tell me when.`],

  ['5cca177e-be7d-48a2-a2e4-161e8f9d6926', 'Heartland Coatings Ltd.',
`Hi Trevor,

One thing I left out. Client and site requirements can each be their own checklist against the same worker records, so "does this crew qualify for this site" is answered per client, instantly.

That question is usually asked from a truck.

Worth ten minutes?`,
`Hi Trevor,

Last one from me on this.

If safety tickets are already handled, no reply needed and I will leave it there.

If it is worth a look later, say so.`],

  ['3825a6ff-88a5-4dc6-acfc-435097b6dbcb', 'CarePros',
`Hi Lloyd,

One thing worth adding. The trainer sees competence and certification on one screen per caregiver, so the quality-improvement half of the role gets the hours the recording half used to eat.

At 250 caregivers that is most of a job returned.

Worth ten minutes?`,
`Hi Lloyd,

Last note from me.

If certification records are already in hand, no reply needed.

If it is worth revisiting later, tell me when.`],

  ['8eb190f7-719f-4124-8fc6-08a3716655ba', 'Kings Energy Services Ltd.',
`Hi there,

One thing I did not say. Self-study modules record their own completion, which is the hardest kind of training to evidence because nothing happens in a room anyone can sign.

The QHSE matrix then reflects what was actually done.

Worth ten minutes?`,
`Hi there,

Last one from me.

If QHSE training tracking is already handled, no reply needed and I will leave it there.

If it is worth a look later, say so.`],

  ['bca45cdc-ac0d-4cc0-8fa1-270c76ce8343', 'Essential Services LLC',
`Hi there,

One thing worth adding. The record maintains itself from completions, so "accurate" stops being a property of whoever last touched the file and becomes the default.

At 120 people the file always has a last-toucher.

Worth ten minutes?`,
`Hi there,

Last note from me on this.

If training records are already accurate without the chase, no reply needed.

If it is worth seeing later, tell me when.`],

  ['bf297eed-97fe-45fe-ab4c-28560d1da01e', 'Big Country Equipment Repair Ltd.',
`Hi Connie,

One thing I left out. Coordinating stays a human job; recording stops being one. Booking the session and closing the record are the same click, on the employee.

That is the half of the posting that eats the week.

Worth ten minutes?`,
`Hi Connie,

Last one from me.

If training records are already under control, no reply needed and I will leave it there.

If it is worth a look later in the year, say so.`],

  ['0275e467-14d8-4f88-93ec-cef1b213dfc9', 'Spirit of the Children Society',
`Hi there,

One thing worth adding. First Aid, FoodSafe and confidentiality each warn on their own renewal clock, to the staff member and to you, so a 30-person organisation does not need a person watching a spreadsheet.

That spreadsheet always has exactly one reader.

Worth ten minutes?`,
`Hi there,

Last note from me.

If training requirements are already tracked well, no reply needed.

If it is worth revisiting later, tell me when.`],

  ['e2416515-dd0f-4a3d-8ee1-9bde7779682f', 'Trillium Project Management Ltd.',
`Hi David,

One thing I did not mention. Organising the session stays yours; the matrix updates itself from who attended. At 35 people that is the difference between a side task and a hidden job.

It grows with every project either way.

Worth ten minutes?`,
`Hi David,

Last one from me on this.

If the training matrix is fine as it is, no reply needed and I will leave it there.

If it is worth a look later, say so.`],

  ['bf0c6d55-03e7-4213-a808-88236f3cd8ec', 'Wilder Concepts Inc.',
`Hi there,

One thing worth adding. Equipment training is per person and per machine on the record, so who can run what is a filter, and the weekly safety meetings log against the same people.

That list outgrows a spreadsheet faster than anything else on it.

Worth ten minutes?`,
`Hi there,

Last note from me.

If equipment training tracking is already handled, no reply needed.

If it is worth seeing later, tell me when.`],

  ['60b9db86-da27-40c0-ae46-a07f6b4b71d4', 'MPI Oilfield Inc.',
`Hi Rosslyn,

One thing I left out. Verify disappears as a job: the matrix and what happened are the same record, so there is nothing to reconcile before an audit or a client visit.

Scheduling and facilitating stay human; the paper does not.

Worth ten minutes?`,
`Hi Rosslyn,

Last one from me.

If the training matrix is already under control, no reply needed and I will leave it there.

If it is worth a look later in the year, say so.`],

  ['16fa8136-4917-44a7-987e-e60c965bc567', 'Thyssen Mining Construction of Canada Ltd.',
`Hi Carmen,

One thing worth adding. Enter, update and verify collapse into nothing: completion writes the record once, and recertification is coordinated by the system from that date.

At 534 people the triple-handling is most of the role.

Worth ten minutes?`,
`Hi Carmen,

Last note from me on this.

If certification tracking is already handled, no reply needed.

If it is worth revisiting later, tell me when.`],

  ['d4f41686-b3e2-4b12-88e7-e565ca3b2996', 'Vivo for Healthier Generations Society',
`Hi Natasha,

One thing I did not say. "Current and compliant" resets with every hire, so the fix is at onboarding: each new person starts with their role's qualifications attached and their renewals already scheduled.

Then the currency maintains itself.

Worth ten minutes?`,
`Hi Natasha,

Last one from me.

If certification records are already in hand, no reply needed and I will leave it there.

If it is worth a look later, say so.`],

  ['3a9f7f7d-d2df-49c1-a37f-9359cc19ff72', 'cam | industrial',
`Hi there,

One thing worth adding. The development initiatives get the time back: assignments, completions and renewals run themselves, so the support role is strategy rather than filing.

That split is usually what the posting is really asking for.

Worth ten minutes?`,
`Hi there,

Last note from me.

If training records are already handled, no reply needed.

If it is worth seeing later in the year, tell me when.`],

  ['756e90a9-43e1-4386-96f4-4162453e6591', 'Spectrum Society for Community Living',
`Hi there,

One thing I left out. The whole pre-start sequence, references, criminal record check, first aid, orientation, online modules, shows as one checklist per hire with what is outstanding on top.

Nobody chases; the gaps are just visible.

Worth ten minutes?`,
`Hi there,

Last one from me on this.

If hiring paperwork is already under control, no reply needed and I will leave it there.

If it is worth a look later, say so.`],

  ['3410a6b0-9e10-4368-b74c-951c3b8df1d1', 'Ebco Industries Ltd',
`Hi Eden,

One thing worth adding. All nine categories you list, forklift through WHMIS, sit on one record per person with their own renewal cycles, so audit-ready is the resting state rather than a preparation.

Nine renewal calendars is the real weight of that posting.

Worth ten minutes?`,
`Hi Eden,

Last note from me.

If certification records are already audit-ready, no reply needed.

If it is worth revisiting later, tell me when.`],

  ['5b4df2de-e7cf-4947-a731-9d5abc0e73f7', 'BlueCity Construction',
`Hi there,

One thing I did not mention. A COR audit is mostly proving what already happened, and it is slow only because the proof is scattered. On one record per employee, the evidence is a page.

The continuous-improvement half then gets the actual hours.

Worth ten minutes?`,
`Hi there,

Last one from me.

If COR audit prep is already handled, no reply needed and I will leave it there.

If it is worth a look before the next cycle, say so.`],

  ['5c9a2bad-0a97-4b36-b558-d0aabd82c6e4', 'PhysioCare At Home',
`Hi Heather,

One thing worth adding. With clinicians in clients' homes rather than one building, the record is the only proof anyone is registered and insured, and each registration warns before it lapses rather than after a client asks.

That is the risk nobody has time to watch.

Worth ten minutes?`,
`Hi Heather,

Last note from me on this.

If registrations and renewals are already tracked well, no reply needed.

If it is worth seeing later, tell me when.`],

  ['2ff2ecdf-862d-42b7-84a9-da76a3d3817f', 'Segra International Corp',
`Hi Jamie,

One thing I left out. The training records answer the customer quality questionnaires: when a client audit asks who is qualified for what, the answer is an export rather than an afternoon.

At 40 people the afternoon is yours.

Worth ten minutes?`,
`Hi Jamie,

Last one from me.

If training records are already audit-ready, no reply needed and I will leave it there.

If it is worth a look later, say so.`],

  ['2821afeb-ae74-4aba-9459-42ab7f43055f', 'Cap West Forming Ltd',
`Hi there,

One thing worth adding. When the Safety Rep asks, the site list is a filter on live records rather than a rebuild: fall protection, WHMIS and equipment tickets per person, current as of today.

Site crews change too fast for a document to keep up.

Worth ten minutes?`,
`Hi there,

Last note from me.

If site certification tracking is already handled, no reply needed.

If it is worth revisiting later, tell me when.`],

  ['bb725126-3379-4b15-a004-65540db57df5', 'Global Rigging and Transport',
`Hi Andrew,

One thing I did not say. Four renewal cycles per driver, licence, air brake, medical, rigging, each warn separately and in advance, so the first sign of a lapse is a notification rather than a stopped truck.

That is the version of this problem that costs real money.

Worth ten minutes?`,
`Hi Andrew,

Last one from me on this.

If those renewal cycles are already watched, no reply needed and I will leave it there.

If it is worth a look later in the year, say so.`],
];

function reject(body) {
  const words = body.trim().split(/\s+/).length;
  if (words > 90) return `${words} words, too long for a follow-up`;
  if (/\bcircl(e|ing) back|following up|bumping this|touching base|per my last\b/i.test(body)) return 'filler follow-up phrase';
  if (/\bour (clients|customers)\b|\bcompanies like\b/i.test(body)) return 'implies customers that do not exist';
  if (/\$|\bpricing\b|\bper user\b/i.test(body)) return 'mentions price';
  if (!/\n\n/.test(body)) return 'no paragraph breaks';
  if (/—/.test(body)) return 'em dash';
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
      followup_subject: 'follow-up',        // sender threads it as "Re: <original subject>"
      followup_body: fu1.trim(),
      followup2_subject: 'follow-up',
      followup2_body: fu2.trim(),
    }).eq('id', id);
    if (error) { console.error(`FAIL ${business}: ${error.message}`); bad++; continue; }
    ok++;
  }
  console.log(`${DRY ? 'Would write' : 'Wrote'} follow-ups for ${ok} lead(s), ${bad} rejected.`);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e.message); process.exit(1); });
