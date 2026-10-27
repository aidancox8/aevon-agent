#!/usr/bin/env node
/**
 * cadre/muse-bridge.js
 *
 * Meta Muse finds the PERSON at each company (LinkedIn, in a real browser, which our scrapers
 * cannot do). This file is the two ends of that hand-off, so nobody copies JSON by hand:
 *
 *   node cadre/muse-bridge.js --queue [--size 25]   write muse/queue.md: the next companies that
 *                                                    have a verified posting quote but no person.
 *                                                    Muse reads it from the public raw GitHub URL.
 *   node cadre/muse-bridge.js --ingest [--dry]       read Muse's "[Muse leads]" emails in
 *                                                    aidan@aevon.ca, write contact_name/role/website
 *                                                    onto the matching cadre_leads rows.
 *
 * After ingest, the existing daily free-contacts.js --named-only finds and checks an address for
 * each named person, and posting-autopilot.js verifies again before it sends. Muse never sends
 * anything and never supplies a guessed address; an email from Muse is kept only as a hint.
 *
 * Matching is by lead id (the queue prints it), never by company name, so a reply that names a
 * company we did not ask about changes nothing.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const { blockReason, region } = require('./posting-copy');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const DRY = process.argv.includes('--dry');
const SIZE = parseInt(arg('--size', '25'), 10);
const QUEUE = path.join(__dirname, '..', 'muse', 'queue.md');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const today = () => new Date().toISOString().slice(0, 10);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function allLeads() {
  let all = [], from = 0;
  for (;;) {
    const { data, error } = await sb.from('cadre_leads').select('*').range(from, from + 999);
    if (error) throw new Error(error.message);
    all = all.concat(data); if (data.length < 1000) return all; from += 1000;
  }
}
const note = (l, s) => `${l.notes ? l.notes + ' | ' : ''}${s}`;

async function queue() {
  const leads = await allLeads();
  // Same rules as the autopilot, except an email is not required yet: Muse supplies the person.
  const pool = leads.filter(l => !l.contact_name && !/muse-(queued|none)/.test(l.notes || '')
    && !blockReason({ ...l, email: l.email || 'placeholder@example.com', email_quality: l.email_quality === 'invalid' ? null : l.email_quality },
      { maxPostingAgeDays: 75, regions: ['CA', 'US'] }));
  pool.sort((a, b) => (region(a) === 'CA' ? 0 : 1) - (region(b) === 'CA' ? 0 : 1) || String(b.signal_date).localeCompare(String(a.signal_date)));
  const pick = pool.slice(0, SIZE);
  const lines = [
    `# Muse queue, ${today()}`, '',
    `${pick.length} companies (of ${pool.length} waiting). For each, find the one person who owns staff certifications and training records.`,
    'Under 200 staff: owner, president or general manager. 200 to 1000: HR or health & safety manager. Over 1000: contact_name "too large".', '',
    'Email the result to aidan@aevon.ca with the subject "[Muse leads] YYYY-MM-DD" and ONLY a JSON array in the body:',
    '[{"id": "<id from this list>", "contact_name": "First Last or null", "contact_role": "", "website": "company domain", "linkedin_url": "", "staff_band": "e.g. 51-200", "email": "only if published publicly, else null", "format_evidence": "any published address at the domain, else null"}]', '',
    'Research only. Private mode on. No messages, connection requests, follows or reactions. Never guess an email.', '',
    '| id | company | city | website | posting says |', '|---|---|---|---|---|',
    ...pick.map(l => `| ${l.id} | ${l.business_name} | ${l.city || ''} | ${l.website || ''} | ${String(l.signal_quote).replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 90)} |`),
    '',
  ];
  if (DRY) { console.log(lines.join('\n')); return; }
  fs.mkdirSync(path.dirname(QUEUE), { recursive: true });
  fs.writeFileSync(QUEUE, lines.join('\n'));
  for (const l of pick) await sb.from('cadre_leads').update({ notes: note(l, `muse-queued ${today()}`) }).eq('id', l.id);
  console.log(`Queued ${pick.length} of ${pool.length} for Muse.`);
}

async function ingest() {
  const o = new google.auth.OAuth2(process.env.GMAIL_OAUTH_CLIENT_ID, process.env.GMAIL_OAUTH_CLIENT_SECRET);
  o.setCredentials({ refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN });
  const g = google.gmail({ version: 'v1', auth: o });
  const body = p => { if (!p) return ''; if (p.body && p.body.data && /text\/plain/.test(p.mimeType)) return Buffer.from(p.body.data, 'base64').toString(); return (p.parts || []).map(body).join(''); };
  const labels = (await g.users.labels.list({ userId: 'me' })).data.labels || [];
  let done = labels.find(l => l.name === 'muse-ingested');
  if (!done && !DRY) done = (await g.users.labels.create({ userId: 'me', requestBody: { name: 'muse-ingested' } })).data;
  const r = await g.users.messages.list({ userId: 'me', q: 'subject:"[Muse leads]" -label:muse-ingested newer_than:14d', maxResults: 20 });
  let named = 0, none = 0, skipped = 0;
  for (const m of r.data.messages || []) {
    const d = (await g.users.messages.get({ userId: 'me', id: m.id, format: 'full' })).data;
    const text = body(d.payload) || d.snippet || '';
    const s = text.indexOf('['), e = text.lastIndexOf(']');
    let rows = [];
    try { rows = JSON.parse(text.slice(s, e + 1)); } catch (err) { console.log(`message ${m.id}: no parseable JSON array, left unlabelled for a look`); continue; }
    for (const row of rows) {
      if (!row || !UUID.test(String(row.id))) { skipped++; continue; }
      const { data: l } = await sb.from('cadre_leads').select('*').eq('id', row.id).maybeSingle();
      if (!l || !/muse-queued/.test(l.notes || '')) { skipped++; continue; } // only rows we asked about
      const name = String(row.contact_name || '').trim();
      const ok = name && !/too large|null|unknown/i.test(name) && name.split(/\s+/).length >= 2;
      const u = ok
        ? { contact_name: name, contact_role: row.contact_role || null,
            notes: note(l, `muse ${today()}: ${name} (${row.contact_role || '?'}) ${row.linkedin_url || ''} staff ${row.staff_band || '?'}${row.email ? ', published email hint ' + row.email : ''}${row.format_evidence ? ', format evidence ' + row.format_evidence : ''}`) }
        : { notes: note(l, `muse-none ${today()}: ${name || 'no confident match'}${/too large/i.test(name) ? ', over 1000 staff, parked by hand' : ''}`) };
      if (ok && !l.website && row.website) u.website = String(row.website).trim();
      ok ? named++ : none++;
      console.log(`${ok ? 'named' : 'none '} ${l.business_name}: ${name || '-'} ${row.contact_role || ''}`);
      if (!DRY) await sb.from('cadre_leads').update(u).eq('id', l.id);
    }
    if (!DRY) await g.users.messages.modify({ userId: 'me', id: m.id, requestBody: { addLabelIds: [done.id] } });
  }
  console.log(`Ingest: ${named} named, ${none} no match, ${skipped} ignored.${DRY ? ' DRY RUN, nothing written.' : ''}`);
}

(async () => {
  if (process.argv.includes('--ingest')) await ingest();
  if (process.argv.includes('--queue')) await queue();
})().catch(e => { console.error(e.message); process.exit(1); });
