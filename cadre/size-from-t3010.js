#!/usr/bin/env node
/**
 * cadre/size-from-t3010.js, exact headcount for Canadian nonprofit leads from the CRA's T3010.
 *
 * Every registered charity in Canada files a T3010, Registered Charity Information Return, and
 * Schedule 3 of that return asks for the number of permanent full-time compensated positions
 * (line 300) and the number of part-time or part-year employees (line 370). That is a number the
 * charity itself reported to the CRA under penalty of losing its registration, not a guess from a
 * job posting or a stated "team of X" line on a website. It is also free: CRA publishes the whole
 * country's charities as an open-data extract, no scraping, no treg budget.
 *
 * Source: open.canada.ca, dataset "2024 List of charities" (open.canada.ca/data/en/dataset/
 * 80c00cdb-1358-415c-bb8b-0de7f12675b8), year 2024 (latest year published as of 2026-09-10, no
 * 2025 extract exists yet). Two files used, downloaded to cadre/batches/t3010/:
 *   - ident_2024.csv              charity name, city, province, business number (BN)
 *   - schedule_3_compensation_2024.csv   line 300 (full-time) and line 370 (part-time)
 *
 * Matching is strict on purpose: normalise both names (lowercase, strip punctuation and the
 * words inc/ltd/society/association/foundation/the/of/and), require every remaining lead token
 * of 3+ letters to appear in the charity's token set, and require the province to match too. A
 * charity that reported no full-time figure at all (blank, not "0") is treated the same as no
 * match: printing 0 there would be a fabricated number, not a fact the charity gave the CRA.
 *
 * Never touches status or scheduled_send_at, only staff_estimate and notes.
 *
 *   node cadre/size-from-t3010.js --dry --limit 40
 *   node cadre/size-from-t3010.js --limit 300
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const supabase = require('../lib/supabase');

const DRY = process.argv.includes('--dry');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > -1 ? parseInt(process.argv[i + 1], 10) : 60; })();
const BATCH_DIR = path.join(__dirname, 'batches', 't3010');
const IDENT_PATH = path.join(BATCH_DIR, 'ident_2024.csv');
const COMP_PATH = path.join(BATCH_DIR, 'schedule_3_compensation_2024.csv');

const PROVINCE_CODES = new Set(['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT']);
const PROVINCE_FULL_NAMES = {
  alberta: 'AB', 'british columbia': 'BC', manitoba: 'MB', 'new brunswick': 'NB',
  'newfoundland and labrador': 'NL', newfoundland: 'NL', 'nova scotia': 'NS',
  'northwest territories': 'NT', nunavut: 'NU', ontario: 'ON',
  'prince edward island': 'PE', quebec: 'QC', 'québec': 'QC', saskatchewan: 'SK', yukon: 'YT',
};
const STRIP_WORDS = new Set(['inc', 'ltd', 'society', 'association', 'foundation', 'the', 'of', 'and']);

/** Minimal CSV line splitter, handles quoted fields and doubled quotes ("") inside them. */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function loadCsv(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  const header = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const row = {};
    header.forEach((h, idx) => { row[h] = cols[idx]; });
    rows.push(row);
  }
  return rows;
}

function normalizeTokens(name) {
  const s = String(name).toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  return s.split(/\s+/).filter(Boolean).filter((t) => !STRIP_WORDS.has(t));
}

/** Reads a province out of a lead's city field. Trailing 2-letter code takes priority (the
 * dataset's own format, e.g. "Chilliwack BC" or "Bonnyville, AB") since it never collides with a
 * US state code. Full province names only match when there is no trailing code at all, so a real
 * "Ontario, CA" or "Yukon, OK" lead (both real US places) is never misread as Canadian. */
function detectProvince(city) {
  const c = String(city).trim();
  const tokens = c.split(/[,\s]+/).filter(Boolean);
  const last = tokens[tokens.length - 1] || '';
  if (/^[a-zA-Z]{2}$/.test(last)) return PROVINCE_CODES.has(last.toUpperCase()) ? last.toUpperCase() : null;
  const lc = c.toLowerCase();
  for (const [name, code] of Object.entries(PROVINCE_FULL_NAMES)) {
    if (lc.includes(name)) return code;
  }
  return null;
}

/** Best charity match for a lead name within one province: every lead token of 3+ letters must
 * appear in the charity's token set, then the tightest-named candidate wins (fewest extra
 * tokens), to reduce the odds of a small local charity matching a big national one by fluke. */
function findMatch(leadName, candidates) {
  const leadTokens = normalizeTokens(leadName).filter((t) => t.length >= 3);
  if (leadTokens.length === 0) return null;
  const matches = candidates.filter((c) => leadTokens.every((t) => c.tokenSet.has(t)));
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.tokens.length - b.tokens.length);
  return matches[0];
}

(async () => {
  if (!fs.existsSync(IDENT_PATH) || !fs.existsSync(COMP_PATH)) {
    throw new Error(`T3010 files not found in ${BATCH_DIR}. Expected ident_2024.csv and schedule_3_compensation_2024.csv.`);
  }
  console.log('Loading T3010 2024 extract...');
  const compRows = loadCsv(COMP_PATH);
  const compByBn = new Map();
  for (const r of compRows) {
    // Blank line 300 means the charity was exempt from reporting it, not zero. Treating it as
    // zero would fabricate a headcount, so those BNs are simply not indexed as matchable.
    if (r['300'] === '' || r['300'] === undefined) continue;
    compByBn.set(r.BN, r);
  }
  const identRows = loadCsv(IDENT_PATH);
  const charitiesByProvince = {};
  for (const r of identRows) {
    const comp = compByBn.get(r.BN);
    if (!comp) continue;
    const province = String(r.Province || '').toUpperCase();
    if (!PROVINCE_CODES.has(province)) continue;
    const tokens = normalizeTokens(r['Legal Name']);
    if (!charitiesByProvince[province]) charitiesByProvince[province] = [];
    charitiesByProvince[province].push({ bn: r.BN, name: r['Legal Name'], tokens, tokenSet: new Set(tokens), comp });
  }
  console.log(`Indexed ${compByBn.size} charities with a reported full-time figure, across ${Object.keys(charitiesByProvince).length} provinces.\n`);

  // Page through cadre_leads in case the candidate set ever exceeds Supabase's 1000-row cap.
  const candidates = [];
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await supabase.from('cadre_leads')
      .select('id, business_name, city, staff_estimate, status, notes')
      .in('status', ['queued', 'needs_review']).is('staff_estimate', null).not('city', 'is', null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    candidates.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  const leads = candidates.filter((l) => {
    if (String(l.notes || '').includes('size-from-t3010:')) return false;
    return detectProvince(l.city) !== null;
  }).slice(0, LIMIT);

  console.log(`${DRY ? 'DRY RUN: ' : ''}${candidates.length} candidate row(s) selected (staff_estimate null, status queued/needs_review, city not null); ${leads.length} in a Canadian province and not already tried, processing up to --limit ${LIMIT}.\n`);

  const tally = { matched: 0, none: 0 };
  for (const lead of leads) {
    const province = detectProvince(lead.city);
    const tag = String(lead.business_name).slice(0, 32).padEnd(34);
    const match = findMatch(lead.business_name, charitiesByProvince[province] || []);
    const existingNotes = lead.notes || '';
    if (!match) {
      tally.none++;
      console.log(`  --   ${tag}${province}   not a registered charity or no match`);
      if (!DRY) {
        const { error: e } = await supabase.from('cadre_leads')
          .update({ notes: `${existingNotes}${existingNotes ? ' | ' : ''}size-from-t3010: not a registered charity or no match` })
          .eq('id', lead.id);
        if (e) console.log(`       write failed: ${e.message}`);
      }
      continue;
    }
    const ft = parseInt(match.comp['300'], 10) || 0;
    const ptRaw = match.comp['370'];
    const hasPt = ptRaw !== '' && ptRaw !== undefined;
    const pt = hasPt ? parseInt(ptRaw, 10) || 0 : 0;
    const staffEstimate = Math.round(ft + (hasPt ? pt * 0.5 : 0));
    const year = (match.comp.FPE || '').slice(0, 4) || '2024';
    tally.matched++;
    console.log(`  ok   ${tag}${province}   ${ft} FT + ${pt} PT -> staff_estimate ${staffEstimate}   ${match.name} (BN ${match.bn})`);
    if (!DRY) {
      const noteLine = `size-from-t3010: ${ft} full-time, ${pt} part-time, FY${year}, BN ${match.bn}, ${match.name}`;
      const { error: e } = await supabase.from('cadre_leads')
        .update({ staff_estimate: staffEstimate, notes: `${existingNotes}${existingNotes ? ' | ' : ''}${noteLine}` })
        .eq('id', lead.id);
      if (e) console.log(`       write failed: ${e.message}`);
    }
  }

  console.log(`\nmatched ${tally.matched} | no match ${tally.none}`);
  console.log('SIZE_FROM_T3010_DONE');
})().catch((e) => { console.error('size-from-t3010 failed:', e.message); process.exit(1); });
