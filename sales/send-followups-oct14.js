#!/usr/bin/env node
/**
 * One-off: the follow-ups Aidan approved on 2026-10-10, sent as replies in the original threads
 * on or after Wednesday 2026-10-14, inside the business-hours window, ~30 minutes apart.
 *   - the referral firms from sales/send-referral-batch.js (bounced and replied threads skipped)
 *   - Rhys Green at Trailblaze Partners
 *   - Power Broker support (API access question)
 * A thread is skipped if anyone other than aidan@aevon.ca has written in it (a reply, or a
 * bounce). Resumable: sends are logged to sales/followups-oct14-log.json.
 *
 *   node sales/send-followups-oct14.js --dry
 *   node sales/send-followups-oct14.js --send
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { waitForWindow, withNetRetry } = require('../lib/send-window');

const SEND = process.argv.includes('--send');
const GAP_MS = Number(process.env.GAP_MS || 30 * 60 * 1000);
const NOT_BEFORE = new Date('2026-10-14T15:00:00Z'); // Wed 2026-10-14 08:00 Pacific
const LOG = path.join(__dirname, 'followups-oct14-log.json');
const ME = 'aidan@aevon.ca';

const REFERRAL_BODY = (hi) => [
  hi, '',
  "A short follow-up on the note below. If none of your clients are dealing with ticket expiries or COR training records, a one-word no is a fine answer and I won't follow up again.", '',
  "If one is, I'd set Cadre up for them free and do the work of importing their staff list myself, so it costs them nothing but a 20-minute look.", '',
  'Thanks,', 'Aidan', '',
].join('\r\n');
const POWERBROKER_BODY = [
  'Hi,', '',
  'Following up on my question below about third-party API access for Power Broker or the Acturis platform. If partnership questions go to a different person or address, could you point me there?', '',
  'Thanks,', 'Aidan Cox', 'Aevon', 'aevon.ca', '',
].join('\r\n');

// Names as used in the first notes (sales/send-referral-batch.js).
const HI = {
  // The first notes went to the generic info@ boxes as "Hi {firm} team,".
  'mason@estreasolutions.com': 'Hi Mason,', 'lora@dverse.ca': 'Hi Lora,', 'gagan@ggsafetyconsulting.com': 'Hi Gagan,',
  'allysha@absolutesafetybc.com': 'Hi Allysha,', 'judymslutsky@gmail.com': 'Hi Judy,',
};

function targets() {
  const firms = JSON.parse(fs.readFileSync(path.join(__dirname, 'referral-batch-log.json'), 'utf8'));
  const list = firms.filter(f => !/blankslate/i.test(f.to)).map(f => ({ label: f.firm, to: f.to, messageId: f.id, body: REFERRAL_BODY(HI[f.to.toLowerCase()] || `Hi ${f.firm} team,`) }));
  list.push({ label: 'Trailblaze Partners (Rhys Green)', to: null, messageId: '1a104d776e67ee1a', body: REFERRAL_BODY('Hi Rhys,') });
  list.push({ label: 'Power Broker support', to: null, messageId: '1a104beb51dce3da', body: POWERBROKER_BODY });
  return list;
}

const hdr = (m, n) => ((m.payload && m.payload.headers) || []).find(h => h.name.toLowerCase() === n)?.value || '';

(async () => {
  const o = new google.auth.OAuth2(process.env.GMAIL_OAUTH_CLIENT_ID, process.env.GMAIL_OAUTH_CLIENT_SECRET);
  o.setCredentials({ refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN });
  const g = google.gmail({ version: 'v1', auth: o });
  const readLog = () => { try { return JSON.parse(fs.readFileSync(LOG, 'utf8')); } catch { return []; } };

  if (SEND && Date.now() < NOT_BEFORE.getTime()) {
    console.log(`waiting until ${NOT_BEFORE.toISOString()} (Wed Oct 14, 8am Pacific)`);
    while (Date.now() < NOT_BEFORE.getTime()) await new Promise(r => setTimeout(r, 10 * 60 * 1000));
  }

  let first = true;
  for (const t of targets()) {
    let orig, thread;
    try {
      orig = (await withNetRetry(() => g.users.messages.get({ userId: 'me', id: t.messageId, format: 'metadata', metadataHeaders: ['Message-ID', 'Subject', 'To'] }), t.label)).data;
      thread = (await withNetRetry(() => g.users.threads.get({ userId: 'me', id: orig.threadId, format: 'metadata', metadataHeaders: ['From'] }), t.label)).data;
    } catch (e) { console.error(`SKIP ${t.label}: cannot read original (${e.message})`); continue; }
    t.to = hdr(orig, 'to');
    if (!t.to) { console.error(`SKIP ${t.label}: original has no To header`); continue; }
    if (readLog().some(e => e.to.toLowerCase() === t.to.toLowerCase())) continue;
    const others = (thread.messages || []).filter(m => !hdr(m, 'from').toLowerCase().includes(ME));
    if (others.length) { console.log(`SKIP ${t.label}: thread has ${others.length} message(s) from someone else (reply or bounce)`); continue; }
    const subject = /^re:/i.test(hdr(orig, 'subject')) ? hdr(orig, 'subject') : `Re: ${hdr(orig, 'subject')}`;
    if (!SEND) { console.log(`--- ${t.label} <${t.to}>\nSubject: ${subject}\n\n${t.body}`); continue; }
    if (/â€”/.test(t.body)) { console.error(`em dash in ${t.label}, skipped`); continue; }
    if (!first) await new Promise(r => setTimeout(r, GAP_MS + Math.floor(Math.random() * 5 * 60 * 1000)));
    first = false;
    await waitForWindow();
    const raw = [`From: Aidan Cox <${ME}>`, `To: ${t.to}`, `Subject: ${subject}`, `In-Reply-To: ${hdr(orig, 'message-id')}`, `References: ${hdr(orig, 'message-id')}`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', t.body].join('\r\n');
    try {
      const r = await withNetRetry(async () => { await waitForWindow(); return g.users.messages.send({ userId: 'me', requestBody: { raw: Buffer.from(raw).toString('base64url'), threadId: orig.threadId } }); }, t.label);
      fs.writeFileSync(LOG, JSON.stringify([...readLog(), { at: new Date().toISOString(), label: t.label, to: t.to, id: r.data.id }], null, 1));
      console.log(`${new Date().toISOString()} sent follow-up ${t.label}`);
    } catch (e) { console.error(`FAILED ${t.label}: ${e.message}`); }
  }
  console.log(SEND ? 'done' : 'dry run, nothing sent');
})().catch(e => { console.error(e.message); process.exit(1); });
