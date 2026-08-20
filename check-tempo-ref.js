#!/usr/bin/env node
// Attribution used to live in the HTML builder. The plain-text fix on 2026-08-18 stopped
// calling it, so every Tempo send since went out with a bare demo link and no way to tell who
// opened it, on a campaign that already had no open or click data at all.
const { tagDemoLink } = require('./tempo/sender');

const ID = 'e8196cd4-dce2-496a-94bd-7b842b93db3f';
const CASES = [
  ['here is a working demo: clinic-scheduler-demo.web.app. It builds the schedule',
   `here is a working demo: clinic-scheduler-demo.web.app/?ref=${ID}. It builds the schedule`],
  ['a multi-provider clinic here: clinic-scheduler-demo.web.app',
   `a multi-provider clinic here: clinic-scheduler-demo.web.app/?ref=${ID}`],
  ['see allied-scheduler-demo.web.app/ for the allied preset',
   `see allied-scheduler-demo.web.app/?ref=${ID} for the allied preset`],
  // Re-running a send must not stack refs.
  [`already tagged clinic-scheduler-demo.web.app/?ref=${ID} stays put`,
   `already tagged clinic-scheduler-demo.web.app/?ref=${ID} stays put`],
  ['no link in this one at all', 'no link in this one at all'],
];

let bad = 0;
for (const [input, want] of CASES) {
  const got = tagDemoLink(input, ID);
  const ok = got === want;
  if (!ok) { bad++; console.log(`FAIL\n  got  ${got}\n  want ${want}`); }
  else console.log(`ok    ${got.slice(0, 78)}`);
}

// The visible text must equal the destination. Anchor/href disagreement is what got the HTML
// build quarantined as PHISHING, and it is the reason this tags the URL the reader can see.
const out = tagDemoLink('demo: clinic-scheduler-demo.web.app', ID);
if (/<a |href=/.test(out)) { bad++; console.log('FAIL  introduced markup into a plain-text body'); }
else console.log('ok    still plain text, visible url is the destination');

console.log(`\n${CASES.length + 1 - bad}/${CASES.length + 1} passed`);
process.exit(bad ? 1 : 0);
