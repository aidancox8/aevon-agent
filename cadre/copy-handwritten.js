// Hand-written Cadre copy. Onboarding leads; the credential line is the tail, not the pitch.
//
// KEPT IN THE REPO, NOT IN A SCRATCH FILE. A background personalizer run on 2026-08-25
// regenerated copy over every one of these, and the machine version was worse in three
// consistent ways: no blank line between paragraphs so the whole email is one wall, the signal
// quote dropped in quotation marks like a mail merge, and one lead's body a single 50-word
// sentence of features. It was recoverable only because the scratch file happened to survive.
// Re-run this after any personalizer run that touches these leads.
// Every body quotes the lead's own published sentence verbatim and ends with the {{ASK}} token.
require('dotenv').config({ path: 'C:/Users/Aidan/projects/aevon/agent/.env' });
const supabase = require('C:/Users/Aidan/projects/aevon/agent/lib/supabase');

const COPY = [
  ['d1db18ad-2307-4431-b155-c6bc0269fc3f', 'onboarding a new crew member',
`Hi there,

Saw your posting, which asks whoever takes the role to maintain employee training and certification records.

That line usually means onboarding a new framer is a dozen separate steps, and the records are just where it shows up first.

I build software that runs the whole thing on one record: the role's onboarding path, the training assigned inside it, and the ticket enrolled with its renewal date already set.

{{ASK}}`],

  ['2bef1592-0a33-407b-b761-c39fc09d0031', 'employee files',
`Hi there,

Saw a posting of yours asking someone to update and maintain employee files and certifications.

With 200 people across plumbing, HVAC and fire protection, each trade needs a different set of documents on day one, which is why that job never finishes.

I build software that runs onboarding by role, assigns the training as part of it, and files the ticket with its renewal already set.

{{ASK}}`],

  ['cf41a5d7-2d9a-4593-9a67-866f26c3cdbf', 'training programs',
`Hi there,

Saw your HR Advisor posting asks whoever takes it to coordinate training programs and track certifications.

Those are usually two systems, which is why the second one quietly becomes a spreadsheet.

I build software where they are one thing: a new starter gets the training for their role as part of onboarding, and finishing it closes the record without anyone re-keying it.

{{ASK}}`],

  ['364d0d53-5a5b-4808-8243-5dd89e3ba0f4', 'auditing employee files',
`Hi there,

Saw one of your HR postings describes auditing employee files and sending correspondence to managers and staff about upcoming expiry dates.

At 600 people that audit never really finishes, it just restarts, and it exists because the onboarding it follows was done by hand.

I build software that sets each person up once by role, with training and clearances attached, so the expiry chase sends itself.

{{ASK}}`],

  ['ac7f626f-1939-4ee0-bf1c-555c377a04b2', 'caregiver file setup',
`Hi Sharla,

Saw a posting of yours covering HUB registration and caregiver file setup for contracted caregivers.

Across nine locations that setup is the whole problem: get it right once and the renewals look after themselves, get it wrong and someone is rebuilding a file at audit time.

I build software that runs onboarding per person and per role, with clearances and training attached to the same record.

{{ASK}}`],

  ['85f78ef5-47e5-420f-9729-5a0551ea8518', 'the Caliber matrix',
`Hi Tim,

Saw your Site Safety Officer posting asks whoever takes it to ensure that Caliber training matrix is updated and that all employee training and certifications are up to date.

You describe Caliber as building people and processes that happen to do construction, which is a better description of onboarding than most software companies manage.

I build the system underneath it: role-based onboarding with the training inside it, so the matrix stops being a separate job.

{{ASK}}`],

  ['b949f216-22d8-401d-8b7c-b41f9385b007', 'technical training records',
`Hi Nadine,

Saw you are hiring a Technical Training Manager to track certifications, qualifications, compliance requirements, and training records.

Four things to keep current, and every one of them starts on somebody's first day, which is where they usually come apart.

I build software that runs onboarding by role and carries the training and qualifications on the same record from there.

{{ASK}}`],

  ['3dda5cd0-2055-4e5b-8de9-946636962dc8', 'two matrices',
`Hi there,

Saw a posting of yours asks an HR Generalist to maintain and update the training matrix and performance review matrix for all employees.

Two matrices, both hand-kept, both fed by what happened when someone joined.

I build software that runs onboarding by role and keeps training, reviews and credentials on one employee record, so neither matrix needs maintaining separately.

{{ASK}}`],

  ['e02b4d36-9467-4f0d-a340-e5574273098a', 'EPA and NATE',
`Hi there,

Saw a posting of yours asks someone to track employee certifications, licenses, training records, EPA certifications, and NATE certifications.

Five categories on one person, across Dayton, Columbus and Cincinnati, all of it starting from how each tech was set up on day one.

I build software that runs onboarding by role, assigns the training with it, and enrolls each license with its renewal date already set.

{{ASK}}`],

  ['f1ee8965-04c4-4414-b803-6c8e1306c506', 'training matrices',
`Hi Mike,

Saw you are hiring an Assistant Safety Manager to maintain training matrices and competency records, and monitor certification expiries and recertification requirements.

That is a full job on its own, and most of it traces back to how people are set up when they start.

I build software that runs onboarding by role across entities, with competency and expiry carried on the same record.

Before you fill that role, worth seeing what it takes off the desk?`],

  ['53ff409a-a369-4514-b205-fd0de3084f6a', 'training documentation',
`Hi PJ,

Saw your Employee Experience Coordinator posting asks them to maintain all employee training documentation in Dayforce.

Dayforce is good at payroll and not built to run an onboarding path or watch a ticket expire, which is usually why the documentation part becomes a person's job.

I build software that runs onboarding by role and keeps the training and credentials on the same record.

{{ASK}}`],

  ['fd622a07-b671-4d44-9084-79548b5992de', 'welder qualifications',
`Hi there,

Saw a posting of yours asks someone to track welder qualification expiry dates and notify the QC Manager and Production Manager of upcoming renewals in advance.

That notification is a person remembering, and it starts from however the welder was set up when they joined.

I build software that runs onboarding by role and sends those renewal warnings itself, to the welder and both managers.

{{ASK}}`],

  ['65af4408-de9b-40f0-89a0-0214fb75f10f', 're-training',
`Hi there,

Saw a posting of yours asks whoever takes it to keep track of employee training, competencies and schedule re-training.

Scheduling the re-training is the part that slips, because nothing tells you it is due until someone checks.

I build software that runs onboarding by role, assigns the training inside it, and schedules the re-training itself.

{{ASK}}`],

  ['00f1caf9-3187-4c81-9fa4-f4e1642e999d', 'physician credentialing',
`Hi there,

Saw your IME Coordinator posting has one person handling physician CV's/credentialing along with appointment scheduling and fee approvals.

Credentialing sitting beside scheduling usually means it is done from memory rather than from a system.

I build software that runs onboarding for each clinician by role, with credentials and their renewal dates carried on the same record.

{{ASK}}`],
  ['17f80936-2a76-4094-ba9a-8a929cefd2da', 'employee training',
`Hi there,

Saw a posting of yours asking whoever takes it to maintain accurate records of employee training and certifications.

Across the programs you run in St. John's, most of that record starts on somebody's first day, which is usually where it comes apart.

I build software that runs onboarding by role, assigns the training as part of it, and keeps the certification on the same record with its renewal already set.

{{ASK}}`],

];

(async () => {
  let ok = 0;
  for (const [id, subject, body] of COPY) {
    const { error } = await supabase.from('cadre_leads')
      .update({ email_subject: subject, email_body: body.trim(), personalization_basis: 'hand-written from published signal quote' })
      .eq('id', id);
    if (error) { console.error(`FAIL ${id}: ${error.message}`); continue; }
    ok++;
  }
  console.log(`wrote ${ok} of ${COPY.length}`);
})();
