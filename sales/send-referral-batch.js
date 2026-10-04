#!/usr/bin/env node
/**
 * One-off: the approved free-pilot note to 12 BC fractional HR and COR consultant firms
 * (sales/cor-referral-firms.md), approved by Aidan 2026-10-04. Plain text from aidan@aevon.ca,
 * one at a time, about 30 minutes apart. Resumable: every send is logged to
 * sales/referral-batch-log.json and a logged address is never sent again.
 *
 *   node sales/send-referral-batch.js --dry     print every email, send nothing
 *   node sales/send-referral-batch.js           send, spaced
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { excludedOrgReason } = require('../tempo/dnc');

const DRY = process.argv.includes('--dry');
const GAP_MS = 30 * 60 * 1000;
const LOG = path.join(__dirname, 'referral-batch-log.json');

const HR = 'hr', COR = 'cor';
const FIRMS = [
  { firm: 'Estrea Solutions', to: 'mason@estreasolutions.com', hi: 'Mason', kind: HR },
  { firm: 'Dverse Safety Consulting', to: 'lora@dverse.ca', hi: 'Lora', kind: COR },
  { firm: 'TallSky Consulting Group', to: 'info@tallsky.ca', hi: null, kind: HR },
  { firm: 'GG Safety Consulting', to: 'gagan@ggsafetyconsulting.com', hi: 'Gagan', kind: COR },
  { firm: 'BLANKSLATE Partners', to: 'info@blankslate.partners', hi: null, kind: HR },
  { firm: 'Absolute Safety Consulting', to: 'allysha@absolutesafetybc.com', hi: 'Allysha', kind: COR },
  { firm: 'Chase & Co. HR', to: 'info@chaseandcohr.com', hi: null, kind: HR },
  { firm: 'Construction Safety Services', to: 'info@corsafetyservices.com', hi: null, kind: COR },
  { firm: 'HR Outsourced', to: 'judymslutsky@gmail.com', hi: 'Judy', kind: HR },
  { firm: 'Aurora HR', to: 'Info@AuroraHR.ca', hi: null, kind: HR },
  { firm: 'Vertical Bridge HR', to: 'info@verticalbridge.ca', hi: null, kind: HR },
  { firm: 'Inspired HR', to: 'info@inspiredhr.ca', hi: null, kind: HR },
];

function body(f) {
  const greet = f.hi ? `Hi ${f.hi},` : `Hi ${f.firm} team,`;
  const who = f.kind === COR
    ? "I'm looking for one COR consultant to try it with one of your clients, free, in exchange for honest feedback on what's missing. If a client of yours is chasing ticket expiries or COR training records in spreadsheets, would you be open to a 20-minute look?"
    : "I'm looking for one fractional HR firm to try it with one client, free, in exchange for honest feedback on what's missing. If a client of yours is chasing ticket expiries or COR records in spreadsheets, would you be open to a 20-minute look?";
  return [
    greet, '',
    'I run Aevon, a BC software company. Our product, Cadre, keeps employee certifications, training and COR records current for trades and construction employers, synced from the HR or payroll system they already run.', '',
    who, '',
    'Thanks,', 'Aidan Cox', 'Aevon', 'aevon.ca', '',
  ].join('\r\n');
}
const SUBJECT = 'Free certification tracking for one of your clients';

function readLog() { try { return JSON.parse(fs.readFileSync(LOG, 'utf8')); } catch { return []; } }

(async () => {
  for (const f of FIRMS) {
    const reason = excludedOrgReason(f.firm, f.to);
    if (reason) { console.error(`BLOCKED ${f.firm}: ${reason}`); process.exit(1); }
    if (/—/.test(body(f))) { console.error(`em dash in copy for ${f.firm}`); process.exit(1); }
  }
  if (DRY) { for (const f of FIRMS) console.log(`--- ${f.firm} <${f.to}>\nSubject: ${SUBJECT}\n\n${body(f)}`); return; }

  const o = new google.auth.OAuth2(process.env.GMAIL_OAUTH_CLIENT_ID, process.env.GMAIL_OAUTH_CLIENT_SECRET);
  o.setCredentials({ refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN });
  const g = google.gmail({ version: 'v1', auth: o });

  let first = true;
  for (const f of FIRMS) {
    const log = readLog();
    if (log.some(e => e.to.toLowerCase() === f.to.toLowerCase())) { console.log(`skip (already sent) ${f.to}`); continue; }
    if (!first) await new Promise(r => setTimeout(r, GAP_MS + Math.floor(Math.random() * 5 * 60 * 1000)));
    first = false;
    const raw = [`From: Aidan Cox <aidan@aevon.ca>`, `To: ${f.to}`, `Subject: ${SUBJECT}`, 'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', body(f)].join('\r\n');
    try {
      const r = await g.users.messages.send({ userId: 'me', requestBody: { raw: Buffer.from(raw).toString('base64url') } });
      const entry = { at: new Date().toISOString(), firm: f.firm, to: f.to, id: r.data.id };
      fs.writeFileSync(LOG, JSON.stringify([...readLog(), entry], null, 1));
      console.log(`${entry.at} sent ${f.firm} <${f.to}> ${r.data.id}`);
    } catch (e) { console.error(`FAILED ${f.firm} <${f.to}>: ${e.message}`); }
  }
  console.log('batch done');
})().catch(e => { console.error(e.message); process.exit(1); });
