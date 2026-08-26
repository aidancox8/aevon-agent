#!/usr/bin/env node
/**
 * cadre/copy-handwritten-3.js — first-touch copy for the 30 reachable leads that had none.
 *
 * These had an address and a signal but no email written, so they could never send. Same rules
 * as rounds one and two: their published sentence woven into ours rather than quoted as a
 * quotation, one plain observation that invents nothing, one line beginning "I build software
 * that", and the {{ASK}} token. Every one is validated by cadre/personalizer.js reject() before
 * it is stored, and stored with copy_locked so no generation run can replace it.
 *
 * Five leads from this batch were disqualified rather than written, because the finder matched
 * the words "certification records" but not the subject: Valard ("units approaching certification
 * expiry" is equipment), Kenn Borek Air and De Havilland (aircraft documentation), Seaspan
 * (materials certification), and one whose business name is literally "Confidential".
 *
 *   node cadre/copy-handwritten-3.js --dry
 *   node cadre/copy-handwritten-3.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const supabase = require('../lib/supabase');
const { reject } = require('./personalizer');

const DRY = process.argv.includes('--dry');

const COPY = [
  ['aba49f5f-65e7-4fef-957d-acc7fa1ff6e9', 'training databases',
`Hi there,

Saw a posting of yours asking someone to manage training databases and tracking spreadsheets, monitoring certification expiries and scheduling renewals.

Databases and spreadsheets, plural, is usually the honest description of what a records job actually is.

I build software that runs onboarding by role and schedules the renewal itself, so there is one record rather than several.

{{ASK}}`],

  ['aeecd9df-494b-4f69-aac6-ef6dbcb185e2', 'competency tracking',
`Hi there,

Saw your posting, which asks whoever takes it to maintain training records, competency tracking, and orientation programs.

Those three are one thing that got split into three, and the orientation is where the other two come from.

I build software that runs onboarding by role, with the training assigned inside it and competency carried on the same record.

{{ASK}}`],

  ['6ca2e71e-8b14-402d-a8c4-5800e30b5be2', 'role-specific training',
`Hi there,

Saw a posting of yours asking someone to coordinate role-specific training assignments, including Open Future Learning and CPR/First Aid certification tracking.

Role-specific is the hard part. Every role needs a different set, and the set is what someone has to remember on a first day.

I build software that assigns the training for that role automatically and files the certificate with its renewal already set.

{{ASK}}`],

  ['c5ad0b23-edf0-49e4-87b0-3b1e7dca7f02', 'training expiry',
`Hi there,

Saw a posting of yours where the role monitors training expiry dates, facilitates required in-house training.

Monitoring is a person checking. It works right up until the week they are busy, which is the week it matters.

I build software that runs onboarding by role and sends the expiry warnings itself, to the employee and their manager.

{{ASK}}`],

  ['f672bcf5-8cea-4693-94c6-df67fccacc13', 'driver qualification files',
`Hi there,

Saw a posting of yours asking someone to maintain driver qualification files, certifications, training records, medical cards and motor vehicle records.

Five documents per driver, each on its own clock, and a DQF audit asks for all of them at once.

I build software that runs onboarding by role and carries every one of those on the same employee record.

{{ASK}}`],

  ['52268ee5-e77b-4561-8a2f-0b2a31df76ad', 'certification records',
`Hi there,

Saw a posting of yours asking someone to maintain employee certification and training records.

In licensed security that record is the thing a client asks to see, so it has to be right rather than nearly right.

I build software that runs onboarding by role and keeps the licence and the training on one employee record.

{{ASK}}`],

  ['4815411e-febf-4bbc-9d14-e2c9a669ed97', 'COR records',
`Hi there,

Saw a posting of yours covering safety documentation, COR records, inspections, training records and compliance paperwork.

That is five kinds of paper held by one person, and an audit asks for them in a different order every time.

I build software that keeps training and tickets on one employee record, so producing the evidence is a page rather than a fortnight.

{{ASK}}`],

  ['a019f8fb-2485-468b-8520-67d55c9cc6a5', 'HR deadlines',
`Hi there,

Saw your posting, which asks whoever takes it to monitor employee training, probationary periods, and other HR-related deadlines.

Every one of those deadlines is counted from a start date, which makes the first day the thing that decides all of them.

I build software that runs onboarding by role and tracks each of those dates from that record automatically.

{{ASK}}`],

  ['ed8925e9-5aec-4cc1-a8b3-8aa6031de5e4', 'licence renewals',
`Hi there,

Saw a posting of yours asking someone to maintain confidential employee records, administer leave, and track certification and licence renewals.

At 30 people that is one person holding three unrelated systems, and the renewals are the one with a deadline attached.

I build software that runs onboarding by role and carries each licence with its renewal date already set.

{{ASK}}`],

  ['72c92a80-c0d1-4a55-af6c-24f136b70790', 'quality training records',
`Hi there,

Saw a posting of yours asking someone to maintain employee quality training records and assist with training.

In food production that record is what an auditor asks for first, and it is usually assembled the week before rather than kept.

I build software that assigns the training inside onboarding, so completing it writes the record itself.

{{ASK}}`],

  ['a4bc533b-d6a4-4595-b4e1-dab6acc79ba0', 'driver qualification files',
`Hi there,

Saw your posting, which asks whoever takes it to maintain accurate and up-to-date Driver Qualification Files.

A DQF is only ever accurate on the day someone updates it, and there are 120 of them moving at once.

I build software that runs onboarding by role and warns on each document before it expires rather than after.

{{ASK}}`],

  ['89cfca21-324d-4db2-b9ad-9e1a37213fda', 'training records',
`Hi there,

Saw a posting of yours asking someone to develop and maintain training records for all operational and maintenance training carried out.

Developing the training and recording it are separate jobs, and the second one only stays current while somebody has time.

I build software that assigns the training as part of onboarding, so finishing a session closes the record without re-keying.

{{ASK}}`],

  ['def2d088-8055-45a0-a59d-54f125f1538d', 'ISO audits',
`Hi there,

Saw a posting of yours asking someone to audit employee training records and maintain training completion trackers in preparation for ISO audits.

Auditing your own trackers before the auditor does is a whole job that exists because the trackers are kept by hand.

I build software where completion writes the record, so the tracker is always what actually happened.

{{ASK}}`],

  ['c783a840-a8bd-4c11-9910-576793966cc8', 'training schedules',
`Hi there,

Saw your posting, which asks whoever takes it to maintain training schedules, records, certifications, and compliance documentation.

Four things that all start from how somebody was set up on their first day, which is where they usually come apart.

I build software that runs onboarding by role and carries the training and certification on the same record from there.

{{ASK}}`],

  ['ee8b2433-663c-4358-b8e4-9ecc9bddde66', 'credential expiry',
`Hi there,

Saw a posting of yours asking someone to maintain accurate employee files in the HRIS and track credential and certification expiry dates.

Most HRIS products hold the file well and were never built to watch a date, which is why the tracking becomes a person's job.

I build software that sits alongside the HRIS and does the onboarding and the expiry watching.

{{ASK}}`],

  ['8c3e29e7-ada5-45e3-b2f7-c53e91dd7bf4', 'training matrix',
`Hi there,

Saw your posting, which asks whoever takes it to coordinate required employee training, maintain the training matrix and records, and track completion.

Coordinating, maintaining and tracking are three descriptions of keeping one document honest by hand.

I build software where the matrix is generated from what people have completed, so none of the three is a job.

{{ASK}}`],

  ['70f33569-e16b-47da-b9d4-2729c47439db', 'certification renewals',
`Hi there,

Saw a posting of yours asking someone to track training participation, completion records, and certification renewals.

Participation and completion drift apart quickly, and the renewal date depends on which one you trust.

I build software where completing the training is what records it, so the renewal counts from something real.

{{ASK}}`],

  ['0a2dc2db-9e31-49d4-a4e5-90100bbae396', 'safety training matrix',
`Hi there,

Saw your posting, which asks whoever takes it to oversee the Safety Training Matrix and ensure all personnel training is completed.

Company, client and regulatory requirements rarely line up, so one matrix ends up answering to three different masters.

I build software that assigns training by role and shows the gap against each requirement separately.

{{ASK}}`],

  ['68336596-7787-4db9-8c5f-1c250e2f4284', 'training matrices',
`Hi there,

Saw a posting of yours asking someone to develop and maintain training matrices, certification tracking, and compliance records.

Matrices, plural, usually means one per plant or per line, and keeping them consistent is most of the work.

I build software where each one is a view of the same employee records rather than a separate document.

{{ASK}}`],

  ['38fd6d42-75b3-4bbf-962e-195da0569eda', 'training records',
`Hi there,

Saw your posting, which asks whoever takes it to oversee company training initiatives and maintain training records.

Overseeing the initiative is the interesting half. Maintaining the record is the half that quietly takes the time.

I build software that assigns training inside onboarding, so the record maintains itself and the oversight is what is left.

{{ASK}}`],

  ['7bf8921d-953e-4dc0-9cbb-42bb6efdf3c0', 'mandatory safety training',
`Hi there,

Saw a posting of yours asking someone to schedule, track, and maintain records of mandatory safety training and certifications.

At 400 people scheduling alone is a job, and it repeats every time a certification comes up for renewal.

I build software that schedules the renewal from the completion date, so the next round books itself.

{{ASK}}`],

  ['c12b0f11-8480-4be5-b415-6407f45bdbd8', 'expiration dates',
`Hi there,

Saw a posting of yours asking someone to monitor expiration dates for certifications including OSHA, First Aid and equipment qualifications.

Three different issuers, three different renewal periods, and one person holding the calendar for all of them.

I build software that carries each credential with its own renewal date and warns separately on each.

{{ASK}}`],

  ['3825a6ff-88a5-4dc6-acfc-435097b6dbcb', 'certification records',
`Hi Lloyd,

Saw a posting of yours where the Trainer also monitors employee competence, maintains certification records.

Putting both on the trainer makes sense right up to the point where the recording crowds out the training.

I build software that runs onboarding by role, so completing the training records the competency without the trainer doing it twice.

{{ASK}}`],

  ['8eb190f7-719f-4124-8fc6-08a3716655ba', 'QHSE training matrix',
`Hi there,

Saw a posting of yours referring to self-study training on QHSE procedures identified in the training matrix.

Self-study is the hardest kind to evidence, because nothing happens in a room that anybody can sign.

I build software that assigns it by role and records the completion itself, so the matrix reflects what was actually done.

{{ASK}}`],

  ['5cca177e-be7d-48a2-a2e4-161e8f9d6926', 'worker safety tickets',
`Hi Trevor,

Saw a posting of yours asking someone to submit and maintain worker safety tickets and ensure crews meet client and site safety requirements.

Different clients want different tickets, so "does this crew qualify for this site" is a question asked constantly and answered from memory.

I build software that holds each worker's tickets on one record, so that question has an answer rather than a guess.

{{ASK}}`],

  ['0275e467-14d8-4f88-93ec-cef1b213dfc9', 'training requirements',
`Hi there,

Saw a posting of yours asking someone to track staff training and certification requirements, First Aid and FoodSafe among them.

At 30 people that lives in one person's head or one spreadsheet, and both have the same failure mode.

I build software that runs onboarding by role and carries each certificate with its renewal already set.

{{ASK}}`],

  ['756e90a9-43e1-4386-96f4-4162453e6591', 'hiring paperwork',
`Hi there,

Saw a posting of yours covering hiring-related paperwork: references, criminal record search, first aid certificate, orientation training and online training.

That is five things per hire, all needed before a first shift, and all of them somebody chasing rather than a process.

I build software that runs that whole sequence by role and shows you what is still outstanding.

{{ASK}}`],

  ['bf0c6d55-03e7-4213-a808-88236f3cd8ec', 'equipment training',
`Hi there,

Saw a posting of yours covering fleet maintenance and safety certifications, tracking weekly safety meetings done by crew leaders.

Equipment training is per person and per machine, which is why it outgrows a spreadsheet faster than anything else on that list.

I build software that keeps each qualification on the employee record, so who can run what is a filter rather than a memory.

{{ASK}}`],

  ['3a9f7f7d-d2df-49c1-a37f-9359cc19ff72', 'training records',
`Hi there,

Saw a posting of yours asking someone to support training and development initiatives for employees and maintain training records.

The development half is the part worth a person's time. The maintaining half is the part that eats it.

I build software that assigns training inside onboarding, so the record keeps itself and the development work is what is left.

{{ASK}}`],

  ['2821afeb-ae74-4aba-9459-42ab7f43055f', 'site tickets',
`Hi there,

Saw a posting of yours asking someone to track certification expiry dates for site personnel as directed by the Safety Rep or Site Leadership.

Site personnel change between projects, so the list is never the same two months running.

I build software that holds each worker's tickets on one record, so the site list is a filter rather than a rebuild.

{{ASK}}`],
];

(async () => {
  let ok = 0, bad = 0;
  for (const [id, subject, body] of COPY) {
    const { data: lead, error } = await supabase.from('cadre_leads')
      .select('id, business_name, contact_name, signal_quote').eq('id', id).single();
    if (error) { console.error(`FAIL ${id}: ${error.message}`); bad++; continue; }

    const why = reject(subject, body, lead);
    if (why) { console.error(`REJECT ${String(lead.business_name).slice(0, 34).padEnd(36)}${why}`); bad++; continue; }

    if (DRY) { ok++; continue; }
    const { error: e2 } = await supabase.from('cadre_leads').update({
      email_subject: subject,
      email_body: body.trim(),
      personalization_basis: 'hand-written from published signal quote',
      copy_locked: true,
    }).eq('id', id);
    if (e2) { console.error(`FAIL ${lead.business_name}: ${e2.message}`); bad++; continue; }
    ok++;
  }
  console.log(`${DRY ? 'Would write' : 'Wrote'} ${ok} of ${COPY.length}, ${bad} rejected.`);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e.message); process.exit(1); });
