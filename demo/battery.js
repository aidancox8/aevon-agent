#!/usr/bin/env node
/**
 * demo/battery.js, the conversations Sofia's Facebook and Google ads actually produce, run cold
 * through the real worker with the outcome checked. Exit 1 on any failure. Run before the demo.
 *
 * Built from her call notes (2026-09-03): VA and first-time buyers PCSing to JBLM, spouses who do
 * not understand the VA loan, sellers with orders out, people replying to an ad about one listing,
 * tire-kickers, renters, and noise. The flow under test: the first reply asks up to two questions
 * and never offers a call; the call is offered alone once the lead has answered enough; a reply to
 * the offer can only mean a time; a reschedule after a booking is a time request, not a chat.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const SOFIA = path.join(__dirname, 'sofia.js');
const run = (as, text) => spawnSync(process.execPath, [SOFIA, '--as', as, text], { encoding: 'utf8' }).stdout;
spawnSync(process.execPath, [SOFIA, '--reset']);

const results = [];
function check(label, out, expect) {
  const failed = expect.filter(([desc, re, not]) => not ? re.test(out) : !re.test(out)).map((e) => e[0]);
  results.push({ label, ok: !failed.length });
  console.log(`${failed.length ? 'FAIL' : ' ok '}  ${label}${failed.length ? '   -> ' + failed.join('; ') : ''}`);
  if (failed.length || process.argv.includes('--verbose')) console.log(out.split('\n').filter((l) => /draft:|\[|confirmed|mid-booking|learned|held|wants to move/.test(l) || /^\s{7}\S/.test(l)).map((l) => '        ' + l).join('\n'));
}
const OFFER = /I can call you .+ or .+\./;
const DRAFT = /draft:/;
const BOOKED = /send confirmation/;
const RED = /\[spam\]|\[other\]|\[out_of_scope\]|\[existing\]/;
const FLOURISH = /thank you for your service|congratulations|all the time|welcome to the area/i;
const CLAIMS_BOOKING = /I have you down|I have booked|see you (at|on)|booked you|penciled/i;
const GREETS = (n) => new RegExp(`draft:\\s*\\n\\s+Hi ${n},`);
const NO_GREET = /draft:\s*\n\s+Hi \w+,/;

// A. The headline PCS buyer, the way it goes 80% of the time.
check('A1 PCS buyer first text: asks, no call', run('Marcus', 'Hi Sofia, saw your ad. We just got orders to JBLM, report Oct 15. Wife and 2 kids, looking for a 3br off base'), [['qualified', /\[QUALIFIED\]/], ['greets once', GREETS('Marcus')], ['asks', /draft:[\s\S]*\?/], ['no call yet', OFFER, true], ['no flourish', FLOURISH, true]]);
check('A2 answers: VA + nothing to sell -> offer, alone', run('Marcus', 'VA loan, first time buying. we rent now so nothing to sell'), [['offers times', OFFER], ['no second greeting', NO_GREET, true], ['no question with the offer', /draft:\s*\n\s+[^\n]*\?\s*\n/, true], ['no red card', RED, true]]);
check('A3 picks by time', run('Marcus', 'the 12:45 works'), [['booked', BOOKED], ['first person', /I will call you then/]]);
check('A4 reschedule after booking', run('Marcus', 'sorry something came up, can we do friday morning instead'), [['reads it as a move', /wants to move|works\. I can call you/], ['no red card', RED, true], ['no booking claimed by the model', CLAIMS_BOOKING, true]]);
check('A5 picks the new time', run('Marcus', 'first one'), [['rebooked', BOOKED], ['says moved', /Moved\./]]);

// B. The spouse who does not understand VA (her own example on the call).
check('B1 spouse, VA questions', run('Danielle', 'Hello, my husband is being stationed at Lewis-McChord in January and we are starting to look. Everyone says use the VA loan but I do not understand it. Do we need money down?'), [['qualified', /\[QUALIFIED\]/], ['no call yet', OFFER, true], ['reassures, does not quote numbers', /\$|percent|%/, true]]);
check('B2 answers', run('Danielle', 'no house to sell, we are in Texas now. orders should be in hand by november'), [['offers times', OFFER]]);
check('B3 vague reply mid-offer', run('Danielle', 'let me check with my husband and get back to you'), [['asks which, no red card', RED, true], ['draft', DRAFT], ['no booking claimed', CLAIMS_BOOKING, true]]);
check('B4 then picks', run('Danielle', 'ok the second one'), [['booked', BOOKED]]);

// C. A seller with orders out.
check('C1 seller', run('Tom', 'We have orders out of JBLM, report to Bragg Nov 1. Need to sell our house in Lakewood first'), [['qualified', /\[QUALIFIED\]/], ['no call yet', OFFER, true], ['asks about the house', /draft:[\s\S]*\?/]]);
check('C2 answers', run('Tom', '4br on Idlewood, bought in 2021 for 410. we would need to be out by mid Oct'), [['offers times', OFFER]]);
check('C3 asks a taken time', run('Tom', 'can you do thursday at 3'), [['nothing open, offers instead', /Nothing open|I can call you/], ['no red card', RED, true]]);
check('C4 yes', run('Tom', 'yes that works'), [['booked', BOOKED]]);

// D. Replying to an ad about one listing.
check('D1 listing question', run('Priya', 'is the DuPont house on Idlewood from your ad still available? could we see it this weekend'), [['draft', DRAFT], ['never says available', /(is|it's|its) still available\b(?! )|it is available|I can show it|see it this weekend\./i, true], ['says will check', /check/i], ['no call yet', OFFER, true]]);
check('D2 answers', run('Priya', 'we are moving from Colorado in Dec, conventional, preapproved to 550'), [['offers times', OFFER]]);
check('D3 declines', run('Priya', 'actually we found something, thanks anyway'), [['graceful', /no problem/i], ['not booked', BOOKED, true]]);

// E. Everything in the first text, then a bare time as the pick.
check('E1 rich first text still asks first', run('Lena', 'orders in hand to JBLM, report Nov 1, VA with COE, 3 bed around 450k in Lakewood, nothing to sell'), [['no call on turn one', OFFER, true], ['draft', DRAFT]]);
check('E2 second reply -> offer', run('Lena', 'yes we can drive up to 30 min from the gate'), [['offers times', OFFER]]);
check('E3 bare time pick', run('Lena', '1245 on the 10th works'), [['booked or re-offered, never red', RED, true], ['acted on the time', /confirmed|offered|Nothing open/]]);

// F. Tire-kicker and noise.
check('F1 just hi', run('Jess', 'hi'), [['not spam', /\[spam\]/, true], ['short friendly draft', DRAFT], ['greets', GREETS('Jess')]]);
check('F2 just looking', run('Ray', 'just looking around for now, maybe next year'), [['draft, no call', DRAFT], ['no call', OFFER, true]]);
check('F3 renter', run('Kim', 'do you have any 2 bedroom rentals near JBLM under 2000'), [['not out of scope', /\[out_of_scope\]/, true], ['draft', DRAFT]]);
check('F4 vendor', run('Vendor', 'Hi! We can get your website to the top of Google in 30 days. Interested?'), [['spam', /\[spam\]/], ['no draft', DRAFT, true]]);
check('F5 wrong number', run('Unknown', 'is this dominos'), [['no call', OFFER, true]]);
check('F6 out of area', run('Sam', 'looking for a condo in Phoenix, can you help'), [['no call', OFFER, true], ['no booking', BOOKED, true]]);

spawnSync(process.execPath, [SOFIA, '--reset']);
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed`);
process.exit(bad.length ? 1 : 0);
