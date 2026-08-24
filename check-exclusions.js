#!/usr/bin/env node
// Guards a standing rule: Aidan's employer and Artus must never be emailed by any campaign.
//
// This exists because the rule was enforced only at lead-discovery time. A row that reached
// the table another way was unprotected, and on 2026-08-06 Changepain was found queued in
// tempo_leads one send away from going out. Both senders now check at send time.
const { excludedOrgReason, dncReason } = require('./tempo/dnc');

const CASES = [
  // [business name, email, must be blocked]
  ['Changepain Medical & Allied Health Clinic', 'privateservices@changepain.ca', true],
  ['Changepain', 'anything@example.com', true],
  ['Change Pain Clinic', 'hello@example.com', true],
  ['Some Other Clinic', 'info@changepain.ca', true],
  ['Some Other Clinic', 'info@change-pain.ca', true],
  ['Artus Health Centre', 'info@artushealth.ca', true],
  // Must NOT be blocked: real prospects with superficially similar names.
  ['Vancouver Physiotherapy', 'info@vanphysio.ca', false],
  ['Pain Free Clinic', 'info@painfree.ca', false],
  ['Artistic Wellness Studio', 'hi@artisticwellness.ca', false],
  ['Changing Habits Health', 'info@changinghabits.ca', false],

  // Added 2026-08-24. Matched with separators stripped so every spelling catches.
  ['Brenda Lau MD', null, true],
  ['brendalaumd', null, true],
  ['Dr. Brenda Lau Medical Corporation', null, true],
  ['Some Clinic', 'info@brendalaumd.com', true],
  ['Some Clinic', 'info@brenda-lau-md.ca', true],
];

let bad = 0;
for (const [name, email, expected] of CASES) {
  const got = !!excludedOrgReason(name, email);
  const ok = got === expected;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${expected ? 'block' : 'allow'}  ${name.padEnd(42)}${email}`);
}
console.log(`\n${CASES.length - bad}/${CASES.length} passed`);
if (dncReason(null, 'privateservices@changepain.ca')) {
  console.log('note: the people-list gate also catches it now');
}
process.exit(bad ? 1 : 0);
