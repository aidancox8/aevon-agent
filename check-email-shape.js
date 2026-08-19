#!/usr/bin/env node
/**
 * Guards the shape of outbound mail. This exists because of a real, expensive failure.
 *
 * Seed-tested 2026-08-18 against mailboxes we own: the same message, same Resend path, same
 * recipient, reached the INBOX as plain text, was SPAM-FOLDERED by Gmail as HTML, and was
 * QUARANTINED AS PHISHING by Microsoft as HTML.
 *
 * "Phishing" rather than "junk" is the diagnosis. The signature stacked three deception
 * heuristics, the worst being anchor text reading "aevon.ca" over an href pointing at
 * aevon.ca/<vertical>.html?ref=<uuid>. Visible text that does not match its destination is the
 * strongest single phishing signal a mail filter has, and both senders did it.
 *
 * Cost of the bug: roughly three months of Aevon outreach landing where nobody reads it, and
 * Tempo recording 0 replies and 0 genuine visits across 258 sends to Microsoft-hosted clinics.
 *
 *   node check-email-shape.js
 */
const fs = require('fs');

let failed = 0;
const ok   = m => console.log(`ok    ${m}`);
const fail = m => { console.log(`FAIL  ${m}`); failed++; };

// 1. Neither sender may attach an HTML part. Plain text cannot carry an anchor mismatch,
//    because the URL and its visible text are necessarily the same string.
for (const f of ['sender.js', 'tempo/sender.js']) {
  const src = fs.readFileSync(f, 'utf8');
  // Look only at what is actually passed to Resend, ignoring comments.
  const code = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  const sends = code.match(/emails\.send\(\{[\s\S]*?\n\s*\}\)/g) || [];
  const withHtml = sends.filter(b => /(^|[^a-zA-Z])html\s*:/.test(b));
  withHtml.length ? fail(`${f} passes an html part to Resend (${withHtml.length} call site)`)
                  : ok(`${f} sends plain text only`);
}

// 2. If toHtml is ever reinstated, its anchors must not lie. Render it and check every link.
const { toHtml } = require('./sender');
const html = toHtml('Body text.\n\nhttps://aevon.ca/demo.html', 'lead-uuid', 'insurance brokerage', 'Test Co');

const anchors = [...html.matchAll(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
let mismatched = 0;
for (const [, href, rawText] of anchors) {
  const text = rawText.replace(/<[^>]+>/g, '').trim();
  if (!text || /^https?:\/\//i.test(text) === false && !text.includes('@') && !text.includes('.')) continue; // descriptive label
  const hrefNorm = href.replace(/^https?:\/\//, '').replace(/^mailto:/, '').replace(/\/$/, '');
  const textNorm = text.replace(/^https?:\/\//, '').replace(/^mailto:/, '').replace(/\/$/, '');
  if (hrefNorm !== textNorm) { fail(`anchor text "${text}" does not match href "${href}"`); mismatched++; }
}
if (!mismatched) ok('every anchor whose text looks like a destination matches its href');

// 3. Remote images are a bulk-mail tell and were part of the same signature.
/<img\s[^>]*src="https?:\/\//i.test(html) ? fail('remote <img> present in toHtml output')
                                          : ok('no remote images in toHtml output');

console.log(failed ? `\n${failed} problem(s). Re-run seed-placement-test.js before sending anything.`
                   : '\nAll shape checks passed.');
process.exit(failed ? 1 : 0);
