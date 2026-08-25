#!/usr/bin/env node
/**
 * check-signature.js
 *
 * The Aevon signature disappeared on 2026-08-18 and nobody noticed for a week. Not because
 * anyone deleted it: the HTML build was correctly removed for deliverability, the signature
 * happened to live only inside toHtml(), and the personalizer prompt still told the model not to
 * sign off because "the signature handles that". Two reasonable changes and one stale comment,
 * and every cold email went out from a stranger with no name on it. Robert at Lindquist &
 * Kornfeld got one of those and replied NO.
 *
 * Nothing about that was catchable by reading the diff, so it is caught here instead.
 */
const { signature } = require('./lib/signature');

let bad = 0;
const check = (label, cond) => { if (!cond) bad++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}`); };

const OPT_OUT = "Not interested? Just reply no and I won't email you again.";
const sig = signature({ optOut: OPT_OUT });

check('carries a human name', /Aidan Cox/.test(sig));
check('carries the company', /Aevon/.test(sig));
check('carries the bare domain', /(^|\n)aevon\.ca(\n|$)/.test(sig));
check('carries the opt-out', sig.includes(OPT_OUT));
check('starts with blank lines so it does not run into the body', sig.startsWith('\n\n'));
check('has a signature delimiter', /\n--\n/.test(sig));
check('no blank line where an unset address would be', !/\n\n\naevon/.test(sig));

// Deliverability. These are the three things that got the mail quarantined as phishing.
check('no HTML tags', !/<[a-z]/i.test(sig));
check('no markdown or masked links', !/\]\(|<a\s|href=/i.test(sig));
check('no image references', !/\.(png|jpg|gif|svg)/i.test(sig));
check('every URL is its own display text', (sig.match(/\S+\.(ca|com|net|io)\b/g) || [])
  .every(u => sig.includes(u)));

// With an address configured it must appear, and still no stray blank line.
const withAddr = signature({ optOut: OPT_OUT, address: '1 Example St, Vancouver BC V0V 0V0' });
check('address appears when configured', withAddr.includes('1 Example St'));
check('no double blank line with an address set', !/\n\n\n/.test(withAddr.slice(2)));

// The tagline is opt-in and must stay one line: a signature is identification, not a pitch.
const withTag = signature({ optOut: OPT_OUT, tagline: 'Staff records, training and credentials in one system.' });
check('tagline appears when asked for', withTag.includes('Staff records'));
check('tagline absent by default', !sig.includes('Staff records'));

// THE ACTUAL REGRESSION. Both senders must put the name in the message they really send.
const aevon = require('fs').readFileSync('./sender.js', 'utf8');
const cadre = require('fs').readFileSync('./cadre/sender.js', 'utf8');
check('Aevon sender imports the shared signature', /require\(.*lib\/signature.*\)/.test(aevon));
check('Cadre sender imports the shared signature', /require\(.*lib\/signature.*\)/.test(cadre));
check('Aevon sends body + signature, not body + opt-out alone',
  /signature\(\{/.test(aevon) && /text: withUnsubText\(body,/.test(aevon));
check('Cadre builds its footer from the shared signature', /const FOOTER = signature\(/.test(cadre));

// The booking link is the one thing in the signature that can still look like a call to action,
// so email 1 must not carry it while the Aevon copy rule says "no link in email 1".
check('Aevon withholds the booking link on the first touch', /booking: step > 0/.test(aevon));
// Assert on the OUTPUT, not the source: lib/signature.js quotes the original bad HTML in a
// comment to explain why it was replaced, and a source-level regex reads that as a violation.
const withBooking = signature({ optOut: OPT_OUT, booking: true });
check('booking link appears when asked for', withBooking.includes('calendar.app.google'));
check('booking link is a naked URL, never anchor text',
  /Book a call: https:\/\/calendar\.app\.google\/\S+$/m.test(withBooking));
check('booking link absent from the no-link variant',
  !signature({ optOut: OPT_OUT, booking: false }).includes('calendar.app.google'));

console.log(`\n${bad ? `${bad} FAILED` : 'All signature checks passed.'}`);
process.exit(bad ? 1 : 0);
