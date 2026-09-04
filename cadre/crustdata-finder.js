#!/usr/bin/env node
/**
 * cadre/crustdata-finder.js, the same signal search as lead-finder.js, against an indexed
 * job corpus instead of a scraped one.
 *
 * WHY THIS EXISTS. SimplyHired returns page one only, 20 results a query, and by 2026-09-03 the
 * scraper had walked every phrase in every city and was finding 99 new companies from 2,447
 * queries. The board was exhausted, not the market. Crustdata indexes postings from company
 * career sites, Workday, LinkedIn and the boards, and lets us filter on the DESCRIPTION text
 * with an exact-phrase operator, so "training matrix" is a database query rather than twenty
 * page fetches and twenty deep reads.
 *
 * MEASURED 2026-09-04, postings added in the last 60 days, 50 to 1,000 staff, any of the
 * fifteen core phrases: CA 53, US 817, UK 153, AU 29, IE 18. Counts are free; rows cost
 * $0.009 each (0.03 Crustdata credits, treg passes it through at cost). So the whole pool is
 * about ten dollars, and one country is pocket change.
 *
 * Grammar, learned by probing (the docs describe a different shape): a filter is either a
 * leaf { field, type, value } or a group { op: 'and' | 'or', conditions: [...] }. `[.]` is
 * exact phrase, `(.)` is typo-tolerant all-words and overmatches. Only indexed columns can be
 * filtered; content.description is one of them. Sorts are { field, order }.
 *
 *   node cadre/crustdata-finder.js --country ca --count            free, prints the pool size
 *   node cadre/crustdata-finder.js --country ca --limit 60 --dry   pulls rows (CHARGED), filters, no DB
 *   node cadre/crustdata-finder.js --raw cadre/batches/crustdata-raw-ca-2026-09-04.json --dry
 *                                                                  re-filter a saved pull, free
 *   node cadre/crustdata-finder.js --country us --limit 200        pulls, filters, ingests
 *
 * Every row is filtered by the SAME rules as lead-finder.js (applicant-facing quotes out,
 * employer-side verbs required, agencies and giants excluded), then handed to ingest.js, which
 * dedupes by company name. Metered calls fail closed on TREG_ARMED and on --budget.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { spawnSync } = require('child_process');
const treg = require('../lib/treg');
const { APPLICANT_FACING, INTERNAL_WORK, EXCLUDE_NAME, EXCLUDE_LARGE, extractQuote, inferIndustry } = require('./lead-finder');

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : dflt; };
const DRY = process.argv.includes('--dry');
const COUNT_ONLY = process.argv.includes('--count');
const RAW = arg('raw', null);
const COUNTRY = { ca: 'Canada', us: 'United States', uk: 'United Kingdom', au: 'Australia', ie: 'Ireland' }[arg('country', 'ca')];
const DAYS = parseInt(arg('days', '60'), 10);
const LIMIT = Math.min(1000, parseInt(arg('limit', '50'), 10));
const MIN_STAFF = parseInt(arg('min-staff', '50'), 10);
const MAX_STAFF = parseInt(arg('max-staff', '1000'), 10);
const BUDGET_CENTS = parseFloat(arg('budget', '100'));
const ENDPOINT = 'crustdata.companies.jobs.search';
const CENTS_PER_ROW = 0.9;

if (!COUNTRY) { console.error('--country must be one of ca, us, uk, au, ie'); process.exit(1); }

/**
 * The finder's phrase list is 40 long and most of the tail is spelling variants for a scraper
 * that cannot do OR. Here one query carries the whole family, so this is the subset that
 * actually produced leads, plus the expiry family.
 */
const PHRASES = [
  'training matrix', 'maintain the training matrix', 'competency matrix', 'competence matrix',
  'skills matrix', 'qualification matrix',
  'maintain accurate training records', 'maintain training records', 'training and competency records',
  'training and competence records', 'competency records', 'certification records', 'training register',
  'certification register', 'training records and certificates',
  'monitor licence expiry dates', 'certification expiry', 'certification tracking',
  'track certifications', 'certifications are up to date',
  // 'monitor expiry dates' and 'renewal tracking' are dropped: in this corpus they are contract
  // and subscription work (Smardt, Autodesk, Embrace Software, Blyth Academy on the first pull).
];

/** The quote must be about people's credentials, whatever phrase matched. */
const ABOUT_CREDENTIALS = /\b(train|certif|licen|competen|qualif|ticket|credential|first aid|matrix|skills|orientation)/i;

/**
 * Global companies whose local entity reports 50 to 1,000 staff. lead-finder's EXCLUDE_LARGE is
 * Canadian names; these came through on the first Crustdata pull. Jobgether is an aggregator.
 */
const EXTRA_ENTERPRISE = /\b(sanofi|cardinal health|autodesk|jobgether|menzies aviation|dexterra)\b/i;

const FIELDS = [
  'crustdata_job_id', 'job_details.title', 'job_details.url', 'job_details.source',
  'content.description', 'company.basic_info.name', 'company.basic_info.website',
  'company.basic_info.primary_domain', 'company.basic_info.industries', 'company.headcount.total',
  'location.city', 'location.state', 'location.country', 'metadata.date_added',
];

/** Rounded to the day so a re-run within the day is an idempotent replay, not a second charge. */
function since() {
  const d = new Date(Date.now() - DAYS * 86400000);
  return d.toISOString().slice(0, 10) + 'T00:00:00';
}

function filters() {
  return {
    op: 'and',
    conditions: [
      { op: 'or', conditions: PHRASES.map((p) => ({ field: 'content.description', type: '[.]', value: p })) },
      { field: 'location.country', type: '=', value: COUNTRY },
      { field: 'company.headcount.total', type: '=>', value: MIN_STAFF },
      { field: 'company.headcount.total', type: '=<', value: MAX_STAFF },
      { field: 'metadata.date_added', type: '=>', value: since() },
    ],
  };
}

function textOf(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

/** Which phrase the description actually contains. The index said one does; find it. */
function matchedPhrase(text) {
  const t = text.toLowerCase();
  return PHRASES.find((p) => t.includes(p.toLowerCase())) || null;
}

function rejectReason(name, quote) {
  if (EXCLUDE_NAME.some((re) => re.test(name))) return 'agency/training provider/public body';
  if (EXCLUDE_LARGE.some((re) => re.test(name)) || EXTRA_ENTERPRISE.test(name)) return 'enterprise';
  if (APPLICANT_FACING.some((re) => re.test(quote))) return 'applicant-facing';
  if (!INTERNAL_WORK.test(quote)) return 'no employer-side verb';
  if (!ABOUT_CREDENTIALS.test(quote)) return 'not about credentials';
  return null;
}

/**
 * Bulleted ads flatten to one long "sentence" with no full stops, and extractQuote then returns
 * the whole ad. Cut a window around the phrase instead, on word boundaries.
 */
function tightQuote(text, phrase) {
  const q = extractQuote(text, phrase);
  if (q.length <= 220) return q;
  const i = q.toLowerCase().indexOf(phrase.toLowerCase());
  const start = Math.max(0, q.lastIndexOf(' ', Math.max(0, i - 90)) + 1);
  const end = Math.min(q.length, (q.indexOf(' ', i + phrase.length + 90) + 1 || q.length + 1) - 1);
  return q.slice(start, end).trim();
}

const norm = (n) => String(n).toLowerCase().replace(/[.,()]/g, ' ')
  .replace(/\b(inc|ltd|limited|corp|corporation|co|company|society|group|holdings|llc|lp)\b/g, ' ')
  .replace(/\s+/g, ' ').trim();

function toLead(row) {
  const d = row.job_details || {}, c = row.company || {}, bi = c.basic_info || {}, loc = row.location || {};
  const name = bi.name || '';
  const text = textOf((row.content || {}).description);
  const phrase = matchedPhrase(text);
  if (!phrase) return { reject: 'phrase not in body (index overmatch)' , name };
  const quote = tightQuote(text, phrase);
  const reject = rejectReason(name, quote);
  if (reject) return { reject, name, quote };
  const website = bi.website || (bi.primary_domain ? `https://${bi.primary_domain}` : null);
  return {
    lead: {
      business_name: name,
      website,
      city: [loc.city, loc.state].filter(Boolean).join(', ') || loc.country || null,
      industry: inferIndustry(`${d.title || ''} ${name} ${(bi.industries || []).join(' ')} ${quote}`),
      source: 'crustdata',
      signal_type: /matrix|spreadsheet|binder|by hand|manual/i.test(quote) ? 'manual_tracking' : 'hiring_credentialing',
      signal_quote: quote.slice(0, 400),
      signal_url: d.url,
      signal_date: (row.metadata || {}).date_added ? String(row.metadata.date_added).slice(0, 10) : null,
      staff_estimate: (c.headcount || {}).total || null,
      notes: `crustdata ${row.crustdata_job_id || ''} via ${d.source || '?'}; posting: ${d.title || ''}; phrase: ${phrase}`,
    },
  };
}

async function pull() {
  const budget = treg.newBudget(BUDGET_CENTS);
  const bal = await treg.balance();
  const countRes = await treg.call(ENDPOINT, {}, { method: 'POST', budget, body: { filters: filters(), limit: 0, aggregations: [{ type: 'count' }] } });
  const pool = countRes.data.total_count;
  console.log(`${COUNTRY}, last ${DAYS} days, ${MIN_STAFF}-${MAX_STAFF} staff: ${pool} posting(s) match. Balance $${bal.usd}.`);
  if (COUNT_ONLY) return null;

  const rows = Math.min(LIMIT, pool);
  const estimate = rows * CENTS_PER_ROW;
  if (estimate > BUDGET_CENTS) {
    console.error(`Pulling ${rows} rows is about ${estimate.toFixed(0)}c, over the ${BUDGET_CENTS}c budget. Lower --limit or raise --budget.`);
    process.exit(1);
  }
  if (estimate > Number(bal.usd) * 100) {
    console.error(`Pulling ${rows} rows is about ${estimate.toFixed(0)}c and the balance is $${bal.usd}. Top up first.`);
    process.exit(1);
  }
  console.log(`${DRY ? 'DRY RUN: ' : ''}pulling ${rows} newest, about ${estimate.toFixed(0)}c.\n`);

  const res = await treg.call(ENDPOINT, {}, { method: 'POST', budget, body: {
    filters: filters(), fields: FIELDS, sorts: [{ field: 'metadata.date_added', order: 'desc' }], limit: rows,
  } });
  const listings = res.data.job_listings || [];
  console.log(`got ${listings.length} row(s), charged ${res.costCents.toFixed(1)}c${res.replay ? ' (replay, not charged again)' : ''}.`);
  // Paid for once, filtered as many times as the rules change.
  const rawOut = path.join(__dirname, 'batches', `crustdata-raw-${arg('country', 'ca')}-${new Date().toISOString().slice(0, 10)}.json`);
  fs.mkdirSync(path.dirname(rawOut), { recursive: true });
  fs.writeFileSync(rawOut, JSON.stringify(listings, null, 1));
  console.log(`raw rows saved to ${rawOut}\n`);
  return listings;
}

(async () => {
  const listings = RAW ? JSON.parse(fs.readFileSync(RAW, 'utf8')) : await pull();
  if (!listings) return;

  const leads = [], rejected = {};
  const seen = new Set();
  for (const row of listings) {
    const r = toLead(row);
    if (r.reject) { rejected[r.reject] = (rejected[r.reject] || 0) + 1; continue; }
    const key = norm(r.lead.business_name);
    if (seen.has(key)) continue;   // same company, several postings
    seen.add(key);
    leads.push(r.lead);
    console.log(`  ${String(r.lead.staff_estimate || '?').padStart(4)}  ${r.lead.business_name.slice(0, 36).padEnd(38)}${String(r.lead.city || '').slice(0, 22).padEnd(24)}${r.lead.industry}`);
    console.log(`        "${r.lead.signal_quote.slice(0, 110)}"`);
  }
  console.log(`\n${leads.length} lead(s) from ${listings.length} posting(s). Rejected: ${JSON.stringify(rejected)}`);
  if (!leads.length) return;

  const out = path.join(__dirname, 'batches', `crustdata-${arg('country', 'ca')}-${new Date().toISOString().slice(0, 10)}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(leads, null, 2));
  console.log(`wrote ${out}\n`);

  const ingest = spawnSync(process.execPath, [path.join(__dirname, 'ingest.js'), out, ...(DRY ? ['--dry'] : [])], { stdio: 'inherit' });
  process.exit(ingest.status || 0);
})().catch((e) => {
  console.error('crustdata-finder failed:', e.message, e.body ? JSON.stringify(e.body).slice(0, 300) : '');
  process.exit(1);
});
