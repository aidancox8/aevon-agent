#!/usr/bin/env node
/**
 * cadre/linkedin-finder.js, the same signal search as lead-finder.js and crustdata-finder.js,
 * against LinkedIn's public guest job endpoints instead of SimplyHired or Crustdata.
 *
 * WHY THIS EXISTS. SimplyHired returns page one only and 403s every GitHub runner. Crustdata
 * indexes fewer postings than LinkedIn itself carries and costs money per row. LinkedIn's guest
 * search (jobs-guest/jobs/api/...) needs no login and no cookie, is reachable with a plain HTTPS
 * GET and a Chrome user agent, and is the single largest job corpus of the three. It is also
 * where lead-finder's own drafts.md ended up sending Aidan by hand (cadre/linkedin-route.md),
 * because the person who wrote the ad reads their LinkedIn inbox this week. This finder collects
 * the same signal at the discovery stage instead of by hand.
 *
 * HOW IT WORKS
 * 1. Search: jobs-guest/jobs/api/seeMoreJobPostings/search returns an HTML fragment of job
 *    cards (id, title, company, location, posted date), paged by &start=0,25,50... A page with
 *    zero cards, or start reaching 975, ends that phrase.
 * 2. Detail: jobs-guest/jobs/api/jobPosting/<id> returns the full description, the company's
 *    LinkedIn URL, the posting location, and the "criteria" block (seniority, employment type,
 *    job function, industry). The search snippet never carries the phrase; only the full
 *    description is trustworthy, same lesson lead-finder.js already learned from the UK site.
 * 3. Company: the company's own guest page carries a staff-count band, its website and
 *    headquarters in a fixed about-section, cached per slug so a company with five open roles
 *    is one fetch, not five.
 *
 * Filtering is the SAME rules as lead-finder.js and crustdata-finder.js (agencies, training
 * providers and enterprises out by name; applicant-facing quotes out; an employer-side verb
 * required), imported rather than reimplemented, then handed to ingest.js, which dedupes by
 * company name against what is already in cadre_leads.
 *
 * Two files are written per run, both under cadre/batches/, both appended to incrementally so a
 * crash loses nothing:
 *   linkedin-raw-<country>-<date>.json     every posting whose detail page was fetched, with the
 *                                           full description and company data attached, so
 *                                           --raw <file> --dry can replay the filters with no
 *                                           network call at all, the same escape hatch
 *                                           crustdata-finder.js gives a filter change.
 *   linkedin-<country>-<date>.json         the kept leads, handed to ingest.js at the end.
 *
 *   node cadre/linkedin-finder.js --country ca --limit 60 --dry
 *   node cadre/linkedin-finder.js --country us --limit 1500
 *   node cadre/linkedin-finder.js --raw cadre/batches/linkedin-raw-ca-2026-09-11.json --dry
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
const { spawnSync } = require('child_process');
const { PHRASES, APPLICANT_FACING, INTERNAL_WORK, EXCLUDE_NAME, EXCLUDE_LARGE, extractQuote, inferIndustry } = require('./lead-finder');

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : dflt; };
const DRY = process.argv.includes('--dry');
const RAW = arg('raw', null);
const COUNTRY = arg('country', 'ca');
const LOCATION = { ca: 'Canada', us: 'United States', uk: 'United Kingdom' }[COUNTRY];
const DAYS = parseInt(arg('days', '30'), 10);
const LIMIT = parseInt(arg('limit', '400'), 10);
const PHRASE_LIMIT = parseInt(arg('phrases', String(PHRASES.length)), 10);
const STAMP = new Date().toISOString().slice(0, 10);

if (!LOCATION) { console.error('--country must be one of ca, us, uk'); process.exit(1); }

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9',
  'Accept-Language': 'en-US,en;q=0.9',
};
const GAP_MS = 2500;
const BLOCK_SLEEP_MS = 10 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Industries excluded outright: agencies and public/education bodies cannot buy from a solo
 * vendor and are not the customer. Non-profit Organization Management is deliberately NOT on
 * this list, it is a normal customer, same as lead-finder.js treats it (a nonprofit runs a real
 * workforce with real credentials, it is only the government and education bodies that cannot
 * buy).
 */
const EXCLUDE_INDUSTRY = ['staffing and recruiting', 'government administration', 'higher education',
  'primary and secondary education', 'armed forces'];

/** Full province/state names, as LinkedIn writes them, to the abbreviation the lead record wants. */
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

/** 'City, Province, Country' or 'City, State, Country' becomes 'City, PROV' / 'City, ST'. Anything else is kept as is. */
function cityOf(raw) {
  if (!raw) return null;
  const parts = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const region = parts[1].toLowerCase();
    const abbr = PROVINCE_ABBR[region] || STATE_ABBR[region];
    if (abbr) return `${parts[0]}, ${abbr}`;
  }
  return raw;
}

/** Band text midpoints, per the brief. Unknown or unparsed bands stay null, not a guess. */
const BAND_MIDPOINT = {
  '11-50': 30, '51-200': 125, '201-500': 350, '501-1000': 750,
  '1001-5000': 3000, '5001-10000': 7500, '10001+': 20000,
};
function staffFromBand(bandRaw) {
  if (!bandRaw) return null;
  const key = String(bandRaw).replace(/employees?/i, '').replace(/,/g, '').replace(/\s+/g, '').trim();
  return Object.prototype.hasOwnProperty.call(BAND_MIDPOINT, key) ? BAND_MIDPOINT[key] : null;
}

/** The website text on the company page is the plain domain already, not the redirect href it sits inside. */
function rootDomain(raw) {
  if (!raw) return null;
  let u = String(raw).trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  try { return new URL(u).origin; } catch { return null; }
}

function companySlug(href) {
  try { const m = new URL(href).pathname.match(/\/company\/([^/]+)/); return m ? m[1] : null; }
  catch { return null; }
}

/**
 * Bulleted ads flatten to one long "sentence" with no full stops, and extractQuote then returns
 * the whole ad. Same fix crustdata-finder.js uses for the same corpus shape: cut a window around
 * the phrase on word boundaries instead.
 */
function tightQuote(text, phrase) {
  const q = extractQuote(text, phrase);
  if (q.length <= 220) return q;
  const i = q.toLowerCase().indexOf(phrase.toLowerCase());
  const start = Math.max(0, q.lastIndexOf(' ', Math.max(0, i - 90)) + 1);
  const end = Math.min(q.length, (q.indexOf(' ', i + phrase.length + 90) + 1 || q.length + 1) - 1);
  return q.slice(start, end).trim();
}

/** The same employer-side test lead-finder.js and crustdata-finder.js apply, imported not reinvented. */
function rejectReason(name, quote) {
  if (EXCLUDE_NAME.some((re) => re.test(name))) return 'agency/training provider/public body';
  if (EXCLUDE_LARGE.some((re) => re.test(name))) return 'enterprise';
  if (APPLICANT_FACING.some((re) => re.test(quote))) return 'applicant-facing';
  if (!INTERNAL_WORK.test(quote)) return 'no employer-side verb';
  return null;
}

const norm = (n) => String(n).toLowerCase().replace(/[.,()]/g, ' ')
  .replace(/\b(inc|ltd|limited|corp|corporation|co|company|society|group|holdings|llc|lp)\b/g, ' ')
  .replace(/\s+/g, ' ').trim();

/**
 * HTTP with the pacing and blocking rules the brief sets: 2.5s between requests, and on 429 or
 * 999 (LinkedIn's own bot-block status) sleep 10 minutes and retry the SAME request rather than
 * treating it as a real answer. Three such sleeps in a row without a clean response between them
 * means the IP is blocked, not throttled, and continuing would burn ten minutes at a time for
 * nothing.
 */
let consecutiveBlocks = 0;
async function getWithRetry(url) {
  for (;;) {
    const res = await axios.get(url, { headers: HEADERS, timeout: 25000, validateStatus: () => true, maxRedirects: 5 });
    if (res.status === 429 || res.status === 999) {
      consecutiveBlocks++;
      console.log(`  ! HTTP ${res.status}, sleeping 10 minutes (consecutive block ${consecutiveBlocks}/3): ${url}`);
      if (consecutiveBlocks >= 3) throw new Error(`STOP: 3 consecutive HTTP ${res.status} blocks. This IP is being rate-limited or blocked by LinkedIn.`);
      await sleep(BLOCK_SLEEP_MS);
      continue;
    }
    consecutiveBlocks = 0;
    await sleep(GAP_MS);
    return res;
  }
}

async function searchPage(phrase, start) {
  const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(`"${phrase}"`)}&location=${encodeURIComponent(LOCATION)}&f_TPR=r${DAYS * 86400}&start=${start}`;
  let res;
  try { res = await getWithRetry(url); }
  catch (e) { console.log(`  ! search failed, "${phrase}" start=${start}: ${e.message}`); throw e; }
  if (res.status !== 200) { console.log(`  ! search HTTP ${res.status}, "${phrase}" start=${start}`); return []; }
  const $ = cheerio.load(res.data);
  const cards = [];
  $('[data-entity-urn]').each((_, el) => {
    const $el = $(el);
    const m = String($el.attr('data-entity-urn') || '').match(/jobPosting:(\d+)/);
    if (!m) return;
    cards.push({
      id: m[1],
      title: $el.find('h3.base-search-card__title').first().text().replace(/\s+/g, ' ').trim(),
      company: $el.find('h4.base-search-card__subtitle a').first().text().replace(/\s+/g, ' ').trim(),
      location: $el.find('span.job-search-card__location').first().text().replace(/\s+/g, ' ').trim(),
      postedDate: $el.find('time.job-search-card__listdate').first().attr('datetime') || null,
    });
  });
  return cards;
}

async function jobDetail(id) {
  const url = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`;
  const res = await getWithRetry(url);
  if (res.status !== 200) return null;
  const $ = cheerio.load(res.data);
  const descHtml = $('div.show-more-less-html__markup').first().html() || '';
  const description = descHtml.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!description) return null;
  const orgLink = $('a.topcard__org-name-link').first();
  const criteria = {};
  $('li.description__job-criteria-item').each((_, li) => {
    const key = $(li).find('h3.description__job-criteria-subheader').first().text().replace(/\s+/g, ' ').trim().toLowerCase();
    const val = $(li).find('span.description__job-criteria-text').first().text().replace(/\s+/g, ' ').trim();
    if (key) criteria[key] = val;
  });
  return {
    description,
    companyName: orgLink.text().replace(/\s+/g, ' ').trim(),
    companyHref: orgLink.attr('href') || null,
    location: $('span.topcard__flavor--bullet').first().text().replace(/\s+/g, ' ').trim(),
    criteria,
  };
}

async function companyPage(url) {
  const res = await getWithRetry(url);
  if (res.status !== 200) return null;
  const $ = cheerio.load(res.data);
  return {
    bandRaw: $('[data-test-id="about-us__size"] dd').first().text().replace(/\s+/g, ' ').trim() || null,
    websiteRaw: $('[data-test-id="about-us__website"] dd a').first().text().replace(/\s+/g, ' ').trim() || null,
    headquarters: $('[data-test-id="about-us__headquarters"] dd').first().text().replace(/\s+/g, ' ').trim() || null,
  };
}

/**
 * Turn one raw record (fetched live, or reloaded from --raw) into a kept lead or a reject
 * reason. Pure and offline: everything it needs, including the company page fields, is already
 * on the record, which is what makes --raw --dry replayable without the network.
 */
function toLead(rec) {
  const name = rec.companyName || rec.cardCompany || '';
  if (!name) return { reject: 'no company name' };
  if (EXCLUDE_NAME.some((re) => re.test(name)) || EXCLUDE_LARGE.some((re) => re.test(name))) {
    return { reject: 'agency/training provider/public body/enterprise', name };
  }
  const criteriaIndustry = (rec.criteria && (rec.criteria.industries || rec.criteria.industry)) || '';
  if (criteriaIndustry && EXCLUDE_INDUSTRY.includes(criteriaIndustry.toLowerCase())) {
    return { reject: `excluded industry (${criteriaIndustry})`, name };
  }
  const text = rec.description || '';
  // LinkedIn's search is semantic: a query for "training matrix" returns postings that say
  // "maintain training records" and never the searched words. The quote only has to be one of
  // the campaign's phrases in their own words, not the one that happened to be searched. On the
  // first Canada run (2026-09-11) the searched-phrase rule rejected 316 of 400.
  const lower = text.toLowerCase();
  const phrase = [rec.phrase, ...PHRASES].find((ph) => lower.includes(ph.toLowerCase()));
  if (!phrase) return { reject: 'no campaign phrase in description', name };
  const quote = tightQuote(text, phrase);
  if (quote.length < 25) return { reject: 'quote too short', name };
  const reject = rejectReason(name, quote);
  if (reject) return { reject, name, quote };

  const comp = rec.companyPage || {};
  const staffEstimate = staffFromBand(comp.bandRaw);
  const bandLabel = comp.bandRaw ? comp.bandRaw.replace(/\s*employees?\s*$/i, '').trim() : 'unknown';
  const lead = {
    business_name: name,
    website: rootDomain(comp.websiteRaw),
    city: cityOf(rec.location || rec.cardLocation),
    industry: inferIndustry(`${rec.title || ''} ${name} ${criteriaIndustry} ${quote}`),
    source: 'linkedin',
    signal_type: /matrix|spreadsheet|binder|by hand|manual/i.test(quote) ? 'manual_tracking' : 'hiring_credentialing',
    signal_quote: quote.slice(0, 400),
    signal_url: `https://www.linkedin.com/jobs/view/${rec.id}`,
    signal_date: rec.postedDate ? String(rec.postedDate).slice(0, 10) : new Date().toISOString().slice(0, 10),
    staff_estimate: staffEstimate,
    notes: `linkedin: ${bandLabel} employees; industry ${criteriaIndustry || 'unspecified'}`,
  };
  return { lead, band: bandLabel };
}

(async () => {
  const rawOut = path.join(__dirname, 'batches', `linkedin-raw-${COUNTRY}-${STAMP}.json`);
  const leadsOut = path.join(__dirname, 'batches', `linkedin-${COUNTRY}-${STAMP}.json`);
  fs.mkdirSync(path.dirname(rawOut), { recursive: true });

  const rejected = {};
  const kept = [];
  const seenCompanies = new Set();
  const debugSamples = [];
  const writeRaw = (records) => { try { fs.writeFileSync(rawOut, JSON.stringify(records, null, 1)); } catch (e) { console.error(`  raw checkpoint failed: ${e.message}`); } };
  const writeLeads = () => { try { fs.writeFileSync(leadsOut, JSON.stringify(kept, null, 2)); } catch (e) { console.error(`  leads checkpoint failed: ${e.message}`); } };

  const applyRecord = (rec) => {
    const r = toLead(rec);
    if (debugSamples.length < 2 && rec.description) {
      debugSamples.push({
        title: rec.title, company: rec.companyName || rec.cardCompany,
        descriptionSample: (rec.description || '').slice(0, 300),
        phraseFound: (rec.description || '').toLowerCase().includes(rec.phrase.toLowerCase()),
        quote: extractQuote(rec.description || '', rec.phrase),
      });
    }
    if (r.reject) { rejected[r.reject] = (rejected[r.reject] || 0) + 1; return; }
    const key = norm(r.lead.business_name);
    if (seenCompanies.has(key)) { rejected['duplicate company this run'] = (rejected['duplicate company this run'] || 0) + 1; return; }
    seenCompanies.add(key);
    kept.push(r.lead);
    console.log(`  ${String(r.lead.staff_estimate || '?').padStart(5)}  [${r.band}]  ${r.lead.business_name.slice(0, 34).padEnd(36)}${String(r.lead.city || '').slice(0, 18).padEnd(20)}${r.lead.industry}`);
    console.log(`        "${r.lead.signal_quote.slice(0, 110)}"`);
    writeLeads();
  };

  if (RAW) {
    const records = JSON.parse(fs.readFileSync(RAW, 'utf8'));
    console.log(`Replaying ${records.length} saved posting(s) from ${RAW}, no network.\n`);
    for (const rec of records) applyRecord(rec);
  } else {
    console.log(`${DRY ? 'DRY RUN. ' : ''}LinkedIn guest search: ${LOCATION}, last ${DAYS} days, examining up to ${LIMIT} posting(s).\n`);
    const companyCache = new Map();
    const rawRecords = [];
    const seenJobIds = new Set();
    let examined = 0;
    let cardsSeenTotal = 0;
    let queriesTried = 0;
    let stoppedEarly = null;

    const phrases = PHRASES.slice(0, PHRASE_LIMIT);
    outer:
    for (const phrase of phrases) {
      for (let start = 0; start <= 975; start += 25) {
        if (examined >= LIMIT) break outer;
        queriesTried++;
        let cards;
        try { cards = await searchPage(phrase, start); }
        catch (e) { stoppedEarly = e.message; break outer; }
        if (!cards.length) break;
        cardsSeenTotal += cards.length;

        for (const card of cards) {
          if (examined >= LIMIT) break outer;
          if (seenJobIds.has(card.id)) continue;
          seenJobIds.add(card.id);

          // Cheap screen on the search-card company name, before spending a detail fetch.
          if (EXCLUDE_NAME.some((re) => re.test(card.company)) || EXCLUDE_LARGE.some((re) => re.test(card.company))) {
            rejected['agency/training provider/public body/enterprise'] = (rejected['agency/training provider/public body/enterprise'] || 0) + 1;
            examined++;
            continue;
          }

          examined++;
          let detail;
          try { detail = await jobDetail(card.id); }
          catch (e) { stoppedEarly = e.message; break outer; }
          if (!detail) { rejected['detail fetch failed or no description'] = (rejected['detail fetch failed or no description'] || 0) + 1; continue; }

          const name = detail.companyName || card.company;
          let companyPageData = null;
          // Only spend the company-page fetch on postings that survive name, industry, phrase
          // and quote filtering, so an excluded or applicant-facing posting never costs a fetch.
          const preCheckName = EXCLUDE_NAME.some((re) => re.test(name)) || EXCLUDE_LARGE.some((re) => re.test(name));
          const criteriaIndustry = detail.criteria.industries || detail.criteria.industry || '';
          const preCheckIndustry = criteriaIndustry && EXCLUDE_INDUSTRY.includes(criteriaIndustry.toLowerCase());
          const text = detail.description;
          const phraseFound = text.toLowerCase().includes(phrase.toLowerCase());
          const quote = phraseFound ? tightQuote(text, phrase) : '';
          const employerReject = phraseFound ? rejectReason(name, quote) : null;
          const willKeep = !preCheckName && !preCheckIndustry && phraseFound && quote.length >= 25 && !employerReject;

          if (willKeep) {
            const slug = companySlug(detail.companyHref);
            if (slug && companyCache.has(slug)) {
              companyPageData = companyCache.get(slug);
            } else {
              const url = slug ? `https://www.linkedin.com/company/${slug}` : null;
              try { companyPageData = url ? await companyPage(url) : null; }
              catch (e) { stoppedEarly = e.message; break outer; }
              if (slug) companyCache.set(slug, companyPageData);
            }
          }

          const rec = {
            id: card.id, phrase, title: card.title || detail.companyName,
            cardCompany: card.company, cardLocation: card.location, postedDate: card.postedDate,
            companyName: detail.companyName, companyHref: detail.companyHref,
            location: detail.location, criteria: detail.criteria, description: detail.description,
            companyPage: companyPageData,
          };
          rawRecords.push(rec);
          writeRaw(rawRecords);
          applyRecord(rec);
        }
        console.log(`  ${String(cardsSeenTotal).padStart(5)} card(s) so far  "${phrase}" start=${start}`);
      }
    }

    console.log(`\n${queriesTried} search page(s) fetched, ${cardsSeenTotal} card(s) seen, ${examined} posting(s) examined.`);
    if (stoppedEarly) console.error(`\nSTOPPED EARLY: ${stoppedEarly}`);

    // A search that returns zero cards on every query is not the same fact as "nothing matched
    // the filters", and reporting it the same way is exactly the failure mode this brief warns
    // about. Say so explicitly rather than letting it read as a clean, boring zero.
    if (queriesTried > 0 && cardsSeenTotal === 0) {
      console.error(`\nEVERY search query returned 0 cards. This is very likely the endpoint or the selector, not the market: check li.html against the live response before trusting this as "no postings".`);
    }
  }

  console.log(`\n${kept.length} lead(s) kept. Rejected: ${JSON.stringify(rejected)}`);

  if (!kept.length) {
    console.log('\n0 kept. Two examined postings, to prove the pipeline actually looked rather than found nothing to look at:');
    if (!debugSamples.length) console.log('  (no posting reached the description-fetch stage at all, which points at the search endpoint or selectors, not the phrase filters)');
    for (const d of debugSamples) {
      console.log(`\n  title: ${d.title}\n  company: ${d.company}\n  description[0:300]: ${d.descriptionSample}\n  phrase found: ${d.phraseFound}\n  extractQuote: ${d.quote}`);
    }
  }

  writeLeads();
  console.log(`\nRaw posting data: ${fs.existsSync(rawOut) ? rawOut : '(none written, --raw replay only reads, does not rewrite it)'}`);
  console.log(`Leads file: ${leadsOut}`);

  if (!kept.length) return;

  const ingest = spawnSync(process.execPath, [path.join(__dirname, 'ingest.js'), leadsOut, ...(DRY ? ['--dry'] : [])], { stdio: 'inherit' });
  process.exitCode = ingest.status || 0;
})().catch((e) => {
  console.error('linkedin-finder failed:', e.message);
  process.exit(1);
});
