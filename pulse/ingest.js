#!/usr/bin/env node
/**
 * pulse/ingest.js — add signal-qualified leads to `pulse_leads`.
 *
 * There is deliberately no scraper here. The other two campaigns were both filled by querying
 * Google Places for a business type and assuming the pain: 3,808 sends, zero meetings. This
 * campaign only accepts a company that has published evidence it has the problem, and the
 * sources that carry that evidence (job boards, review sites) block programmatic access, so
 * collection happens in-session and lands here as JSON.
 *
 * That is a feature, not a workaround. The first-customers research is blunt that nobody got
 * customer #1 from a list larger than about 100, and a hand-built list of 40 beats 3,400.
 *
 *   node pulse/ingest.js leads.json --dry
 *   node pulse/ingest.js leads.json
 *
 * Each entry: { business_name, website?, city, industry, source, signal_type, signal_quote,
 *               signal_url, signal_date?, staff_estimate?, contact_name?, contact_role?,
 *               email?, phone?, notes? }
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const supabase = require('../lib/supabase');
const { excludedOrgReason } = require('../tempo/dnc');

const TABLE = 'pulse_leads';
const DRY = process.argv.includes('--dry');
const FILE = process.argv[2];

/** Regulated verticals. A workforce whose people cannot legally work on an expired ticket. */
const VERTICALS = ['health', 'trades', 'transport', 'childcare', 'security', 'food', 'lab', 'education'];

const SIGNAL_TYPES = ['hiring_credentialing', 'hiring_compliance', 'manual_tracking', 'tool_gap'];

/**
 * Score the strength of the signal, not the size of the company.
 *
 * The ranking reflects how directly the company has admitted the problem. Someone hiring a
 * person specifically to chase credentials has both the pain and a budget already approved,
 * which is a stronger position than a company that merely operates in a regulated vertical.
 */
function score(lead) {
  let s = 5;
  if (lead.signal_type === 'hiring_credentialing') s += 3;
  else if (lead.signal_type === 'manual_tracking') s += 3;   // named a spreadsheet themselves
  else if (lead.signal_type === 'tool_gap') s += 2;          // said their tool cannot do it
  else if (lead.signal_type === 'hiring_compliance') s += 1;

  // A quote that names the artifact is worth more than one that gestures at compliance.
  if (/spreadsheet|excel|manual|by hand|track(ing)? (licen|certif|credential)/i.test(lead.signal_quote || '')) s += 1;
  // Below ~15 staff there is rarely anyone accountable for the schedule of renewals, which is
  // the same reason the solo tier was wrong for every other product in this research.
  if (lead.staff_estimate && lead.staff_estimate < 15) s -= 2;
  if (lead.staff_estimate && lead.staff_estimate >= 40) s += 1;
  return Math.max(0, Math.min(10, s));
}

function validate(lead, i) {
  const errs = [];
  if (!lead.business_name) errs.push('business_name missing');
  if (!lead.signal_quote || lead.signal_quote.trim().length <= 20) {
    errs.push('signal_quote missing or too short (the DB rejects under 20 chars)');
  }
  if (!lead.signal_url) errs.push('signal_url missing');
  if (lead.signal_type && !SIGNAL_TYPES.includes(lead.signal_type)) {
    errs.push(`signal_type must be one of ${SIGNAL_TYPES.join(', ')}`);
  }
  if (lead.industry && !VERTICALS.includes(lead.industry)) {
    errs.push(`industry must be one of ${VERTICALS.join(', ')}`);
  }
  const dnc = excludedOrgReason(lead.business_name, lead.email);
  if (dnc) errs.push(dnc);
  return errs.length ? `[${i}] ${lead.business_name || '?'}: ${errs.join('; ')}` : null;
}

(async () => {
  if (!FILE || !fs.existsSync(FILE)) {
    console.error('Usage: node pulse/ingest.js <leads.json> [--dry]');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const leads = Array.isArray(raw) ? raw : raw.leads;
  if (!Array.isArray(leads)) throw new Error('Expected an array, or { leads: [...] }');

  const problems = leads.map(validate).filter(Boolean);
  if (problems.length) {
    console.error(`${problems.length} lead(s) rejected before touching the database:\n  ` + problems.join('\n  '));
    if (problems.length === leads.length) process.exit(1);
  }

  const { data: existing } = await supabase.from(TABLE).select('business_name');
  const have = new Set((existing || []).map(r => String(r.business_name).trim().toLowerCase()));

  let added = 0, skipped = 0;
  for (const [i, lead] of leads.entries()) {
    if (validate(lead, i)) continue;
    const key = String(lead.business_name).trim().toLowerCase();
    if (have.has(key)) { skipped++; continue; }

    const row = {
      business_name: lead.business_name.trim(),
      website: lead.website || null,
      city: lead.city || null,
      industry: lead.industry || null,
      source: lead.source || 'manual',
      staff_estimate: lead.staff_estimate || null,
      contact_name: lead.contact_name || null,
      contact_role: lead.contact_role || null,
      email: lead.email || null,
      phone: lead.phone || null,
      signal_type: lead.signal_type || null,
      signal_quote: lead.signal_quote.trim(),
      signal_url: lead.signal_url,
      signal_date: lead.signal_date || null,
      qualification_score: score(lead),
      // The quote IS the personalization. No inference, no guessing at their pain: the first
      // line of the email can reference something they wrote themselves.
      personalization_basis: `published signal: ${lead.signal_type || 'unclassified'}`,
      notes: lead.notes || null,
    };

    console.log(`${DRY ? '[dry] ' : ''}${String(row.qualification_score).padStart(2)}/10  ${row.business_name.slice(0, 38).padEnd(40)}${(row.city || '').padEnd(16)}${(row.signal_type || '')}`);
    console.log(`        "${row.signal_quote.slice(0, 110)}"`);

    if (!DRY) {
      const { error } = await supabase.from(TABLE).insert(row);
      if (error) { console.error(`        FAILED: ${error.message}`); continue; }
    }
    have.add(key);
    added++;
  }
  console.log(`\n${DRY ? 'Would add' : 'Added'} ${added} | already present ${skipped} | rejected ${problems.length}`);
})().catch(e => { console.error('ingest failed:', e.message); process.exit(1); });
