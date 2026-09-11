#!/usr/bin/env node
/**
 * cadre/size-from-990.js, free headcount estimate for US nonprofit leads from their own IRS 990.
 *
 * Nonprofits publish payroll on the 990 every year and ProPublica's Nonprofit Explorer mirrors
 * it with no key and no cost. There is no employee-count field on the form, but total salaries
 * and wages divided by an assumed average wage gets close enough to size a pitch: a nonprofit
 * with $30M in wages is not a 20-person org whatever staff_estimate currently says (usually
 * nothing, since Google Places headcount guesses do not cover nonprofits well). $52,000 is an
 * assumed average US nonprofit wage, so the result goes in as an estimate, never a count.
 *
 * A wrong org is worse than no estimate: two nonprofits can share a name across states, so the
 * match requires every meaningful word of the lead's name to appear in the candidate AND the
 * candidate's state to equal the lead's. First match in API order wins, nothing fuzzier.
 *
 * search.json's own `state` query param 500s no matter how it is passed (state=IN, state[]=IN,
 * state[id]=IN all tried live); the state filter is applied client-side against the state field
 * every returned organization already carries instead.
 *
 *   node cadre/size-from-990.js --dry --limit 40
 *   node cadre/size-from-990.js --limit 200
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const axios = require('axios');
const supabase = require('../lib/supabase');

const DRY = process.argv.includes('--dry');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > -1 ? parseInt(process.argv[i + 1], 10) : 200; })();
const GAP_MS = 350;
const AVG_WAGE = 52000;
const SEARCH_URL = 'https://projects.propublica.org/nonprofits/api/v2/search.json';
const ORG_URL = (ein) => `https://projects.propublica.org/nonprofits/api/v2/organizations/${ein}.json`;

const STOPWORDS = new Set(['inc', 'llc', 'ltd', 'corp', 'corporation', 'co', 'the', 'of', 'and']);

const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
  UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
  WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
};
const NAME_TO_CODE = Object.fromEntries(Object.entries(US_STATES).map(([code, name]) => [name.toLowerCase(), code]));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** '2-letter code or full name at the end of the city string', Canadian provinces do not collide with any US code. */
function stateFromCity(city) {
  if (!city) return null;
  const trimmed = String(city).trim();
  const lastToken = trimmed.split(/[\s,]+/).filter(Boolean).pop();
  if (lastToken && lastToken.length === 2 && US_STATES[lastToken.toUpperCase()]) return lastToken.toUpperCase();
  const lower = trimmed.toLowerCase();
  for (const [name, code] of Object.entries(NAME_TO_CODE)) {
    if (lower === name || lower.endsWith(', ' + name) || lower.endsWith(' ' + name)) return code;
  }
  return null;
}

/** lowercase, strip punctuation, drop entity-type and filler words, so 'Hamilton Center Inc' and 'Hamilton Center' compare equal. */
function normalize(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !STOPWORDS.has(w));
}

/** every 3+ letter lead token must appear in the candidate, and the states must match exactly. */
function isMatch(leadTokens, leadStateCode, org) {
  if (!org.state || String(org.state).toUpperCase() !== leadStateCode) return false;
  const candidateTokens = normalize(org.name);
  return leadTokens.every((t) => candidateTokens.includes(t));
}

/** newest filing first; a year with no salary line (e.g. a short-form 990-EZ) is skipped, not treated as zero staff. */
function pickFiling(filings) {
  const sorted = [...(filings || [])].sort((a, b) => (b.tax_prd_yr || 0) - (a.tax_prd_yr || 0));
  return sorted.find((f) => Number(f.othrsalwages) > 0) || null;
}

function appendNote(existing, suffix) {
  return existing && String(existing).trim() ? `${existing} | ${suffix}` : suffix;
}

(async () => {
  // Paged per the repo's 1000-row cap; the city/notes conditions are evaluated client-side
  // because 'notes not containing a substring' with nullable notes is not a clean PostgREST filter.
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('cadre_leads')
      .select('id, business_name, city, notes, status, staff_estimate, qualification_score')
      .is('staff_estimate', null)
      .in('status', ['queued', 'needs_review'])
      .order('qualification_score', { ascending: false, nullsFirst: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  console.log(`${rows.length} row(s) with staff_estimate null and status queued/needs_review.`);

  const candidates = rows.filter((r) => stateFromCity(r.city) && !(r.notes && r.notes.includes('size-from-990:')));
  console.log(`${candidates.length} match the US city/state filter and have not been run before.`);
  const leads = candidates.slice(0, LIMIT);
  console.log(`${DRY ? 'DRY RUN: ' : ''}${leads.length} lead(s) to check against ProPublica.\n`);

  const tally = { estimated: 0, noMatch: 0 };
  for (const lead of leads) {
    const stateCode = stateFromCity(lead.city);
    const leadTokens = normalize(lead.business_name).filter((t) => t.length >= 3);
    let org = null;
    try {
      // ProPublica answers HTTP 404, not 200, when total_results is 0; the body is still good
      // JSON. Letting axios throw on that status turned every real "zero results" case into a
      // fake network-error line, the exact kind of clean-looking zero this brief warned about.
      const res = await axios.get(SEARCH_URL, { params: { q: lead.business_name }, timeout: 15000, validateStatus: (s) => s === 200 || s === 404 });
      await sleep(GAP_MS);
      const orgs = res.data && Array.isArray(res.data.organizations) ? res.data.organizations : [];
      if (orgs.length === 0) {
        tally.noMatch++;
        console.log(`  --   ${lead.business_name}  not a nonprofit filer`);
        if (!DRY) await writeNoMatch(lead);
        continue;
      }
      org = orgs.find((o) => isMatch(leadTokens, stateCode, o)) || null;
      if (!org) {
        tally.noMatch++;
        console.log(`  --   ${lead.business_name}  no match`);
        if (!DRY) await writeNoMatch(lead);
        continue;
      }
    } catch (e) {
      tally.noMatch++;
      console.log(`  --   ${lead.business_name}  no match (search failed: ${e.message})`);
      if (!DRY) await writeNoMatch(lead);
      continue;
    }

    let filing = null;
    try {
      const res = await axios.get(ORG_URL(org.ein), { timeout: 15000, validateStatus: (s) => s === 200 || s === 404 });
      await sleep(GAP_MS);
      filing = pickFiling(res.data && res.data.filings_with_data);
    } catch (e) {
      filing = null;
    }
    if (!filing) {
      tally.noMatch++;
      console.log(`  --   ${lead.business_name}  no match`);
      if (!DRY) await writeNoMatch(lead);
      continue;
    }

    const wages = Number(filing.othrsalwages) + Number(filing.compnsatncurrofcr || 0);
    const estimate = Math.round(wages / AVG_WAGE);
    tally.estimated++;
    console.log(`  ok   ${lead.business_name.padEnd(34)} ~${estimate}   ${org.name} (${org.state}) FY${filing.tax_prd_yr}`);
    if (DRY) continue;
    const note = appendNote(lead.notes, `size-from-990: ~${estimate} staff estimated from FY${filing.tax_prd_yr} salaries $${filing.othrsalwages} (EIN ${org.ein}, ${org.name})`);
    const { error: e } = await supabase.from('cadre_leads')
      .update({ staff_estimate: estimate, notes: note })
      .eq('id', lead.id).is('staff_estimate', null);
    if (e) console.log(`       write failed: ${e.message}`);
  }

  async function writeNoMatch(lead) {
    const note = appendNote(lead.notes, 'size-from-990: no matching filing');
    const { error: e } = await supabase.from('cadre_leads')
      .update({ notes: note })
      .eq('id', lead.id).is('staff_estimate', null);
    if (e) console.log(`       write failed: ${e.message}`);
  }

  console.log(`\nestimated ${tally.estimated} | no match ${tally.noMatch}`);
  console.log('SIZE_FROM_990_DONE');
})().catch((e) => { console.error('size-from-990 failed:', e.message); process.exit(1); });
