#!/usr/bin/env node
/**
 * sync-suppressions.js — push every opt-out we hold into Resend's suppression list.
 *
 * WHY. Twice now a person has asked to be left alone and our own code did not catch it, both
 * times by the identical mechanism: they replied from their real address while the lead row
 * held a generic one. Robert at Kornfeld writes from robert@, the row held rob@. Laura at
 * Boughton writes from lcyprus@, the row held pr@. Both were caught by a human reading the
 * inbox, not by the pipeline.
 *
 * Every guard we have is ours: a status column, a JSON name list, a hardcoded domain array in
 * tempo/dnc.js. They all sit INSIDE the thing that keeps failing. Resend shipped managed
 * suppression lists in September 2026, which puts a block at the provider: once an address is
 * suppressed, Resend refuses to deliver to it whatever this repo asks for. That is the first
 * guard in the stack that survives a bug in our own code.
 *
 * Suppressions apply organisation-wide across all domains and are reversible (DELETE), so the
 * failure mode of running this too eagerly is an email that does not go out. That is the right
 * direction to fail in.
 *
 *   node sync-suppressions.js            dry run, prints what it would suppress
 *   node sync-suppressions.js --apply    actually pushes them
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const https = require('https');
const supabase = require('./lib/supabase');

const KEY = process.env.RESEND_API_KEY;
const APPLY = process.argv.includes('--apply');
const STOP_STATUSES = ['dont_contact', 'unsubscribed', 'bounced'];
/**
 * Deliberately strict. Resend refuses a batch WHOLE if any single address in it is malformed,
 * so one bad row costs 99 good ones. Measured 2026-09-02: 500 of 985 were lost that way before
 * this existed. A skipped row costs one address, a rejected batch costs a hundred.
 */
const VALID = /^[^\s@,;<>()[\]\\]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function resend(method, p, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(`https://api.resend.com${p}`, {
      method,
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let d = null;
        try { d = raw ? JSON.parse(raw) : null; } catch (e) { d = { raw }; }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(d);
        reject(new Error(`HTTP ${res.statusCode}: ${(d && (d.message || d.name)) || raw.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function page(table, cols) {
  let out = [], from = 0;
  for (;;) {
    const { data, error } = await supabase.from(table).select(cols).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out = out.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}

(async () => {
  if (!KEY) throw new Error('RESEND_API_KEY is not set.');

  const seen = new Map(); // email -> why
  const bad = [];
  for (const table of ['leads', 'cadre_leads']) {
    let rows;
    try { rows = await page(table, 'email, status, business_name'); }
    catch (e) { console.log(`skipping ${table}: ${e.message}`); continue; }
    for (const r of rows) {
      const email = String(r.email || '').trim().toLowerCase();
      if (!VALID.test(email)) { if (email) bad.push(email); continue; }
      if (!STOP_STATUSES.includes(r.status)) continue;
      if (!seen.has(email)) seen.set(email, `${r.status} · ${r.business_name || ''}`.trim());
    }
  }

  const emails = [...seen.keys()];
  console.log(`${emails.length} address(es) held at ${STOP_STATUSES.join(' / ')} across both tables.\n`);
  emails.slice(0, 40).forEach((e) => console.log(`  ${e.padEnd(40)} ${seen.get(e)}`));
  if (emails.length > 40) console.log(`  ... and ${emails.length - 40} more`);

  if (!emails.length) return;
  if (!APPLY) {
    console.log('\nDRY RUN. Nothing pushed. Re-run with --apply to suppress these at Resend.');
    return;
  }

  let ok = 0, failed = 0;
  for (let i = 0; i < emails.length; i += 100) {
    const chunk = emails.slice(i, i + 100);
    try {
      await resend('POST', '/suppressions/batch/add', { emails: chunk });
      ok += chunk.length;
      console.log(`  suppressed ${ok}/${emails.length}`);
    } catch (e) {
      // The batch is refused whole, so retry singly and lose only the actual offender.
      console.log(`  batch at ${i} rejected (${e.message}), retrying one at a time`);
      for (const one of chunk) {
        try { await resend('POST', '/suppressions', { email: one }); ok += 1; }
        catch (e2) { failed += 1; console.log(`    ! ${one}: ${e2.message}`); }
      }
      console.log(`  suppressed ${ok}/${emails.length}`);
    }
  }
  console.log(`\nSuppressed ${ok}. Failed ${failed}.`);
  console.log('Resend now refuses these org-wide, whatever this repo asks it to send.');
})().catch((e) => { console.error('sync-suppressions failed:', e.message); process.exit(1); });
