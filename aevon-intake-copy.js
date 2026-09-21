#!/usr/bin/env node
/**
 * aevon-intake-copy.js
 *
 * One email per broker whose online mortgage application I actually went through and counted
 * (2026-09-21, in a browser, fields visible on the applicant's path; the counts are in
 * cadre/state/apply-measure.json and the notes below). The shape: one checkable fact about
 * their own form, one sentence on what gets built, a one-line ask. No link, no product name,
 * no price. Nothing here is generic: if a broker is not in FACTS, no email.
 *
 * Where several people at one brokerage share a form (Powerhaus, One Stop), one person gets
 * the email; the rest stay where they are.
 *
 * Usage:
 *   node aevon-intake-copy.js            dry run: prints every email
 *   node aevon-intake-copy.js --apply    snapshots leads, writes copy, restarts at step 0
 */
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const BASIS = 'campaign:intake-2026';
const GAP_DAYS = 30;

// Counted 2026-09-21. TMG template (apply.aspx): 5 pages, 4 + 58 + 24 + 82 + 12 = 180 fields on
// the main path, plus 42 more if "previous address" or "previous employer" apply. Your Mortgage
// Source: 68 fields on one page, applicant + co-applicant + final details. Powerhaus: 30 fields
// over 4 pages, 18 required. One Stop: 19 fields on one page, all 19 required.
const TMG = site => `It runs to about 180 fields across five pages, 82 of them under assets and liabilities, before an applicant can submit.`;
const FACTS = {
  '337611a6-33f7-42fb-a4b2-0038cf7d91b1': { first: 'Katy', site: 'mackenziemortgage.com', fact: TMG() },
  'd0907322-3e1e-4a75-884e-1dcdad1bd88a': { first: 'Elisa', site: 'elisaswezey.com', fact: TMG() },
  'b5312abf-a82b-42c1-8e28-1864ae5efa03': { first: 'Jonathan', site: 'jonathanbuffone.ca', fact: TMG() },
  '043bf411-0e35-4717-9903-f47921ae524b': { first: 'Melanie', site: 'melaniezmortgages.com', fact: TMG() },
  '7a9bcc4b-7a1e-4828-8084-65d3ffb76c8e': { first: 'Amit', site: 'mortgagesbyamit.com', fact: TMG() },
  'b78b55b9-efdb-4967-a4e4-e35c7df39197': { first: 'Frank', site: 'bcsbestrates.com', fact: TMG() },
  '42b0e062-3f0f-486d-8786-4571ec63c062': { first: null, site: 'yourmortgagesource.org', fact: 'It is 68 fields on a single page, including a full co-applicant section, before anyone can submit.' },
  '2083a761-a1c4-442b-be66-9fdde5490806': { first: 'Ali', site: 'powerhausmortgages.com', fact: 'It is 30 fields across four pages, 18 of them required.' },
  '12b6c9e4-a6b3-4d53-b853-44c2a16396e5': { first: 'Michal', site: 'onestopmortgage.ca', fact: 'It is 19 fields on one page, every one of them required.' },
};

function copyFor(f) {
  const hi = f.first ? `Hi ${f.first},\n\n` : '';
  return {
    email_subject: 'your application form',
    email_body:
`${hi}I went through the mortgage application on ${f.site}. ${f.fact}

I build intake for brokers that asks the dozen questions that decide a file first and collects the rest, and the documents, after the applicant has already committed.

Want to see the short version?`,
    followup_subject: 're: your application form',
    followup_body:
`Quick one on the note below. If the form is doing its job as it is, a one-word no is a fine answer. If not, the short version takes two minutes to look at.`,
    followup2_subject: 're: your application form',
    followup2_body:
`Last one from me. If the application ever becomes worth shortening, reply and I will pick it up. All the best.`,
  };
}

async function snapshot() {
  const client = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const name = `leads_backup_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  await client.query(`CREATE TABLE IF NOT EXISTS ${name} AS TABLE leads`);
  await client.end();
  console.log(`Snapshot: ${name}`);
}

(async () => {
  const ids = Object.keys(FACTS);
  const { data, error } = await supabase.from('leads').select('id, business_name, email, status, sequence_step, last_sent_at, qualification_score, notes, personalization_basis').in('id', ids);
  if (error) throw new Error(error.message);
  const now = new Date();
  let n = 0;
  for (const l of data) {
    const f = FACTS[l.id];
    const copy = copyFor(f);
    const earliest = l.last_sent_at ? new Date(new Date(l.last_sent_at).getTime() + GAP_DAYS * 864e5) : now;
    const when = earliest > now ? earliest : now;
    console.log(`\n── ${l.business_name} <${l.email}> | was ${l.status}/${l.sequence_step} | sends ${when.toISOString().slice(0, 10)} ──\nSubject: ${copy.email_subject}\n\n${copy.email_body}\n`);
    if (!APPLY) continue;
    if (n === 0) await snapshot();
    const note = `intake-2026: restarted ${now.toISOString().slice(0, 10)} (was ${l.status}/${l.sequence_step}, score ${l.qualification_score})`;
    const { error: e } = await supabase.from('leads').update({
      ...copy, personalization_basis: BASIS, status: 'queued', sequence_step: 0,
      scheduled_send_at: when.toISOString(), qualification_score: 10,
      notes: l.notes && l.notes.trim() ? `${l.notes} | ${note}` : note,
    }).eq('id', l.id);
    if (e) console.log(`FAILED ${l.business_name}: ${e.message}`); else n++;
  }
  console.log(APPLY ? `\nWrote ${n} of ${data.length}.` : `\nDry run: ${data.length} emails. Re-run with --apply to queue them.`);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
