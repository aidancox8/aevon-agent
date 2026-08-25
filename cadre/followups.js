#!/usr/bin/env node
/**
 * cadre/followups.js — hand-written follow-up copy for the two touches after email 1.
 *
 * WHY IT IS HAND-WRITTEN. The same reason email 1 is. A model given "write a follow-up" produces
 * "just circling back on my note below", which is the single most ignored sentence in cold email
 * because it contains no information: it tells the reader only that you want something.
 *
 * THE SHAPE OF EACH TOUCH.
 *
 *   Touch 2, about a week later. Adds ONE concrete thing email 1 did not say, chosen for that
 *   company specifically. It has to be worth opening on its own, because it will be read on its
 *   own. No restating the quote: the thread already carries it, and repeating it reads as a mail
 *   merge, which is exactly what we are trying not to be.
 *
 *   Touch 3, about a week after that. The close-out. Says plainly that this is the last one and
 *   gives them an easy exit. Consistently the highest-replying message in a cold sequence, for
 *   an unglamorous reason: it is the only one that asks for nothing.
 *
 * Neither touch mentions price, and neither invents a customer. There are no customers to cite
 * beyond the clinic that actually runs it, which is Aidan's own workplace and is described as
 * exactly that.
 *
 *   node cadre/followups.js --dry
 *   node cadre/followups.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const supabase = require('../lib/supabase');

const DRY = process.argv.includes('--dry');

/** [id, business, touch-2 body, touch-3 body] */
const COPY = [
  ['9a686624-68c4-4fac-a400-9af3ac45db46', 'AgWest Ltd.',
`Hi Laura,

One thing I left out. The competency side is where most of these systems stop being a filing cabinet: each role carries the list of what someone has to be signed off on, and the gaps show up as a gap rather than as nothing.

For a dealer network across sites that is usually the first useful screen.

Worth ten minutes?`,
`Hi Laura,

Last one from me on this.

If competency tracking is already handled or it is just not this year's problem, no reply needed and I will leave it there.

If it is worth a look in a few months, say so and I will come back then instead.`],

  ['5aafbac0-68f4-4d3c-b0f6-1a73ab2e59a2', 'North Mountain Construction',
`Hi Gabe,

Worth adding one thing. The part crews actually notice is that the reminders go to the person whose ticket it is, not only to the office, at sixty, thirty and seven days.

That alone tends to end the week-before scramble.

Worth ten minutes?`,
`Hi Gabe,

Last note from me.

If this is not something you are looking at, no reply needed and I will leave you alone.

If the timing is just wrong, tell me when and I will come back then.`],

  ['22c52ab9-722e-4fc8-b93b-4b7ce2f2c72b', 'MJ Roofing & Supply Ltd.',
`Hi Nathan,

One detail I did not include. Safety orientation can be the first step of the onboarding path rather than a separate session to chase: the new hire gets it before day one, and finishing it ticks the record itself.

At a hundred and twenty people that is most of the chasing gone.

Worth ten minutes?`,
`Hi Nathan,

Last one from me on this.

If orientations and training records are already under control, no reply needed.

If it is worth revisiting later in the year, say the word and I will come back then.`],

  ['17f80936-2a76-4094-ba9a-8a929cefd2da', 'Choices For Youth',
`Hi there,

One thing worth adding. Volunteers can sit on the same system as staff, with their own onboarding path and their own clearances, rather than in a separate spreadsheet nobody owns.

For an organisation running programs across the city that is usually the messier half.

Worth ten minutes?`,
`Hi there,

Last note from me.

If staff and volunteer records are already handled, no reply needed and I will leave it there.

If it is worth a look once the year settles, tell me when.`],

  ['b949f216-22d8-401d-8b7c-b41f9385b007', 'Collicutt Energy Services Corp.',
`Hi Nadine,

One thing I should have said. Qualifications that differ by site or by customer can live on the same record as the general training, so a tech showing up somewhere new is either cleared or visibly not.

At three hundred and fifty people that is the question a training manager gets asked most.

Worth ten minutes?`,
`Hi Nadine,

Last one from me.

If the training manager role covers this already, no reply needed.

If it is worth seeing once someone is in the seat, say so and I will come back then.`],

  ['3dda5cd0-2055-4e5b-8de9-946636962dc8', 'ALMAG Aluminum',
`Hi there,

One thing I left out. Because reviews and training sit on the same employee record, a review can show what someone has actually been signed off on rather than what somebody remembers.

That is usually why the two matrices existed separately in the first place.

Worth ten minutes?`,
`Hi there,

Last note from me on this.

If the matrices are working as they are, no reply needed and I will leave it there.

If it is worth a look later, tell me when and I will come back then.`],

  ['ac7f626f-1939-4ee0-bf1c-555c377a04b2', 'Taproot Community Support Services Ltd.',
`Hi Sharla,

One thing worth adding. Contracted caregivers can carry their own onboarding path and their own clearance expiries, separate from employed staff, on the same system.

Across nine locations that is usually where the audit questions land.

Worth ten minutes?`,
`Hi Sharla,

Last one from me.

If caregiver file setup is already handled, no reply needed and I will not write again.

If it is worth revisiting after the next audit cycle, say so and I will come back then.`],

  ['00f1caf9-3187-4c81-9fa4-f4e1642e999d', 'Footbridge Centre for Integrated Orthopaedic Care',
`Hi there,

One thing I did not mention. Clinician credentials can carry their own renewal dates and warn the clinic well before a licence lapses, rather than the coordinator holding it in their head alongside scheduling.

At forty people that is one job made smaller rather than one more system.

Worth ten minutes?`,
`Hi there,

Last note from me.

If credentialing is fine as it is, no reply needed and I will leave it there.

If it is worth a look when the coordinator role settles, tell me when.`],

  ['e02b4d36-9467-4f0d-a340-e5574273098a', 'Logan A/C & Heat Services',
`Hi there,

One thing worth adding. Each certification carries its own renewal window, so an EPA card and a NATE cert on the same tech warn separately rather than being chased together once a year.

Across three cities that is usually what makes the spreadsheet unworkable.

Worth ten minutes?`,
`Hi there,

Last one from me on this.

If certification tracking is already in hand, no reply needed.

If it is worth seeing later in the year, say the word and I will come back then.`],

  ['f1ee8965-04c4-4414-b803-6c8e1306c506', 'Surespan Construction Ltd.',
`Hi Mike,

One thing I should have included. The matrix can be a view rather than a document: it is generated from what each person has actually completed, so it is never out of date and nobody maintains it.

That is normally the difference between a safety role and a data-entry role.

Worth ten minutes?`,
`Hi Mike,

Last note from me.

If the assistant safety manager role covers this, no reply needed and I will leave it there.

If it is worth a look once they are in place, tell me when.`],

  ['d1db18ad-2307-4431-b155-c6bc0269fc3f', 'Ron Anderson & Sons Ltd.',
`Hi there,

One thing I left out. A new framer's ticket, their orientation and their equipment sign-out can all be part of the same first-day path, so the record exists before anyone has to go looking for it.

At sixty people that removes the step where somebody remembers.

Worth ten minutes?`,
`Hi there,

Last one from me.

If onboarding is working as it is, no reply needed and I will leave you alone.

If it is worth revisiting before next season, say so and I will come back then.`],

  ['3ac3e2af-deda-4e0f-8c55-ca88813f450f', 'Black Tusk Fire & Security Inc.',
`Hi there,

One thing worth adding. Security licences and fire certifications can each carry their own expiry and warn the tech and their manager separately, rather than one list somebody checks monthly.

In a licensed trade that is usually the risk nobody has time to watch.

Worth ten minutes?`,
`Hi there,

Last note from me on this.

If certification tracking is already handled, no reply needed.

If it is worth a look later, tell me when and I will come back then.`],

  ['fd622a07-b671-4d44-9084-79548b5992de', '5Blue Process Equipment Inc.',
`Hi there,

One thing I did not say. The renewal warning can go to the welder as well as to QC and production, which is usually what stops a qualification lapsing quietly.

Nobody has to remember, and nobody has to be told twice.

Worth ten minutes?`,
`Hi there,

Last one from me.

If welder qualifications are already tracked properly, no reply needed and I will leave it there.

If it is worth seeing later, say so and I will come back then.`],

  ['65af4408-de9b-40f0-89a0-0214fb75f10f', 'Progressive Ventures Construction Ltd.',
`Hi there,

One thing worth adding. Re-training can be scheduled from the completion date itself, so the next round is booked the moment the last one closes rather than when somebody notices.

That is the part that usually slips on a busy year.

Worth ten minutes?`,
`Hi there,

Last note from me.

If training and re-training are already handled, no reply needed.

If it is worth a look when things quieten down, tell me when.`],

  ['53ff409a-a369-4514-b205-fd0de3084f6a', 'Phantom Screens',
`Hi PJ,

One thing I should have added. It sits alongside Dayforce rather than replacing it: payroll stays where it is, and the onboarding path and the expiry watching happen somewhere built for them.

That is usually the objection worth answering first.

Worth ten minutes?`,
`Hi PJ,

Last one from me on this.

If the employee experience role covers this already, no reply needed and I will leave it there.

If it is worth a look once they are settled, say so and I will come back then.`],

  ['cf41a5d7-2d9a-4593-9a67-866f26c3cdbf', 'Kootenay Co-op',
`Hi there,

One thing I left out. Food safety and any other renewable training can run on the same path as the rest of onboarding, so a new department hire is signed off before their first shift rather than after it.

That tends to be the part that gets skipped when it is busy.

Worth ten minutes?`,
`Hi there,

Last note from me.

If training and certifications are already coordinated well, no reply needed.

If it is worth a look later, tell me when and I will come back then.`],

  ['85f78ef5-47e5-420f-9729-5a0551ea8518', 'Caliber Projects Ltd.',
`Hi Tim,

One thing worth adding. The matrix can be generated from what people have actually completed rather than kept by hand, so it is right on the day somebody asks for it.

For a company that describes itself as building people first, that seems like the version worth having.

Worth ten minutes?`,
`Hi Tim,

Last one from me.

If the safety officer role covers this, no reply needed and I will leave it there.

If it is worth seeing once they are in place, say so and I will come back then.`],

  ['364d0d53-5a5b-4808-8243-5dd89e3ba0f4', 'Pacific Coast Community Resources Inc.',
`Hi there,

One thing I did not include. The expiry correspondence can go out on its own, to the staff member and their manager, at sixty, thirty and seven days.

At six hundred people that is the audit turning into something that runs rather than something somebody does.

Worth ten minutes?`,
`Hi there,

Last note from me on this.

If the file audit is already under control, no reply needed and I will leave you alone.

If it is worth a look later in the year, tell me when.`],

  ['2bef1592-0a33-407b-b761-c39fc09d0031', 'PML Professional Mechanical Ltd.',
`Hi there,

One thing worth adding. Plumbing, HVAC and fire protection can each have their own onboarding path and their own document set, so a new hire in one trade never gets the other trade's checklist.

At two hundred people that is usually why the file job never ends.

Worth ten minutes?`,
`Hi there,

Last one from me.

If employee files and certifications are already handled, no reply needed.

If it is worth revisiting later, say so and I will come back then.`],
];

/**
 * Guard rails, checked before anything is written. These are the same failures that had to be
 * caught by hand on email 1.
 */
function reject(body, business) {
  const words = body.trim().split(/\s+/).length;
  if (words > 90) return `${words} words, too long for a follow-up`;
  if (/\bcircl(e|ing) back|following up|bumping this|touching base|per my last\b/i.test(body)) {
    return 'contains a filler follow-up phrase';
  }
  if (/\bour (clients|customers)\b|\bcompanies like\b|\bwe help \d/i.test(body)) {
    return 'implies customers that do not exist';
  }
  if (/\$|\bprice|\bpricing\b|\bper user\b/i.test(body)) return 'mentions price';
  if (!/\n\n/.test(body)) return 'no paragraph breaks';
  return null;
}

(async () => {
  let ok = 0, bad = 0;
  for (const [id, business, fu1, fu2] of COPY) {
    const problems = [
      ['touch 2', reject(fu1, business)],
      ['touch 3', reject(fu2, business)],
    ].filter(([, p]) => p);
    if (problems.length) {
      bad++;
      for (const [which, p] of problems) console.error(`REJECT ${business} ${which}: ${p}`);
      continue;
    }
    if (DRY) { ok++; continue; }
    const { error } = await supabase.from('cadre_leads').update({
      followup_subject: 'follow-up',       // the sender rewrites this as "Re: <original>" so it threads
      followup_body: fu1.trim(),
      followup2_subject: 'follow-up',
      followup2_body: fu2.trim(),
    }).eq('id', id);
    if (error) { console.error(`FAIL ${business}: ${error.message}`); bad++; continue; }
    ok++;
  }
  console.log(`${DRY ? 'Would write' : 'Wrote'} follow-ups for ${ok} lead(s), ${bad} rejected.`);
})().catch(e => { console.error(e.message); process.exit(1); });
