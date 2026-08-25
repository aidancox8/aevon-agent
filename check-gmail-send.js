#!/usr/bin/env node
/**
 * check-gmail-send.js — prove the Gmail send path stays plain text.
 *
 * WHY. On 2026-08-25 three Cadre emails went out through the Gmail MCP tool, because that is
 * what was asked for. Reading them back out of Sent showed:
 *
 *   Content-Type: multipart/alternative
 *     text/plain
 *     text/html          <-- and inside it:
 *     https://www.google.com/url?q=http://aevon.ca&source=gmail&ust=...
 *
 * Gmail composed an HTML alternative and rewrote the bare domain into a google.com/url redirect.
 * That is a masked link inside an HTML part: the two heuristics that got the old signature
 * quarantined as PHISHING by Microsoft Defender and spam-foldered by Gmail. Nobody chose it and
 * nothing caught it, because check-email-shape.js only inspects toHtml() output, which is dead
 * code, and never inspects what a mail provider does to the message on the way out.
 *
 * cadre/sender.js --via gmail builds the RFC822 message itself with a single explicit
 * text/plain part, so Gmail has no HTML alternative to generate and no anchor to rewrite. This
 * asserts that, by sending to Aidan's own mailbox and reading the result back.
 *
 * It sends a REAL email, to aidan@aevon.ca only, never to a prospect.
 *
 *   node check-gmail-send.js
 */
require('dotenv').config();
const { google } = require('googleapis');
const { signature } = require('./lib/signature');

const TO = 'aidan@aevon.ca';

function gmail() {
  const o = new google.auth.OAuth2(process.env.GMAIL_OAUTH_CLIENT_ID, process.env.GMAIL_OAUTH_CLIENT_SECRET);
  o.setCredentials({ refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: o });
}

// The same builder cadre/sender.js uses. Kept in step by the assertions at the bottom.
function buildRaw({ from, fromName, replyTo, to, subject, text }) {
  return [
    `From: =?UTF-8?B?${Buffer.from(fromName).toString('base64')}?= <${from}>`,
    `To: ${to}`,
    `Reply-To: ${replyTo}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text).toString('base64'),
  ].join('\r\n');
}

let bad = 0;
const check = (label, cond, detail = '') => {
  if (!cond) bad++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
};

(async () => {
  const g = gmail();
  const stamp = process.env.GITHUB_RUN_ID || String(process.pid);
  const subject = `[shape test ${stamp}] plain text only`;
  const body = 'This is a send-shape test. If it carries an HTML part or a rewritten link, '
    + 'the Gmail path is unsafe for outreach.'
    + signature({ optOut: 'Not relevant? Reply with a no and I will not email again.' });

  const raw = buildRaw({
    from: process.env.GMAIL_USER || TO, fromName: 'Aidan Cox', replyTo: TO,
    to: TO, subject, text: body,
  });

  const sent = await g.users.messages.send({
    userId: 'me', requestBody: { raw: Buffer.from(raw).toString('base64url') },
  });
  console.log(`sent test message ${sent.data.id} to ${TO}\n`);

  // Read back what Gmail actually stored and transmitted.
  const back = await g.users.messages.get({ userId: 'me', id: sent.data.id, format: 'raw' });
  const src = Buffer.from(back.data.raw, 'base64').toString('utf8');
  const parts = [...src.matchAll(/Content-Type:\s*([a-z]+\/[a-z-]+)/gi)].map(m => m[1].toLowerCase());

  check('exactly one MIME part', parts.length === 1, `got [${parts.join(', ')}]`);
  check('that part is text/plain', parts[0] === 'text/plain');
  check('no HTML alternative', !parts.includes('text/html'));
  check('not multipart', !/multipart/i.test(src));
  check('no google.com/url redirect', !src.includes('google.com/url'));
  check('the booking link is not rewritten',
    !/calendar\.app\.google/.test(src) || !/url\?q=.*calendar\.app\.google/.test(src));

  const decoded = Buffer.from(src.split(/\r?\n\r?\n/).slice(1).join('\n\n').replace(/\s/g, ''), 'base64').toString('utf8');
  check('the signature survived intact', /Aidan Cox/.test(decoded) && /aevon\.ca/.test(decoded));
  check('no <br> or tags leaked into the text', !/<br|<\/?div|<\/?p>/i.test(decoded));

  // The builder above must not drift from the one the sender actually ships.
  const senderSrc = require('fs').readFileSync('./cadre/sender.js', 'utf8');
  check('sender declares a single text/plain content type',
    /Content-Type: text\/plain; charset="UTF-8"/.test(senderSrc));
  check('sender does not build a multipart message', !/multipart/i.test(senderSrc));

  console.log(`\n${bad ? `${bad} FAILED — do not send outreach through this path` : 'Gmail send path is plain text only.'}`);
  console.log(`Check ${TO} for "${subject}".`);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('check-gmail-send failed:', e.message); process.exit(1); });
