#!/usr/bin/env node
/**
 * cadre/copy-handwritten-4.js, first-touch copy for the ten US leads pulled from Crustdata on
 * 2026-09-10 (the last $0.21 on treg): 100 to 1,000 staff, newest postings, six with a named HR
 * person from Hunter.
 *
 * Written by hand because the generator's output that day read "That ad means someone will be
 * spending their salary doing this by hand", which is a characterisation, and the campaign rule
 * is quote them, do not characterise them. Same shape as rounds one to three: their published
 * sentence woven into ours, one plain observation that invents nothing, one line beginning
 * "I build software that", and the {{ASK}} token. Validated by personalizer.reject() before it
 * is stored, stored with copy_locked so no generation run replaces it.
 *
 * ADDMAN was parked rather than written: its "quote" is the applicant's duty list ("Perform
 * other duties as assigned"), not a records role.
 *
 *   node cadre/copy-handwritten-4.js --dry
 *   node cadre/copy-handwritten-4.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const supabase = require('../lib/supabase');
const { reject } = require('./personalizer');

const DRY = process.argv.includes('--dry');

const COPY = [
  ['49011113-c3ae-4f8f-b51e-93ddf074dc36', 'skills matrices',
`Hi Gidgett,

Saw your posting for someone to own and maintain employee proficiency checklists, qualification records, and departmental skills matrices.

Three artifacts for the same fact, who is qualified for what, is usually where the re-keying starts.

I build software that keeps one record per person and clears the qualification when the training is completed, so there is one list to maintain instead of three.

{{ASK}}`],

  ['1a505f3f-b055-4a7d-a6f6-f787c4bcd3e8', 'competency records',
`Hi Vanjia,

Saw your posting for someone to develop and maintain quality training programs and employee competency records.

Developing the programs is the part that needs a person. Maintaining the records is the part that takes their week.

I build software that records the competency when the training is completed, so nobody keys it in a second time.

{{ASK}}`],

  ['92148059-65dd-4a72-871d-90e7d5d1bede', 'certification tracking',
`Hi Suzy,

Saw your posting for someone to oversee internal compliance audits, employee compliance training, and certification tracking across all business units.

Across all business units usually means several lists that disagree about the same people.

I build software that holds every certification on one record per person, with the renewal scheduled from the expiry date, so an audit is a report rather than a week.

{{ASK}}`],

  ['b8c3058f-af38-414e-b5ca-7bf12707b6bd', 'training records',
`Hi Dave,

Saw a posting of yours where the role is to maintain training records and documentation for compliance and audit purposes.

For audit purposes is the tell: the records exist to be produced on demand, and the demand never comes at a convenient time.

I build software that files the record when the training is done and produces the audit list on demand.

{{ASK}}`],

  ['ba49724b-7b1d-4b7c-8bfc-04bff1e98241', 'cross-training matrix',
`Hi there,

Saw a posting of yours where the role is to maintain departmental cross-training matrix and coordinate collection of operational data needed for regulatory reporting.

A matrix kept by hand is right on the day it is updated and drifts every day after.

I build software that records the completion when the training is done and keeps the renewal date with it, so the cross-training list is a report rather than a document someone maintains.

{{ASK}}`],

  ['3b0ffaeb-3e04-47fb-a75a-deb40c44d45c', 'training documentation',
`Hi there,

Saw your posting asking someone to create a culture of continuous learning while maintaining complete training documentation and competency records.

The first half of that sentence is a job. The second half is the paperwork that crowds it out.

I build software that records the competency when the training is completed, so the documentation keeps itself and the person gets the first half back.

{{ASK}}`],

  ['4834ad61-9f71-4c2b-bd5c-d513ce680235', 'training records',
`Hi there,

Saw a posting of yours where the instructor must also initiate and maintain accurate training records and documentation for each course.

Per course, per trainee, with recurrent training on a clock, is a lot of records to keep accurate by hand.

I build software that files the record when the course is completed and schedules the recurrent date itself.

{{ASK}}`],

  ['3e1d2026-f9ab-4646-8432-cc596245cc31', 'training matrix',
`Hi Frederic,

Saw a posting of yours where the role is to keep the training matrix and competency records up to date in the learning management system.

An LMS that needs a person to keep it up to date is holding the courses, not the competencies.

I build software where completing the training clears the credential itself, so the records are current without someone making them so.

{{ASK}}`],

  ['b6c9a3dd-0c23-4638-b6e3-5add47e60433', 'training records',
`Hi Benito,

Saw a posting of yours where the role is to monitor employee training compliance through the Learning Management System and maintain accurate training records.

Monitoring compliance through one system and maintaining the records in another is two jobs wearing one title.

I build software that keeps the record and the compliance status on the same page per person, so who is out of date is a list rather than a check.

{{ASK}}`],

  ['0c9e31b6-390c-4d0a-a96d-c242243f1f40', 'certification tracking',
`Hi Vivian,

Saw your posting for someone to own OEM certification tracking for the practice, ensuring partner-level requirements and customer-facing credentials are maintained.

Partner-level requirements are a headcount of certified people that has to stay above a line, which means every expiry is a risk to the tier.

I build software that holds every certification on one record per person, with the renewal scheduled from the expiry date, so an expiry is visible weeks before it costs the tier.

{{ASK}}`],
  // Added the same evening: two US nonprofits sized from their Form 990 and given an HR name by Hunter.
  ['954bb813-debe-464d-a648-ed751463c3fd', 'driver qualification files',
`Hi Britt,

Saw a posting of yours where the role is to ensure all driver qualification files and records are maintained in compliance with all regulatory agencies, including FMCSA, DOT and the DMV.

A DQ file is a folder per driver where the medical card and the licence expire on their own clocks.

I build software that keeps those on one record per driver, with the renewal scheduled from the expiry date, so the file is compliant on the day someone asks.

{{ASK}}`],

  ['5631cccb-853c-460e-891e-5e16c62b85a8', 'certification records',
`Hi Aaron,

Saw a posting of yours where the role is to maintain current certification records for assigned unit staff.

Current is the hard word. A record is current the day it is filed and expires quietly on a date nobody is watching.

I build software that holds every certification on one record per person and schedules the renewal from the expiry date, so current is the default rather than a task.

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
