#!/usr/bin/env node
/**
 * cadre/copy-handwritten-2.js — round two of hand-written Cadre copy.
 *
 * These 24 leads all had generated bodies that were one unbroken block of text: greeting, quote,
 * claim and ask with no blank line anywhere. On a phone that is a grey wall. Several also dropped
 * the prospect's sentence in quotation marks after a colon, which is the clearest mail-merge tell
 * there is, and one was a single fifty-word sentence listing features.
 *
 * Same rules as round one (cadre/copy-handwritten.js):
 *   - open on THEIR published sentence, woven into a sentence of ours, never quoted as a quotation
 *   - one plain observation about why it gets harder at their size or shape, inventing nothing
 *   - one line starting "I build software that"
 *   - the {{ASK}} token, substituted at send time from cadre/offer.js
 *   - copy_locked, so no personalizer run can quietly replace them again
 *
 * Groupe Marcelle is deliberately absent. Its posting is in French and the only address found was
 * dpo@, a data protection officer, which is the wrong desk for a staff-records pitch twice over.
 *
 *   node cadre/copy-handwritten-2.js --dry
 *   node cadre/copy-handwritten-2.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const supabase = require('../lib/supabase');
const { reject } = require('./personalizer');

const DRY = process.argv.includes('--dry');

/** [id, subject, body] */
const COPY = [
  ['24aa39ef-893b-4600-94b4-98326e888345', 'safety training records',
`Hi there,

Saw your posting, which asks whoever takes it to maintain employee safety training records, certifications, and expiration dates.

On a jobsite those three move at different speeds, which is why holding them in one place by hand stops working.

I build software that runs onboarding by role and keeps all three on the same employee record.

{{ASK}}`],

  ['1e8589c7-0469-4854-9fe5-ff6aa3b7af1e', 'safety training record',
`Hi Yvonne,

Saw your posting, which asks whoever takes it to conduct internal safety training and maintain an accurate safety training record.

Running the training and recording it are two jobs, and at 300 people the second is where the gaps open up.

I build software that assigns the training as part of onboarding, so finishing a session closes the record itself.

{{ASK}}`],

  ['7e52bec4-b620-45dc-8bf1-61c290132128', 'training matrix',
`Hi Yeti,

Saw your posting, which asks whoever takes it to ensure employees complete online and in-person training as scheduled.

Two delivery methods on one schedule is usually where a training matrix starts drifting from what actually happened.

I build software that assigns both inside onboarding, so completing either one updates the record without anyone re-keying it.

{{ASK}}`],

  ['b432e332-0607-43d9-8c88-ff9db2c1df95', 'training matrix',
`Hi there,

Saw a posting of yours asking someone to maintain and update the training matrix with support from the site safety administrator.

Two people keeping one document current usually means neither is certain it is right on the day somebody asks for it.

I build software where the matrix is generated from what each person has completed, so nobody maintains it at all.

{{ASK}}`],

  ['cb5a9ebb-9d5a-4f0a-8c6d-51fbb4490ff4', 'ticket documentation',
`Hi there,

Saw your posting, which asks whoever takes it to coordinate employee ticket and certification documentation.

On a drilling crew the tickets change with the role and the site, so that coordination never really finishes.

I build software that runs onboarding by role and files each ticket with its renewal date already set.

{{ASK}}`],

  ['bca45cdc-ac0d-4cc0-8fa1-270c76ce8343', 'training records',
`Hi there,

Saw a posting of yours asking someone to maintain accurate training records and employee certifications.

That line usually means the records live somewhere hand-kept, and the hand changes whenever the person does.

I build software that runs onboarding by role and keeps the training and the certification on one employee record.

{{ASK}}`],

  ['e1918268-b198-4fd8-89e0-e1fe05711149', 'compliance gaps',
`Hi there,

Saw your posting, which asks whoever takes it to track required training, completed courses, renewal dates, and compliance gaps.

The gaps column is the one nobody can trust without re-checking the other three first.

I build software where the gap is simply what the system shows you, because completion and renewal already sit on the record.

{{ASK}}`],

  ['0b31bb12-4bdc-46fe-b1d8-6289c235d645', 'documented qualification',
`Hi there,

Saw a posting of yours setting the standard that no employee operates equipment without documented qualification.

At 400 people that holds only if the documentation happens when someone is set up, rather than when someone checks.

I build software that runs onboarding by role, so the qualification is on the record before the first shift.

{{ASK}}`],

  ['0fb37924-005d-44f2-b6e3-21295296520d', 'training records',
`Hi there,

Saw your posting, which asks whoever takes it to maintain accurate training records and certification tracking.

At 500 people across trades, most of that record starts on somebody's first day, which is usually where it comes apart.

I build software that runs onboarding by role and carries the training and certification on the same record from there.

{{ASK}}`],

  ['70ad4722-feae-491c-b016-0d437a2e2789', 'training attendance',
`Hi Stacey,

Saw a posting of yours covering records of training attendance, certifications, orientations, inspections and corrective actions.

That is one person keeping seven separate lists, and the orientation one quietly feeds most of the others.

I build software that runs onboarding per role, with training and clearances attached to the same record.

{{ASK}}`],

  ['51cc36d5-4497-41b3-96d6-94ebca00999f', 'field personnel credentials',
`Hi there,

Saw a posting of yours asking someone to track certifications, renewal dates, and training records for all field personnel.

At 35 people that is somebody's side job, which is exactly when a renewal slips past unnoticed.

I build software that runs onboarding by role and warns on each credential well before it lapses.

{{ASK}}`],

  ['1aade1af-801e-44ee-98b6-59194da1b7eb', 'expiration dates',
`Hi there,

Saw a posting of yours asking someone to assist with tracking required safety training, certifications, and expiration dates.

Assisting is the tell. It usually means the tracking already exists somewhere and has outgrown whoever built it.

I build software that runs onboarding by role and carries each certification with its expiry already set.

{{ASK}}`],

  ['3ac3e2af-deda-4e0f-8c55-ca88813f450f', 'certification expiry',
`Hi there,

Saw a posting of yours covering certification expiry dates and reaching out to employees to remind them to recertify.

In a licensed trade that reminder is a person remembering, and it repeats for every ticket on every tech.

I build software that runs onboarding by role and sends the recertification warnings itself, to the employee and their manager.

{{ASK}}`],

  ['3d11f818-44d4-4639-8480-8dc5264edaca', 'overdue training',
`Hi there,

Saw a posting of yours covering role-based training assignments, employee acknowledgments, competency records and overdue training.

You have already described the system you want. The gap is that it is five manual jobs rather than one.

I build software that assigns training by role, records the acknowledgment, and chases the overdue ones itself.

{{ASK}}`],

  ['bf297eed-97fe-45fe-ab4c-28560d1da01e', 'training records',
`Hi Connie,

Saw your posting, which asks whoever takes it to coordinate employee training and maintain certification and training records.

Coordinating and recording are two jobs, and the second only stays current while somebody has time for it.

I build software that assigns the training inside onboarding, so finishing it closes the record itself.

{{ASK}}`],

  ['e2416515-dd0f-4a3d-8ee1-9bde7779682f', 'training matrix',
`Hi David,

Saw your posting, which asks whoever takes it to update the company training matrix, organizing training sessions as required.

At 35 people that is a real job hidden inside another one, and it grows with every project you take on.

I build software where the matrix comes from what people have actually completed, so organising the session is the only part left.

{{ASK}}`],

  ['16fa8136-4917-44a7-987e-e60c965bc567', 'training records',
`Hi Carmen,

Saw a posting of yours asking someone to enter, update, and verify training records and certifications.

Entering, updating and verifying the same record three times is what happens when the system underneath is a spreadsheet.

I build software where completing the training writes the record, so there is nothing to enter and nothing to verify.

{{ASK}}`],

  ['5b4df2de-e7cf-4947-a731-9d5abc0e73f7', 'COR audits',
`Hi there,

Saw a posting of yours asking someone to help lead or coordinate internal and external COR audits.

An audit is mostly the act of proving what already happened, which is slow only because the proof is scattered.

I build software that keeps training, tickets and orientation on one employee record, so the evidence is a page rather than a fortnight.

{{ASK}}`],

  ['d4f41686-b3e2-4b12-88e7-e565ca3b2996', 'certification records',
`Hi Natasha,

Saw a posting of yours asking someone to coordinate and maintain certification records, ensuring all staff qualifications are current and compliant.

At 300 staff that currency is a moving target, and it resets with every new hire.

I build software that runs onboarding by role and keeps each qualification on the record with its renewal already set.

{{ASK}}`],

  ['60b9db86-da27-40c0-ae46-a07f6b4b71d4', 'training matrix',
`Hi Rosslyn,

Saw your posting, which asks whoever takes it to verify employee training and maintain employee training matrix.

Verify is the tell. It means the matrix and what actually happened are two separate things that have to be reconciled.

I build software where completing the training is what updates the matrix, so there is nothing left to reconcile.

{{ASK}}`],

  ['3410a6b0-9e10-4368-b74c-951c3b8df1d1', 'audit-ready records',
`Hi Eden,

Saw your posting, which asks whoever takes it to coordinate mandatory training and maintain audit-ready certification records.

You list nine of them, from fall protection to WHMIS, each with its own renewal cycle and its own paperwork.

I build software that runs onboarding by role and carries every one of those on the same employee record.

{{ASK}}`],

  ['5c9a2bad-0a97-4b36-b558-d0aabd82c6e4', 'professional registrations',
`Hi Heather,

Saw a posting of yours asking someone to track professional registrations, licenses, insurance renewals, and other required documentation.

With clinicians working in homes rather than one building, that paperwork is the only proof anybody is covered.

I build software that runs onboarding per clinician and carries each registration with its renewal date already set.

{{ASK}}`],

  ['2ff2ecdf-862d-42b7-84a9-da76a3d3817f', 'training records',
`Hi Jamie,

Saw a posting of yours asking someone to maintain training records, batch records and product release documentation.

Training records sitting beside batch records usually means the same person is audited on both and only one of them is built for it.

I build software that runs onboarding by role and keeps the training and the qualification on one employee record.

{{ASK}}`],

  ['bb725126-3379-4b15-a004-65540db57df5', 'renewal cycles',
`Hi Andrew,

Saw your Safety Officer posting. Class 1 licences, air brake endorsements, driver medicals and rigging tickets, each on a different renewal cycle.

Four cycles per driver is the part that cannot be held in someone's head, and it only shows up when one has already lapsed.

I build software that runs onboarding by role and warns on each of those separately before it expires.

{{ASK}}`],
];

(async () => {
  let ok = 0, bad = 0;
  for (const [id, subject, body] of COPY) {
    const { data: lead, error } = await supabase.from('cadre_leads')
      .select('id, business_name, contact_name, signal_quote').eq('id', id).single();
    if (error) { console.error(`FAIL ${id}: ${error.message}`); bad++; continue; }

    // Run the same validator the generated copy has to pass. Hand-written is not a reason to
    // skip it: round one caught me paraphrasing two prospects' quotes.
    const why = reject(subject, body, lead);
    if (why) { console.error(`REJECT ${String(lead.business_name).slice(0, 32).padEnd(34)}${why}`); bad++; continue; }

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
