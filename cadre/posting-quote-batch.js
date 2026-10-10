#!/usr/bin/env node
/**
 * cadre/posting-quote-batch.js
 *
 * Direct client outreach built on one checkable fact: a line from the company's own job
 * posting that describes the work Cadre does ("maintain training records and certifications").
 * Picks never-emailed Cadre leads that have a posting quote and a usable address, Canada first,
 * and writes one plain-text email per lead quoting their own words.
 *
 *   node cadre/posting-quote-batch.js --dry [--limit 40]     print the picks and every email
 *   node cadre/posting-quote-batch.js --send [--limit 40]    send, spaced ~30 min, resumable log
 *
 * Sending requires --send AND an approved list file (cadre/state/posting-batch-approved.json)
 * written by --dry, so nothing goes out that wasn't printed and approved first.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const { excludedOrgReason } = require('../tempo/dnc');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg('--limit', '40'), 10);
const SEND = process.argv.includes('--send');
const GAP_MS = Number(process.env.GAP_MS || 30 * 60 * 1000);
const STATE = path.join(__dirname, 'state');
const APPROVED = path.join(STATE, 'posting-batch-approved.json');
const LOG = path.join(STATE, 'posting-batch-log.json');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

const CANADA = /\b(BC|AB|SK|MB|ON|QC|NS|NB|NL|PE|YT|NT|NU)\b|British Columbia|Alberta|Ontario|Saskatchewan|Manitoba|Canada/i;
const BC = /\bBC\b|British Columbia/i;
const GOOD_IND = new Set(['trades', 'manufacturing', 'transport', 'utilities', 'environmental', 'warehousing', 'security']);
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function cleanQuote(q) {
  let s = String(q || '').replace(/\s+/g, ' ').trim().replace(/^[-•*\s]+/, '');
  const m = s.match(/^[^.]{20,220}\./); // first sentence if there is one
  if (m) s = m[0];
  if (s.length > 200) s = s.slice(0, 200).replace(/\s+\S*$/, '') + '...';
  return s.replace(/\.$/, '');
}
function firstName(n) { const f = String(n || '').trim().split(/\s+/)[0]; return /^[A-Z][a-z'-]+$/.test(f) ? f : null; }

function emailFor(l) {
  const hi = firstName(l.contact_name) ? `Hi ${firstName(l.contact_name)},` : `Hi ${l.business_name} team,`;
  const when = l.signal_date ? `Your ${MONTH[new Date(l.signal_date).getUTCMonth()]} job posting` : 'A recent job posting of yours';
  const tail = BC.test(l.city || '') && l.industry === 'trades'
    ? 'It also checks the Skilled Trades Certification apprentice ratio and COR training records for BC contractors.'
    : 'It also keeps the training records an auditor asks for ready to export.';
  return {
    subject: 'your job posting',
    body: [
      hi, '',
      `${when} asked the new hire to "${cleanQuote(l.signal_quote)}".`, '',
      `That is the part of the job Cadre takes off their plate. Every certification sits on the employee record, the worker and their supervisor are warned at 60, 30 and 7 days, and the staff list syncs from the HR or payroll system you already run. ${tail}`, '',
      'I am looking for a few companies to use it free for a while in exchange for honest feedback. Would a 20-minute look be worth it?', '',
      'Thanks,', 'Aidan Cox', 'Aevon', 'aevon.ca', '',
    ].join('\r\n'),
  };
}

(async () => {
  if (!SEND) {
    let all = [], from = 0;
    while (true) {
      const { data, error } = await sb.from('cadre_leads').select('id,business_name,industry,city,staff_estimate,status,signal_quote,signal_date,contact_name,contact_role,email,email_quality,last_sent_at,notes').range(from, from + 999);
      if (error) throw new Error(error.message);
      all = all.concat(data); if (data.length < 1000) break; from += 1000;
    }
    const pool = all.filter(l => l.signal_quote && l.email && !l.last_sent_at && ['queued', 'needs_review'].includes(l.status)
      && l.email_quality !== 'generic' && !/parked by hand|dont_contact|HRIS|domain does not match|survived/i.test(l.notes || '')
      && !excludedOrgReason(l.business_name, l.email)
      && !(l.staff_estimate && (l.staff_estimate < 20 || l.staff_estimate > 1000))
      && cleanQuote(l.signal_quote).split(' ').length >= 6
      // The quote has to read as a task after "asked the new hire to".
      && /^(maintain|track|manage|monitor|support|keep|update|coordinate|assist|schedule|enter|help|ensure|administer|oversee|organize|record|review|lead|develop|conduct|plan|verify|audit|prepare|input|process|create|build|implement|facilitate|deliver|issue|file|document)\b/i.test(cleanQuote(l.signal_quote))
      // Canada only, English only (Quebec gets French email or none), trades-type industries only.
      && CANADA.test(l.city || '') && !/\bQC\b|Quebec|Québec/i.test(l.city || '') && GOOD_IND.has(l.industry));
    const score = l => (BC.test(l.city || '') ? 4 : CANADA.test(l.city || '') ? 3 : 0) + (GOOD_IND.has(l.industry) ? 2 : 0) + (l.contact_name ? 1 : 0);
    const picks = pool.sort((a, b) => score(b) - score(a)).slice(0, LIMIT);
    console.log(`pool ${pool.length}, picking ${picks.length} (BC ${picks.filter(l => BC.test(l.city || '')).length}, rest of Canada ${picks.filter(l => !BC.test(l.city || '') && CANADA.test(l.city || '')).length})\n`);
    for (const l of picks) {
      const e = emailFor(l);
      console.log(`--- ${l.business_name} | ${l.city} | ${l.industry} | ${l.staff_estimate ?? '?'} staff | <${l.email}>\nSubject: ${e.subject}\n\n${e.body}`);
    }
    fs.writeFileSync(APPROVED, JSON.stringify(picks.map(l => ({ id: l.id, firm: l.business_name, to: l.email })), null, 1));
    console.log(`\nWrote ${picks.length} to ${path.basename(APPROVED)}. Nothing sent.`);
    return;
  }

  const approved = JSON.parse(fs.readFileSync(APPROVED, 'utf8'));
  const readLog = () => { try { return JSON.parse(fs.readFileSync(LOG, 'utf8')); } catch { return []; } };
  const o = new google.auth.OAuth2(process.env.GMAIL_OAUTH_CLIENT_ID, process.env.GMAIL_OAUTH_CLIENT_SECRET);
  o.setCredentials({ refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN });
  const g = google.gmail({ version: 'v1', auth: o });
  let first = true;
  for (const a of approved) {
    if (readLog().some(e => e.to.toLowerCase() === a.to.toLowerCase())) continue;
    const { data: l } = await sb.from('cadre_leads').select('*').eq('id', a.id).single();
    if (!l || l.last_sent_at || excludedOrgReason(l.business_name, l.email)) { console.log(`skip ${a.firm}`); continue; }
    const e = emailFor(l);
    if (/—/.test(e.body)) { console.error(`em dash in ${a.firm}, skipped`); continue; }
    if (!first) await new Promise(r => setTimeout(r, GAP_MS + Math.floor(Math.random() * 5 * 60 * 1000)));
    first = false;
    const raw = [`From: Aidan Cox <aidan@aevon.ca>`, `To: ${l.email}`, `Subject: ${e.subject}`, 'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', e.body].join('\r\n');
    try {
      const r = await g.users.messages.send({ userId: 'me', requestBody: { raw: Buffer.from(raw).toString('base64url') } });
      const now = new Date().toISOString();
      fs.writeFileSync(LOG, JSON.stringify([...readLog(), { at: now, firm: a.firm, to: l.email, id: r.data.id }], null, 1));
      await sb.from('cadre_leads').update({ status: 'sent', last_sent_at: now, sequence_step: 1, personalization_basis: 'campaign:posting-quote-2026-10',
        email_subject: e.subject, email_body: e.body, notes: `${l.notes ? l.notes + ' | ' : ''}posting-quote batch ${now.slice(0, 10)}` }).eq('id', l.id);
      console.log(`${now} sent ${a.firm} <${l.email}>`);
    } catch (err) { console.error(`FAILED ${a.firm}: ${err.message}`); }
  }
  console.log('batch done');
})().catch(e => { console.error(e.message); process.exit(1); });
