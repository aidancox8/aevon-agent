#!/usr/bin/env node
/**
 * cadre/load-drafts.js — load the hand-written drafts onto their leads and schedule them.
 *
 * These are written by hand rather than generated, because the campaign's premise is quoting
 * the prospect's own published sentence and there are only a handful of leads with both a
 * verified address and a named person. A generator would add nothing except the risk of
 * paraphrasing a quote, which is the one thing that must stay exact.
 *
 * Scheduling is staggered one working day apart rather than fired in a batch. Two reasons:
 * a cold domain sending five at once to five different providers looks worse than five spread
 * out, and a spread means an early bounce or reply can change what the later ones say.
 *
 *   node cadre/load-drafts.js --dry
 *   node cadre/load-drafts.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const supabase = require('../lib/supabase');

const DRY = process.argv.includes('--dry');

/** 9:40am Pacific on the Nth working day from today, which is inside the send window. */
function workingDayFromNow(n) {
  const d = new Date();
  d.setUTCHours(16, 40, 0, 0); // 09:40 PDT
  let added = 0;
  if (d < new Date()) added = -1; // today's slot has passed, start tomorrow
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d.toISOString();
}

/** [business_name, subject, body] — body must contain the lead's own quoted words. */
const DRAFTS = [
  ['MJ Roofing & Supply Ltd.', 'training records',
`Hi Nathan,

Saw you were hiring a Safety Officer, and the posting bundles orientations, toolbox talks and maintaining employee training records and certifications into the one role.

With 120 roofers on fall protection and aerial platform tickets, the records half usually grows until it is most of the job.

I build software where completing the training clears the record itself, so nobody re-keys it.

Is that a real annoyance at MJ, or handled?`],

  ['North Mountain Construction', 'training records',
`Hi Gabe,

Saw your Construction Safety Officer posting: ensure compliance with WorkSafeBC regulations and COR requirements.

You publish 17 people on your leadership page and not one of them is HR or safety, so I am guessing the records for that sit with whoever has time between Nelson and Fernie.

I build software that keeps training and certification records on the employee rather than in a binder, so a COR audit is a page rather than a week.

Is that a real problem at North Mountain, or handled?`],

  ['AgWest Ltd.', 'competency matrices',
`Hi Laura,

Saw you are advertising for a Training and Safety Coordinator, and a recent posting of yours asks whoever holds it to maintain employee training records, certifications, and competency matrices.

Across eight branches that is one spreadsheet per thing, kept current by hand.

I build software that holds those on the employee record instead, so a renewal closes itself off and the branch view is just a filter.

Before you fill that role, worth seeing what the software side removes from it?`],

  ['Advance Paper Box Ltd.', 'the training matrix',
`Hi Yeti,

Saw a recent posting of yours puts maintaining the FSQMS Training Matrix on a QA Technician, along with chasing who has completed what.

Under a food safety QMS that matrix is audit evidence, which is a lot to rest on one person keeping a spreadsheet current.

I build software where training completion updates the record and the audit view is just a page.

Worth a look, or is the current setup fine?`],

  ['Heartland Coatings Ltd.', 'worker tickets',
`Hi Trevor,

Saw a posting of yours asking whoever holds the role to submit and maintain worker safety tickets and keep crews meeting client site requirements.

When that sits with a manager rather than a system, it works right up until a crew gets turned away at a gate.

I build software that keeps each worker's tickets current and flags them before a site does.

How much of your week does that actually take?`],
];

(async () => {
  let n = 0;
  for (const [name, subject, body] of DRAFTS) {
    const { data: lead, error: readErr } = await supabase.from('cadre_leads')
      .select('id, email, contact_name, signal_quote, status').eq('business_name', name).single();
    if (readErr || !lead) { console.log(`MISS  ${name}`); continue; }
    if (!lead.email) { console.log(`SKIP  ${name} - no address`); continue; }
    if (lead.status !== 'queued') { console.log(`SKIP  ${name} - status is ${lead.status}`); continue; }

    const when = workingDayFromNow(n);
    console.log(`${DRY ? '[dry] ' : ''}${String(n + 1).padStart(2)}. ${name.slice(0, 32).padEnd(34)}${lead.email.padEnd(34)}${when.slice(0, 16).replace('T', ' ')} UTC`);

    if (!DRY) {
      const { error } = await supabase.from('cadre_leads').update({
        email_subject: subject, email_body: body, scheduled_send_at: when, send_batch: 1,
      }).eq('id', lead.id);
      if (error) { console.error(`      FAILED: ${error.message}`); continue; }
    }
    n++;
  }
  console.log(`\n${DRY ? 'Would schedule' : 'Scheduled'} ${n} send(s), one per working day.`);
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
