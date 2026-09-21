#!/usr/bin/env node
/**
 * cadre/prospeo-finder.js, a lead source on Prospeo's search-person API, not a job posting.
 *
 * WHY THIS EXISTS. lead-finder.js, crustdata-finder.js and linkedin-finder.js all start from a
 * job ad and work backwards to a company. That misses every company with the same problem that
 * is not hiring for it right now. Prospeo's search-person filters companies directly on
 * headcount, industry and country, then filters people at those companies on job title and
 * seniority, so the HR contact is found the same day the company is, no posting required.
 *
 * MOST LEADS HERE HAVE NO QUOTE. That is the trade. cadre_leads' own check constraint
 * (cadre_leads_requires_signal) was widened on 2026-09-12 to accept a null signal_quote when
 * personalization_basis is exactly 'industry-template', and ingest.js's validate() now mirrors
 * that. A lead only gets a real quote when the company's job_postings carry an employer-side
 * sentence; otherwise it goes in as industry-template and the personalizer writes from the
 * industry, not a verbatim line.
 *
 * job_postings IS NOT THE SHAPE THE BRIEF ASSUMED. Verified live 2026-09-12: it is an object,
 * {active_count, active_titles: [...]}, a list of bare job titles with no description text at
 * all, not an array of postings with a description field. A title like "project scheduler" has
 * no sentence for extractQuote to find and no employer-side verb for INTERNAL_WORK to match, so
 * in practice this branch almost never fires. The code below handles both shapes (the object
 * Prospeo actually returns, and an array in case a future response nests real posting text) so
 * it costs nothing to keep and isn't relied on.
 *
 * inferIndustry (lead-finder.js) MISSES MOST OF PROSPEO'S OWN INDUSTRY LABELS. It matches
 * whole words with \b...\b, so 'construct' never matches inside "Construction" and
 * 'manufactur' never matches inside "Manufacturing" (verified: both test false). Of the 22
 * industries Prospeo can return, inferIndustry alone maps only 8 to a real vertical; the rest
 * come back 'other'. Rather than touch the shared regex (crustdata-finder.js and
 * linkedin-finder.js both depend on it and neither showed this failure mode in their own
 * corpora), PROSPEO_INDUSTRY_FALLBACK below is a direct map from Prospeo's own closed industry
 * list to a cadre_leads vertical, used only when inferIndustry(industry + name) says 'other'.
 *
 * CREDITS ARE SHARED WITH cadre/free-contacts.js, same account, same monthly pool (~90 total,
 * ~70 left as of 2026-09-12). This finder fails closed on two independent limits: --budget
 * (credits this run may spend, default 20) and --floor (stop once the account's own
 * remaining_credits, read from POST /account-information, drops below this, default 40), so a
 * long pull here can never eat into what free-contacts.js needs for enrichment. A search page
 * only costs a credit when it returns at least one person; NO_RESULTS is free.
 *
 *   node cadre/prospeo-finder.js --country ca --pages 1 --dry     spends up to 1 credit (a
 *                                                                  page that returns anyone is
 *                                                                  charged even in --dry)
 *   node cadre/prospeo-finder.js --country ca --pages 6
 *   node cadre/prospeo-finder.js --raw cadre/batches/prospeo-raw-ca-2026-09-12.json --dry
 *                                                                  re-filter a saved pull, free
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { spawnSync } = require('child_process');
const supabase = require('../lib/supabase');
const { EXCLUDE_NAME, EXCLUDE_LARGE, PHRASES, INTERNAL_WORK, extractQuote, inferIndustry } = require('./lead-finder');

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : dflt; };
const DRY = process.argv.includes('--dry');
const RAW = arg('raw', null);
const COUNTRY = arg('country', 'ca');
const COUNTRY_NAME = { ca: 'Canada', us: 'United States', uk: 'United Kingdom' }[COUNTRY];
const PAGES = parseInt(arg('pages', '4'), 10);
const BUDGET = parseInt(arg('budget', '20'), 10);
const FLOOR = parseInt(arg('floor', '40'), 10);
// Default title list rebuilt 2026-09-21 from the buyer research: safety leadership owns the records,
// the owner signs under 200 staff, HR leadership signs above it. Pass --title to run one at a time.
const TITLE = arg('title', 'human resources');
const TITLE_PLAN = ['safety', 'hse', 'human resources', 'president', 'operations', 'director of care'];
const STAMP = new Date().toISOString().slice(0, 10);

if (!COUNTRY_NAME) { console.error('--country must be one of ca, us, uk'); process.exit(1); }
const PROSPEO_KEY = process.env.PROSPEO_KEY;
if (!PROSPEO_KEY) { console.error('PROSPEO_KEY is not set'); process.exit(1); }

/** Exact strings, verified against Prospeo's own filter values. */
const INDUSTRIES = [
  'Construction', 'Truck and Railroad Transportation',
  'Transportation, Logistics, Supply Chain and Storage', 'Freight and Package Transportation',
  'General Manufacturing', 'Industrial Machinery Manufacturing', 'Machinery Manufacturing',
  'Food and Beverage Manufacturing', 'Hospitals and Health Care', 'Home Health Care Services',
  'Mental Health Care', 'Oil, Gas, and Mining', 'Utilities', 'Facilities Services',
  'Environmental Services', 'Security and Investigations', 'Non-profit Organizations',
  'Individual and Family Services', 'Community Services', 'Child Day Care Services',
  'Warehousing and Storage', 'Utility System Construction',
];

/**
 * inferIndustry's own regexes never match Prospeo's industry strings for these labels (see
 * header). Mapped to the nearest cadre_leads vertical rather than left as the raw string, which
 * ingest.js's VERTICALS enum would reject outright.
 */
const PROSPEO_INDUSTRY_FALLBACK = {
  'Construction': 'trades',
  'Truck and Railroad Transportation': 'transport',
  'Transportation, Logistics, Supply Chain and Storage': 'transport',
  'Freight and Package Transportation': 'transport',
  'General Manufacturing': 'manufacturing',
  'Industrial Machinery Manufacturing': 'manufacturing',
  'Machinery Manufacturing': 'manufacturing',
  'Food and Beverage Manufacturing': 'food',
  'Hospitals and Health Care': 'health',
  'Home Health Care Services': 'health',
  'Mental Health Care': 'health',
  'Oil, Gas, and Mining': 'trades',
  'Utilities': 'utilities',
  'Facilities Services': 'facilities',
  'Environmental Services': 'environmental',
  'Security and Investigations': 'security',
  'Non-profit Organizations': 'other',
  'Individual and Family Services': 'childcare',
  'Community Services': 'other',
  'Child Day Care Services': 'childcare',
  'Warehousing and Storage': 'warehousing',
  'Utility System Construction': 'utilities',
};

const PROVINCE_ABBR = {
  alberta: 'AB', 'british columbia': 'BC', manitoba: 'MB', 'new brunswick': 'NB',
  'newfoundland and labrador': 'NL', 'nova scotia': 'NS', ontario: 'ON',
  'prince edward island': 'PE', quebec: 'QC', 'québec': 'QC', saskatchewan: 'SK',
  'northwest territories': 'NT', nunavut: 'NU', yukon: 'YT',
};
const STATE_ABBR = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

function cityOf(loc) {
  if (!loc) return null;
  if (COUNTRY === 'uk') return loc.city ? `${loc.city}, UK` : null;
  const abbr = PROVINCE_ABBR[String(loc.state || '').toLowerCase()] || STATE_ABBR[String(loc.state || '').toLowerCase()];
  if (loc.city && abbr) return `${loc.city}, ${abbr}`;
  return loc.city || loc.state || null;
}

const norm = (n) => String(n).toLowerCase().replace(/[.,()]/g, ' ')
  .replace(/\b(inc|ltd|limited|corp|corporation|co|company|society|group|holdings|llc|lp)\b/g, ' ')
  .replace(/\s+/g, ' ').trim();

function apexOf(website) {
  try {
    const h = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.toLowerCase();
    return h.replace(/^www\./, '');
  } catch { return null; }
}

/** Director/VP/Head beats Manager beats anything else. Lower number wins. */
function titleRank(title) {
  const t = String(title || '').toLowerCase();
  if (/\b(director|vp|vice president|head)\b/.test(t)) return 1;
  if (/\bmanager\b/.test(t)) return 2;
  return 3;
}

/** One person per company, best title wins, VERIFIED breaks a tie. */
function better(a, b) {
  const ra = titleRank(a.person.current_job_title), rb = titleRank(b.person.current_job_title);
  if (ra !== rb) return ra < rb ? a : b;
  const va = a.person.email && a.person.email.status === 'VERIFIED';
  const vb = b.person.email && b.person.email.status === 'VERIFIED';
  if (va !== vb) return va ? a : b;
  return a;
}

/**
 * job_postings' titles almost never contain a campaign phrase or an employer-side verb (see
 * header), so this correctly returns nothing for the overwhelming majority of leads. Kept
 * general enough to also read an array of {description, url} in case a plan upgrade or a future
 * response shape actually nests posting text.
 */
function postingQuote(jobPostings) {
  const texts = [];
  if (Array.isArray(jobPostings)) {
    for (const p of jobPostings) if (p && p.description) texts.push({ text: p.description, url: p.url || p.job_url || null });
  } else if (jobPostings && Array.isArray(jobPostings.active_titles)) {
    for (const t of jobPostings.active_titles) texts.push({ text: String(t), url: null });
  }
  for (const { text, url } of texts) {
    const phrase = PHRASES.find((p) => text.toLowerCase().includes(p.toLowerCase()));
    if (!phrase) continue;
    const quote = extractQuote(text, phrase);
    if (INTERNAL_WORK.test(quote)) return { quote: quote.slice(0, 400), url };
  }
  return null;
}

function buildBody(page) {
  return {
    page,
    filters: {
      company_headcount_range: ['101-200', '201-500', '501-1000'],
      company_industry: { include: INDUSTRIES },
      company_location_search: { include: [COUNTRY_NAME] },
      person_job_title: { include: [TITLE], match_mode: 'CONTAINS' },
      person_seniority: { include: ['Director', 'Manager', 'Head'] },
    },
  };
}

async function accountInfo() {
  const r = await fetch('https://api.prospeo.io/account-information', {
    method: 'POST', headers: { 'X-KEY': PROSPEO_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`account-information ${r.status} ${text.slice(0, 200)}`);
  return JSON.parse(text).response;
}

/** Thrown when the request should not be retried: real credit exhaustion, not a rate limit. */
class CreditsExhausted extends Error {}

/**
 * "Rate limit exceeded" is a separate condition from being out of credits, and needs a retry
 * with backoff rather than treating the page as failed. Measured 2026-09-13: consecutive
 * search-person calls a few hundred ms apart 429 on the second one, so this waits between
 * attempts rather than firing them back to back.
 */
async function searchPage(page) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch('https://api.prospeo.io/search-person', {
      method: 'POST', headers: { 'X-KEY': PROSPEO_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(buildBody(page)),
    });
    const text = await r.text();
    if ((r.status === 402 || r.status === 403 || r.status === 429) && /credit/i.test(text)) {
      throw new CreditsExhausted(`prospeo out of credits: HTTP ${r.status} ${text.slice(0, 200)}`);
    }
    if (r.status === 429) {
      const wait = 8000 * (attempt + 1);
      console.log(`  ! HTTP 429 rate limited, waiting ${wait}ms and retrying (attempt ${attempt + 1}/5)`);
      await new Promise((res) => setTimeout(res, wait));
      continue;
    }
    if (/NO_RESULTS/.test(text)) return { results: [], pagination: null };
    if (!r.ok) throw new Error(`search-person ${r.status} ${text.slice(0, 200)}`);
    const j = JSON.parse(text);
    return { results: j.results || [], pagination: j.pagination || null };
  }
  throw new Error('search-person: 5 consecutive rate-limit retries, giving up');
}

/** Turn one {person, company} result into a kept lead or a reject reason. Pure, no network. */
function toLead(rec, existingApex) {
  const p = rec.person || {}, c = rec.company || {};
  const name = c.name || '';
  if (!name) return { reject: 'no company name' };
  if (EXCLUDE_NAME.some((re) => re.test(name)) || EXCLUDE_LARGE.some((re) => re.test(name))) {
    return { reject: 'agency/training provider/public body/enterprise', name };
  }
  if (!c.domain) return { reject: 'no company domain', name };
  const apex = c.domain.toLowerCase().replace(/^www\./, '');
  if (existingApex.has(apex)) return { reject: 'domain already in cadre_leads', name, apex };

  const combined = `${c.industry || ''} ${name}`;
  const inferred = inferIndustry(combined);
  const industry = inferred !== 'other' ? inferred : (PROSPEO_INDUSTRY_FALLBACK[c.industry] || 'other');

  const pq = postingQuote(c.job_postings);
  const lead = {
    business_name: name,
    website: `https://${c.domain}`,
    city: cityOf(c.location),
    industry,
    source: 'prospeo',
    staff_estimate: c.employee_count || null,
    contact_name: p.full_name || null,
    contact_role: p.current_job_title || null,
    email: null,
    qualification_score: 8,
    signal_type: 'title',
    signal_url: pq && pq.url ? pq.url : p.linkedin_url,
    signal_date: STAMP,
    signal_quote: pq ? pq.quote : null,
    personalization_basis: pq ? 'published posting' : 'industry-template',
    notes: `prospeo: person_id ${p.person_id}, email ${(p.email && p.email.status) || 'UNKNOWN'}, company_id ${c.company_id}, industry ${c.industry || 'unknown'}, ${c.employee_count || '?'} staff`,
  };
  return { lead, apex, person: p };
}

async function loadExistingApex() {
  const apex = new Set();
  let from = 0;
  for (;;) {
    const { data, error } = await supabase.from('cadre_leads').select('website').range(from, from + 999);
    if (error) throw new Error(`loading existing cadre_leads websites: ${error.message}`);
    for (const row of data || []) { const a = apexOf(row.website); if (a) apex.add(a); }
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return apex;
}

(async () => {
  const rawOut = path.join(__dirname, 'batches', `prospeo-raw-${COUNTRY}-${STAMP}.json`);
  const leadsOut = path.join(__dirname, 'batches', `prospeo-${COUNTRY}-${STAMP}.json`);
  fs.mkdirSync(path.dirname(rawOut), { recursive: true });

  let pages;
  if (RAW) {
    pages = JSON.parse(fs.readFileSync(RAW, 'utf8'));
    console.log(`Replaying ${pages.length} saved page(s) from ${RAW}, no network.\n`);
  } else {
    const before = await accountInfo();
    console.log(`${DRY ? 'DRY RUN: ' : ''}Prospeo account before: ${before.remaining_credits} credit(s) remaining (${before.used_credits} used, plan ${before.current_plan}).`);
    if (before.remaining_credits <= FLOOR) {
      console.error(`Remaining credits (${before.remaining_credits}) already at or below --floor ${FLOOR}. Stopping before spending anything.`);
      process.exit(1);
    }

    pages = [];
    let spent = 0;
    for (let page = 1; page <= PAGES; page++) {
      if (spent >= BUDGET) { console.log(`Budget of ${BUDGET} credit(s) reached, stopping before page ${page}.`); break; }
      let res;
      try { res = await searchPage(page); }
      catch (e) { console.error(`page ${page} failed: ${e.message}`); break; }
      if (page === 1 && res.pagination) console.log(`pagination.total_count: ${res.pagination.total_count}`);
      console.log(`page ${page}: ${res.results.length} person(s)${res.results.length ? '' : ' (NO_RESULTS, free, stopping)'}`);
      pages.push({ page, pagination: res.pagination, results: res.results });
      fs.writeFileSync(rawOut, JSON.stringify(pages, null, 1));
      if (!res.results.length) break;
      spent++;

      const acc = await accountInfo();
      if (acc.remaining_credits < FLOOR) {
        console.error(`Remaining credits dropped to ${acc.remaining_credits}, below --floor ${FLOOR}. Stopping.`);
        break;
      }
      if (res.pagination && page >= res.pagination.total_page) { console.log('Reached the last page.'); break; }
      await new Promise((res2) => setTimeout(res2, 6000)); // pace pages, see searchPage's rate-limit note
    }
    console.log(`\n${spent} page(s) charged this run.`);
    const after = await accountInfo();
    console.log(`Prospeo account after: ${after.remaining_credits} credit(s) remaining (${after.used_credits} used).`);
  }

  const existingApex = await loadExistingApex();
  console.log(`\n${existingApex.size} existing cadre_leads website(s) loaded for dedup.\n`);

  const rejected = {};
  const byDomain = new Map();
  let peopleSeen = 0;
  for (const pg of pages) {
    for (const rec of pg.results || []) {
      peopleSeen++;
      const r = toLead(rec, existingApex);
      if (r.reject) { rejected[r.reject] = (rejected[r.reject] || 0) + 1; continue; }
      const existing = byDomain.get(r.apex);
      if (!existing) { byDomain.set(r.apex, r); continue; }
      const keep = better(existing, r);
      const drop = keep === existing ? r : existing;
      byDomain.set(r.apex, keep);
      rejected['duplicate company this run'] = (rejected['duplicate company this run'] || 0) + 1;
      void drop; // the loser is just not kept; nothing else to do with it
    }
  }

  const leads = [...byDomain.values()].map((r) => r.lead);
  let withQuote = 0;
  for (const lead of leads) {
    if (lead.signal_quote) withQuote++;
    console.log(`  ${String(lead.staff_estimate || '?').padStart(5)}  ${lead.business_name.slice(0, 34).padEnd(36)}${String(lead.city || '').slice(0, 18).padEnd(20)}${lead.industry.padEnd(14)}${lead.personalization_basis}`);
    if (lead.signal_quote) console.log(`        "${lead.signal_quote.slice(0, 110)}"`);
  }

  console.log(`\n${peopleSeen} person(s) seen, ${leads.length} lead(s) kept, ${withQuote} with a posting quote. Rejected: ${JSON.stringify(rejected)}`);

  fs.writeFileSync(leadsOut, JSON.stringify(leads, null, 2));
  console.log(`\nRaw pages: ${RAW || rawOut}`);
  console.log(`Leads file: ${leadsOut}`);

  if (!leads.length) return;

  const ingest = spawnSync(process.execPath, [path.join(__dirname, 'ingest.js'), leadsOut, ...(DRY ? ['--dry'] : [])], { stdio: 'inherit' });
  process.exitCode = ingest.status || 0;
})().catch((e) => {
  console.error('prospeo-finder failed:', e.message);
  process.exit(1);
});
