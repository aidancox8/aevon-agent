#!/usr/bin/env node
// Every case below is drawn from real recorded click data, including the 14 leads the previous
// version of this classifier reported as warm humans when every click was a link scan.
const { classifyVisits, visitTier, batchClickKeys } = require('./lib/visit-quality');

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/18.7 Mobile/15E148 Safari/604.1';
const t = (day, hour) => `2026-07-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`;
const click = (ts, ua = CHROME) => ({ created_at: ts, metadata: { ua } });

const CASES = [
  {
    label: 'Reid Brothers: 5 clicks, every one under a minute from a send',
    visits: [1, 8, 15].map(d => click(t(d, 9))).concat([click(t(8, 9)), click(t(15, 9))]),
    sends: [t(1, 9), t(8, 9), t(15, 9)],
    expect: 'scanner',
  },
  {
    label: 'three-email sequence scanned three times, three separate days',
    visits: [click(t(1, 9)), click(t(8, 9)), click(t(15, 9))],
    sends: [t(1, 9), t(8, 9), t(15, 9)],
    expect: 'scanner',
  },
  {
    label: 'the old bug: scan of email 3 looks like a return visit 14 days later',
    visits: [click(t(15, 9))],
    sends: [t(1, 9), t(8, 9), t(15, 9)],
    expect: 'scanner',
  },
  {
    label: 'declared bot agent',
    visits: [click(t(3, 14), 'Mozilla/5.0 (compatible; Proofpoint-Scanner/1.0)')],
    sends: [t(1, 9)],
    expect: 'scanner',
  },
  {
    label: 'Madison Eyes: many clicks hours and days later, phone included',
    visits: [click(t(1, 9)), click(t(1, 12), IPHONE), click(t(3, 16)), click(t(10, 11), IPHONE), click(t(14, 15))],
    sends: [t(1, 9), t(8, 9)],
    expect: 'strong',
  },
  {
    label: 'two clicks well after the send, different days',
    visits: [click(t(2, 15)), click(t(5, 11), IPHONE)],
    sends: [t(1, 9)],
    expect: 'probable',
  },
  {
    label: 'a single click two hours after the send, real but unconfirmable',
    visits: [click(t(1, 11))],
    sends: [t(1, 9)],
    expect: 'weak',
  },
  {
    label: 'a click with no matching send at all',
    visits: [click(t(4, 13))],
    sends: [],
    expect: 'weak',
  },
  {
    label: 'in-window mobile click proves nothing on its own',
    visits: [click(t(1, 9), IPHONE)],
    sends: [t(1, 9)],
    expect: 'scanner',
  },
];

// A recorded burst: 15 unrelated leads clicked inside the same 15 minutes, hours after any
// of their sends. Every one looks "unexplained" against its own send and none of them is real.
const BURST_AT = '2026-07-18T18:22:00Z';
const burst = Array.from({ length: 15 }, (_, i) => ({ lead_id: `other-${i}`, created_at: BURST_AT }));
burst.push({ lead_id: 'victim', created_at: BURST_AT });
const BURST_KEYS = batchClickKeys(burst);

CASES.push({
  label: 'cross-lead burst: 16 leads clicked in the same minute, long after any send',
  visits: [{ lead_id: 'victim', created_at: BURST_AT, metadata: { ua: CHROME } }],
  sends: [t(1, 9)],
  batchKeys: BURST_KEYS,
  expect: 'scanner',
});
CASES.push({
  label: 'a real click that happens to fall on a burst day but not in the burst',
  visits: [{ lead_id: 'victim', created_at: '2026-07-18T21:40:00Z', metadata: { ua: CHROME } }],
  sends: [t(1, 9)],
  batchKeys: BURST_KEYS,
  expect: 'weak',
});

// Madison Eyes, the highest-scoring lead on the entire warm list: 24 clicks over 9 days from 8
// device shapes, every other signal saying warm prospect, and an hourly gap sequence.
const ANDROID7 = 'Mozilla/5.0 (Linux; Android 7.0; SM-G930V) AppleWebKit/537.36 Chrome/59.0.3071.125 Mobile Safari/537.36';
const hourly = [0, 63, 124, 185, 246].map(m => click(new Date(Date.parse(t(1, 18)) + m * 60000).toISOString()));
CASES.push({
  label: 'hourly polling loop dressed as an engaged prospect',
  visits: hourly,
  sends: [t(1, 18)],
  expect: 'scanner',
});
CASES.push({
  label: 'two different browsers clicking in the same second',
  visits: [click(t(2, 14)), click(t(2, 14), IPHONE), click(t(4, 16))],
  sends: [t(1, 9)],
  expect: 'scanner',
});
CASES.push({
  label: 'four different browser builds on one small business',
  visits: [click(t(2, 14)), click(t(3, 16), IPHONE), click(t(5, 11), ANDROID7),
           click(t(6, 13), 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/109.0')],
  sends: [t(1, 9)],
  expect: 'scanner',
});
CASES.push({
  label: 'three clicks on irregular human timing stay human',
  visits: [click(t(2, 14)), click(t(4, 10), IPHONE), click(t(9, 16))],
  sends: [t(1, 9)],
  expect: 'probable',
});

let bad = 0;
for (const c of CASES) {
  const cls = classifyVisits(c.visits, c.sends, c.batchKeys);
  const got = visitTier(cls);
  const ok = got === c.expect;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  want ${c.expect.padEnd(8)} got ${got.padEnd(8)} ${c.label}`);
  if (!ok) console.log(`        reasons: ${cls.reasons.join('; ')}`);
}
console.log(`\n${CASES.length - bad}/${CASES.length} passed`);
process.exit(bad ? 1 : 0);
