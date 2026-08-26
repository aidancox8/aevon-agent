#!/usr/bin/env node
/**
 * cadre/followups-2.js — follow-up copy for the leads whose first touch went out 2026-08-26.
 *
 * These ten sent with no follow-up written, because rounds two and three of the hand-written
 * copy only covered email 1 and nobody noticed until the first live day, when the sender booked
 * no second touch for them and their sequences would have silently ended at one email. The
 * booking is fixed (the sender now books the slot regardless and blocks loudly if copy is
 * missing when it comes due); this supplies the copy before that block fires on Sep 2.
 *
 * Same rules as cadre/followups.js: touch 2 adds ONE concrete thing email 1 did not say, no
 * restating the quote (the thread already carries it), no "circling back". Touch 3 says plainly
 * it is the last one and asks for nothing.
 *
 *   node cadre/followups-2.js --dry
 *   node cadre/followups-2.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const supabase = require('../lib/supabase');

const DRY = process.argv.includes('--dry');

/** [id, business, touch-2 body, touch-3 body] */
const COPY = [
  ['52268ee5-e77b-4561-8a2f-0b2a31df76ad', 'Maritect Investigations & Security Limited',
`Hi there,

One thing I left out. Security licences carry their own renewal dates on each guard's record, so the warning goes to the guard and the office before anything lapses, not after a client asks.

For a licensed firm that is the difference between a record and a liability.

Worth ten minutes?`,
`Hi there,

Last one from me on this.

If licence and training records are already under control, no reply needed and I will leave it there.

If it is worth a look later in the year, say so and I will come back then.`],

  ['24aa39ef-893b-4600-94b4-98326e888345', 'Vogel Bros. Building Co.',
`Hi there,

One thing worth adding. Each certification carries its own expiration and warns the employee and their super separately, so nothing depends on one person re-checking a sheet.

On active jobsites that is usually what ends the week-before scramble.

Worth ten minutes?`,
`Hi there,

Last note from me.

If safety training records are already handled, no reply needed.

If it is worth revisiting later, tell me when and I will come back then.`],

  ['4815411e-febf-4bbc-9d14-e2c9a669ed97', 'White Rock Mechanical Services',
`Hi there,

One thing I did not say. A COR audit stops being an event when the evidence already sits on each employee's record: training, tickets and orientation in one place, produced as a page.

At 60 people that is one person's fortnight given back.

Worth ten minutes?`,
`Hi there,

Last one from me.

If the COR paperwork is fine as it is, no reply needed and I will leave you alone.

If it is worth a look before the next audit, say so.`],

  ['def2d088-8055-45a0-a59d-54f125f1538d', 'Cyclone Manufacturing Inc.',
`Hi there,

One thing worth adding. Because completing the training writes the record, the ISO prep audit of your own trackers stops existing: the tracker and what happened are the same thing.

At 650 people that is the job your posting describes, removed rather than staffed.

Worth ten minutes?`,
`Hi there,

Last note from me on this.

If audit prep is already under control, no reply needed.

If it is worth seeing before the next ISO cycle, tell me when.`],

  ['aba49f5f-65e7-4fef-957d-acc7fa1ff6e9', 'ATS Traffic Ltd.',
`Hi there,

One thing I left out. At 500 people across branches, the branch view matters as much as the record: each manager sees their own people's expiries without anyone building them a report.

That is usually what the spreadsheets were trying to be.

Worth ten minutes?`,
`Hi there,

Last one from me.

If the training databases are working as they are, no reply needed and I will leave it there.

If it is worth a look later, say so and I will come back then.`],

  ['7e52bec4-b620-45dc-8bf1-61c290132128', 'Advance Paper Box Ltd.',
`Hi Yeti,

One thing worth adding. Online and in-person sessions land on the same record, so the FSQMS matrix reflects both without anyone reconciling two lists before an audit.

In food packaging that reconciliation is usually the hidden job.

Worth ten minutes?`,
`Hi Yeti,

Last note from me.

If the FSQMS side is already handled, no reply needed.

If it is worth revisiting after the next audit, tell me when.`],

  ['1e8589c7-0469-4854-9fe5-ff6aa3b7af1e', 'Superior Cabinets',
`Hi Yvonne,

One thing I did not mention. The trainer runs the session and the system does the rest: attendance closes the record, the renewal is booked from the completion date, and nobody re-keys anything.

At 300 people that is most of the second job your posting describes.

Worth ten minutes?`,
`Hi Yvonne,

Last one from me on this.

If safety training records are already in hand, no reply needed and I will leave it there.

If it is worth a look later in the year, say so.`],

  ['0a2dc2db-9e31-49d4-a4e5-90100bbae396', 'Path Environmental Technology',
`Hi there,

One thing worth adding. Company, client and regulatory requirements can each be their own view of the same records, so "are we compliant for this client" has an answer per client rather than one blended matrix.

That is usually the question that takes a day to answer by hand.

Worth ten minutes?`,
`Hi there,

Last note from me.

If the safety training matrix is under control, no reply needed.

If it is worth seeing later, tell me when and I will come back then.`],

  ['70f33569-e16b-47da-b9d4-2729c47439db', 'Inline Group Inc.',
`Hi there,

One thing I left out. Participation and completion stop being two numbers: signing off the session writes the completion, and the renewal counts from that date automatically.

That removes the drift your posting is really describing.

Worth ten minutes?`,
`Hi there,

Last one from me.

If training tracking is already handled, no reply needed and I will leave it there.

If it is worth a look when things quieten down, say so.`],

  ['70ad4722-feae-491c-b016-0d437a2e2789', 'Union Gospel Mission',
`Hi Stacey,

One thing worth adding. Volunteers can sit on the same system as staff, with their own onboarding path and clearances, rather than in a separate list nobody owns.

For an organisation your size that is usually the messier half of the records.

Worth ten minutes?`,
`Hi Stacey,

Last note from me on this.

If training and certification records are already under control, no reply needed.

If it is worth a look later in the year, tell me when and I will come back then.`],
];

function reject(body) {
  const words = body.trim().split(/\s+/).length;
  if (words > 90) return `${words} words, too long for a follow-up`;
  if (/\bcircl(e|ing) back|following up|bumping this|touching base|per my last\b/i.test(body)) return 'filler follow-up phrase';
  if (/\bour (clients|customers)\b|\bcompanies like\b/i.test(body)) return 'implies customers that do not exist';
  if (/\$|\bpricing\b|\bper user\b/i.test(body)) return 'mentions price';
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
