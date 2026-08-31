/**
 * The matcher that decides whether a Google Places result is the same company as the lead.
 *
 * These cases exist because city-exact matching silently returned almost nothing: the lead's city
 * comes from a job posting (where the work is) and Places returns the registered address, and for
 * most companies those differ. Run with: node cadre/find-websites.test.mjs
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

// Pull the pure functions out of the script rather than duplicating them here, so the test
// cannot drift from what actually runs.
const src = readFileSync(new URL('./find-websites.js', import.meta.url), 'utf8');
const start = src.indexOf('const fold =');
const end = src.indexOf('const SOCIAL =');
const { fold, regionOf, cityOf, placeMatches } = await import(
  'data:text/javascript,' + encodeURIComponent(
    src.slice(start, end) + '\nexport { fold, regionOf, cityOf, placeMatches };'
  )
);

const cases = [
  // Same region, different city: the case that was wrongly rejected and cost the whole run.
  ['Abbotsford BC', '13911 Wireless Way, Richmond, BC V6V 3B9, Canada', true],
  ['Sugar Land, TX', '1 Main St, Houston, TX 77002, USA', true],
  // Different region: still rejected, which is the point of keeping a location test at all.
  ['Sugar Land, TX', '1 Main St, Ottawa, ON K1K 0T8, Canada', false],
  ['Vancouver BC', '400 Yonge St, Toronto, ON M5B, Canada', false],
  // No region code (UK, IE): fall back to the town name.
  ['Watford', '12 High St, Watford WD17 1AB, UK', true],
  ['Watford', '12 High St, Leeds LS1 4AB, UK', false],
  // Region token must not match inside a word: "on" should not hit "Toronto".
  ['Somewhere, ON', '5 King St W, Toronto, ON M5H 1A1, Canada', true],
  ['Somewhere, ON', '5 Rue Principale, Montreal, QC H2X, Canada', false],
  // Nothing to contradict.
  ['', '1 Any St, Anywhere', true],
];

let failed = 0;
for (const [city, addr, want] of cases) {
  const got = placeMatches(city, addr);
  if (got !== want) {
    failed += 1;
    console.log(`FAIL  ${JSON.stringify(city).padEnd(18)} vs ${addr.slice(0, 42).padEnd(44)} got ${got}, want ${want}`);
  }
}

assert.strictEqual(regionOf('Sugar Land, TX'), 'tx');
assert.strictEqual(regionOf('Abbotsford BC'), 'bc');
assert.strictEqual(regionOf('Watford'), null);
assert.strictEqual(cityOf('Sugar Land, TX'), 'sugar land');
assert.strictEqual(cityOf('Abbotsford BC'), 'abbotsford');

console.log(failed === 0 ? `ok: ${cases.length} placeMatches cases pass` : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
