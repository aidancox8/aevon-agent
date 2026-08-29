#!/usr/bin/env node
/**
 * cadre/lead-finder.js — find companies that have published the problem, unattended.
 *
 * The other two campaigns' finders query Google Places for a business type and then assume the
 * pain. Between them that produced 3,808 sends and zero meetings. This one only accepts a
 * company that has written the problem down itself, in a job ad, in its own words.
 *
 * HOW IT WORKS
 * SimplyHired.ca embeds its results as JSON in __NEXT_DATA__, including the employer, the
 * location and a snippet containing the matched phrase. That snippet becomes the signal quote,
 * so the personalizer can quote them verbatim rather than paraphrase.
 *
 * THREE THINGS THAT COST TIME TO LEARN, WRITTEN DOWN SO THEY ARE NOT RELEARNED
 *
 * 1. SimplyHired returns 403 unless the Accept header asks for HTML. Axios defaults to
 *    application/json and gets refused. Indeed 403s regardless, which is why it is not used here
 *    even though it has more inventory.
 * 2. Pagination does not work. `pn`, `cursor` and `start` were all tested and all return page
 *    one. Breadth comes from many phrases across many locations, 20 results each, not from
 *    paging one query.
 * 3. "training matrix" is by far the highest-yield phrase. It is an artifact with a name inside
 *    these companies and someone is paid to keep it current.
 *
 * WHERE THIS FINDS NOTHING, AND WHY
 * Healthcare and property management. In both, the individual holds their own licence, so
 * employers publish it as a requirement ON THE APPLICANT rather than as internal work. Two
 * separate sweeps confirmed it. The signal only exists where the EMPLOYER is accountable for the
 * workforce's tickets.
 *
 *   node cadre/lead-finder.js --dry
 *   node cadre/lead-finder.js --phrases 4 --locations 3
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const axios = require('axios');
const fs = require('fs');
const supabase = require('../lib/supabase');
const { excludedOrgReason } = require('../tempo/dnc');

const TABLE = 'cadre_leads';
const DRY = process.argv.includes('--dry');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? parseInt(process.argv[i + 1], 10) : fallback;
};
const MAX_PHRASES = arg('phrases', 99);
const MAX_LOCATIONS = arg('locations', 99);
const GAP_MS = 4000;
/** Individual postings to open per query when the snippet omits the phrase. */
const DEEP_PER_QUERY = 6;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  // Required. Without an HTML Accept header SimplyHired answers 403.
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9',
  'Accept-Language': 'en-CA,en;q=0.9',
};

/**
 * Ordered by yield. The first is worth more than the rest combined.
 *
 * SPELLING MATTERS AND IS NOT SYMMETRIC. British and Canadian job ads write "licence" for the
 * noun; American ads write "license" for both noun and verb. A search for one spelling silently
 * misses the other country's postings entirely, which is a whole market lost to a single letter.
 * "Programme" and "organisation" split the same way. Neutral phrases like "training matrix" and
 * "certification records" need no variant, which is part of why they travel so well.
 */
const PHRASES = [
  'training matrix',
  'certification tracking',
  'certification expiry',
  'maintain training records',
  'employee certifications',
  'certification records',
  'recertification',
  'competency matrix',
  'driver qualification files',
  'track certifications',
  'certifications are up to date',
  'training compliance',
  // Spelling variants. Each finds postings the other cannot see.
  'licence renewals',      // UK, IE, CA
  'license renewals',      // US
  'licence expiry',        // UK, IE, CA
  'license expiry',        // US
  'training programme',    // UK, IE
];

/**
 * Where to search, and on which site.
 *
 * SimplyHired runs a separate site per country, each with identical __NEXT_DATA__ structure, so
 * a new country is a config entry rather than a new parser. The country sites are separate
 * corpora: a UK employer is not reachable by adding "London" to the .ca site.
 *
 * MEASURED SIGNAL VOLUME, 2026-08-24, across four phrases ("training matrix", "certification
 * expiry", "maintain training records", "competency matrix"):
 *
 *   US   1,305      6x Canada
 *   UK     272      bigger than Canada from a smaller economy, because "training matrix" is
 *                   standard British H&S vocabulary
 *   CA     209
 *   AU      45      understated: SEEK dominates there and blocks us
 *   IE      44
 *   NZ       0      site returned nothing usable
 *
 * WHY EACH COUNTRY FITS
 * UK: CSCS cards expire every 5 years, SIA security licences expire, Gas Safe renews annually,
 *     DBS checks for anyone working near children. reed.co.uk is a second fetchable corpus.
 * AU: the cleanest regulatory fit anywhere. High Risk Work Licences for forklift, crane and EWP
 *     expire on a fixed cycle, plus White Card and state Working with Children Checks.
 * IE: Safe Pass cards expire every 4 years. Small, but free to include once UK is configured.
 *
 * THE HONEST CAVEAT: the only reference available is a BC one, and it travels worse the further
 * from BC the reader is. Volume is not the same as fit.
 */
const REGIONS = {
  ca: {
    host: 'https://www.simplyhired.ca',
    places: ['ontario', 'british columbia', 'alberta', 'quebec', 'manitoba', 'saskatchewan',
      'nova scotia', 'new brunswick', 'newfoundland and labrador', 'prince edward island',
      'canada'],
  },
  us: {
    host: 'https://www.simplyhired.com',
    places: ['washington', 'oregon', 'idaho', 'montana', 'utah', 'colorado', 'arizona', 'nevada',
      'texas', 'ohio', 'pennsylvania', 'illinois', 'indiana', 'michigan', 'wisconsin',
      'minnesota', 'missouri', 'tennessee', 'georgia', 'north carolina', 'alabama', 'louisiana',
      'oklahoma', 'kansas', 'iowa', 'california', 'florida', 'new york'],
  },
  uk: {
    host: 'https://www.simplyhired.co.uk',
    places: ['england', 'scotland', 'wales', 'northern ireland', 'london', 'manchester',
      'birmingham', 'leeds', 'glasgow', 'bristol', 'united kingdom'],
  },
  ie: { host: 'https://www.simplyhired.ie', places: ['dublin', 'cork', 'galway', 'ireland'] },
  au: {
    host: 'https://www.simplyhired.com.au',
    places: ['new south wales', 'victoria', 'queensland', 'western australia', 'south australia',
      'australia'],
  },
};
const REGION = (() => {
  const i = process.argv.indexOf('--region');
  const r = i > -1 ? process.argv[i + 1] : 'core';  // CA + US + UK by default
  const valid = [...Object.keys(REGIONS), 'core', 'all'];
  if (!valid.includes(r)) throw new Error(`--region must be one of ${valid.join(', ')}`);
  return r;
})();
const REGION_SET = REGION === 'all' ? Object.keys(REGIONS)
  : REGION === 'core' ? ['ca', 'us', 'uk']
  : [REGION];
const TARGETS = REGION_SET
  .flatMap(k => REGIONS[k].places.map(p => ({ host: REGIONS[k].host, place: p, region: k })));

/** Companies whose OWN BUSINESS is selling this, or who cannot buy. */
const EXCLUDE_NAME = [
  /\b(staffing|recruit|personnel|talent|placement|manpower|adecco|randstad|robert half|hays)\b/i,
  /\b(job shoppe|labour ?ready|employment (services|solutions)|workforce solutions|temp agency)\b/i,
  /\b(safety (training|consult)|training (solutions|institute|academy|centre|center)|college|university|polytechnic|school district|school board)\b/i,
  /\b(certification|certifying|registrar|accreditation)\b.*\b(body|services|inc|ltd)\b/i,
  /\b(bureau veritas|sgs|intertek|acuren|levitt-safety|labtest|skilledtrades|worksafe)\b/i,
  /\b(city of|town of|region of|province|government|ministry|health authority|hospital|first nation)\b/i,
];
/** Too large to buy from a solo vendor, or HR is decided at a parent. */
const EXCLUDE_LARGE = [
  /\b(ledcor|pcl|graham|ellisdon|aecon|bird construction|kiewit|stantec|wsp|snc)\b/i,
  /\b(loblaw|sobeys|walmart|costco|amazon|maple leaf|agropur|saputo|cargill|nutrien)\b/i,
  /\b(cn rail|cp rail|canada post|purolator|fedex|ups|day &? ross)\b/i,
  /\b(magna|linamar|bombardier|cae|pratt &? whitney|honeywell|siemens|ge |abb)\b/i,
  /\b(cementation|ainsworth|give and go|shoppers|wellwise|titanium logistics|first student)\b/i,
  /\b(schaeffler|thales|dometic|winpak|menasha|rexel|orica|chep|cencora|clean harbors)\b/i,
  /\b(iamgold|alamos|hydro one|securiguard|paladin|securitas|gardaworld|commissionaires)\b/i,
  /\b(eclipse automation|accenture|deloitte|kpmg|cgi |bayshore|lifemark|cbi health|extendicare|revera|chartwell)\b/i,
  // Added after a US sweep tried to insert Tesla, Owens Corning and Ravago Americas.
  /\b(tesla|owens corning|ravago|id logistics|amazon|google|microsoft|apple|meta|boeing|lockheed|raytheon|northrop)\b/i,
  /\b(pepsi|coca.?cola|nestle|unilever|kraft|tyson|jbs |smithfield|conagra|general mills|kellogg)\b/i,
  /\b(3m\b|dupont|dow |basf|bayer|pfizer|merck|johnson &? johnson|ge |caterpillar|deere|cummins)\b/i,
  /\b(fedex|ups\b|xpo|schneider national|werner|swift transportation|knight-swift|jb hunt|ryder)\b/i,
  /\b(de havilland|andrew peller|richelieu|quincaillerie|viterra|parrish|federated co-?op)\b/i,
];

/**
 * Excluded verticals, deliberately SHORT.
 *
 * An earlier version excluded healthcare and property management outright, on the grounds that
 * two sweeps found almost nothing there. That was the wrong fix. What those sweeps actually
 * found is that those employers publish credentials as a requirement ON THE APPLICANT rather
 * than as internal work, and APPLICANT_FACING below tests for that directly. Excluding the
 * industry instead of the pattern threw away real leads: PhysioCare At Home is a genuine
 * multi-province lead whose posting reads "Track professional registrations, licenses,
 * insurance renewals", and a name filter on "physiotherapy" would have dropped it.
 *
 * Healthcare is also where the only honest reference is, so it is the last vertical to exclude.
 *
 * What is left here is only what has no expiring workforce credential behind it at all.
 */
const EXCLUDE_VERTICAL = [
  /\b(boutique|gift shop|thrift|e-?commerce|dropship)\b/i,
];

/**
 * Classify the posting. Deliberately broad.
 *
 * An earlier version had eight buckets and defaulted everything it did not recognise to
 * manufacturing, which is how an airline maintenance shop and a recreation centre both ended up
 * filed as factories. Any organisation whose staff hold something that expires belongs here, and
 * that is far more industries than the original list allowed.
 *
 * HEALTHCARE IS FIRST, not excluded. It is the only vertical with a live reference behind it,
 * because that is where the software actually runs today.
 */
function inferIndustry(text) {
  const t = text.toLowerCase();
  if (/\b(clinic|physiotherap|chiropract|massage therap|dental|denture|optometr|audiolog|pharmac|nurs|rn |lpn |care home|long.?term care|home care|assisted living|hospice|paramedic|medical|health centre|health center|veterinar|lab technolog|diagnostic|imaging|midwif|podiatr|naturopath|acupunctur|occupational therap|speech.?language)\b/.test(t)) return 'health';
  if (/\b(childcare|daycare|early learning|ece\b|preschool|youth|foster|group home|residential care|social services|community living|caregiver|family services|shelter|outreach)\b/.test(t)) return 'childcare';
  if (/\b(driver|fleet|trucking|transport|logistics|carrier|dispatch|dq file|courier|bus |transit|marine|shipping|rail|aviation|aircraft|airline|amo\b|ground handling)\b/.test(t)) return 'transport';
  if (/\b(guard|security|patrol|alarm|loss prevention|corrections)\b/.test(t)) return 'security';
  if (/\b(food|bakery|dairy|meat|produce|processing|haccp|foodsafe|brewery|winery|seafood|grocer|catering|kitchen|restaurant)\b/.test(t)) return 'food';
  if (/\b(laborator|lab tech|assay|geotech|materials testing|quality control lab|tissue culture|cannabis)\b/.test(t)) return 'lab';
  if (/\b(school|teacher|educator|training centre|college|campus|tutor|instructor)\b/.test(t)) return 'education';
  if (/\b(utilit|hydro|power|electric distribution|water treatment|wastewater|telecom|fibre|fiber|isp\b|tower)\b/.test(t)) return 'utilities';
  if (/\b(farm|agricultur|agronom|grain|crop|livestock|greenhouse|orchard|forestry|logging|silvicultur|fish)\b/.test(t)) return 'agriculture';
  if (/\b(recreation|arena|pool|lifeguard|fitness|community centre|sport|camp|park)\b/.test(t)) return 'recreation';
  if (/\b(hotel|resort|hospitality|casino|venue|event)\b/.test(t)) return 'hospitality';
  if (/\b(waste|recycl|environmental|remediation|abatement|hazmat|spill)\b/.test(t)) return 'environmental';
  if (/\b(facilit|janitorial|custodial|cleaning|building operat|property maintenance|caretaker)\b/.test(t)) return 'facilities';
  if (/\b(construct|contractor|electrical|plumb|mechanical|roofing|excavat|weld|scaffold|crane|hvac|pipeline|drilling|oilfield|mining|paving|concrete|framing|glazing|insulation|sheet metal|millwright|rigging)\b/.test(t)) return 'trades';
  if (/\b(manufactur|plant|fabricat|machining|assembly|production|mill|foundry|extrusion|packaging|printing|textile|furniture|cabinet)\b/.test(t)) return 'manufacturing';
  if (/\b(warehous|distribution|supply chain|inventory|forklift)\b/.test(t)) return 'warehousing';
  return 'other';
}

/**
 * THE MOST IMPORTANT FILTER. Reject quotes that are a requirement ON THE APPLICANT.
 *
 * This is the same distinction that makes healthcare and property management dead verticals:
 * "Valid forklift licence is an asset" is the candidate being asked to hold a ticket, not the
 * employer describing work that someone does. The first sweep let through United Roofing
 * ("Safety tickets ... Recertification can/will be") and The Job Shoppe ("recertification
 * support may be available for qualified candidates"). Both are job perks, not a tracking
 * burden, and an email quoting one back would read as though we had not understood the posting.
 */
const APPLICANT_FACING = [
  /\b(is an asset|are an asset|would be an asset|is preferred|are preferred|is required|are required)\b/i,
  /\b(must (have|hold|possess)|should (have|hold|possess))\b/i,
  /\bvalid .{0,30}(licen[cs]e|ticket|certificat)/i,
  /\b(candidates?|applicants?|the ideal candidate|you will (have|bring))\b/i,
  /\b(ability to (provide|obtain)|willing to obtain)\b/i,
  /\b(recertification (support|assistance|can|will|may)|reimburse)\b/i,
];

/** Employer-side verbs. The quote must describe work being done, not a qualification held. */
const INTERNAL_WORK = /\b(maintain(s|ing)?|track(s|ing)?|monitor(s|ing)?|updat(e|es|ing)|coordinat(e|es|ing)|manag(e|es|ing)|administer|schedul(e|es|ing)|audit(s|ing)?|filing|record ?keeping|keep(s|ing)?|ensur(e|es|ing)|oversee|overseeing|own(s|ing)?|review(s|ing)?|complet(e|es|ing)|verif(y|ies|ying)|log(s|ging)?)\b/i;

/**
 * Build a usable link to the posting.
 *
 * job.encodedUrl is PERCENT-ENCODED, so concatenating it onto the host produced
 * "https://www.simplyhired.ca%2Fjob%2F..." which is not a URL. Every lead inserted before
 * 2026-08-24 carries one of those and needs repairing. job.botUrl is the clean path.
 */
function jobUrl(target, job, phrase) {
  const pathPart = job.botUrl || (job.encodedUrl ? decodeURIComponent(job.encodedUrl).split('?')[0] : null);
  if (pathPart) return `${target.host}${pathPart}`;
  return `${target.host}/search?q=${encodeURIComponent(`"${phrase}"`)}&l=${encodeURIComponent(target.place)}`;
}

/**
 * Fetch the full posting and pull the sentence containing the phrase.
 *
 * Needed because the UK site's search snippets do not contain the matched phrase at all: a query
 * for "training matrix" in England returns 142 results and not one snippet carries the words.
 * Without this the entire UK, the second largest pool measured, yields zero.
 *
 * Rate-limited and capped per query, because this is one request per candidate rather than one
 * per twenty.
 */
async function deepQuote(target, job, phrase) {
  const url = jobUrl(target, job, phrase);
  if (!/\/job\//.test(url)) return null;
  try {
    const res = await axios.get(url, { headers: HEADERS, timeout: 25000 });
    const m = String(res.data).match(/id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return null;
    const jp = JSON.parse(m[1]).props.pageProps;
    const html = (jp.viewJobData && jp.viewJobData.job && jp.viewJobData.job.jobDescriptionHtml) || '';
    const text = html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ');
    if (!text.toLowerCase().includes(phrase.toLowerCase())) return null;
    return extractQuote(text, phrase);
  } catch { return null; }
}

/** The sentence containing the phrase, which becomes the verbatim quote. */
function extractQuote(snippet, phrase) {
  const clean = String(snippet || '').replace(/\s+/g, ' ').trim();
  const sentences = clean.match(/[^.!?]+[.!?]?/g) || [clean];
  const hit = sentences.find(s => s.toLowerCase().includes(phrase.toLowerCase()));
  return (hit || clean).trim().replace(/^[^A-Za-z0-9]+/, '');
}

function scoreOf(quote, phrase) {
  let s = 5;
  if (/matrix|spreadsheet|binder|by hand|manual/i.test(quote)) s += 3;
  else if (/expir|renewal|recertif/i.test(quote)) s += 2;
  else s += 1;
  if (phrase === 'training matrix') s += 1;
  return Math.min(10, s);
}

const norm = n => String(n).toLowerCase().replace(/[.,]/g, ' ')
  .replace(/\b(inc|ltd|limited|corp|corporation|co|company|society|group|holdings|llc|lp)\b/g, ' ')
  .replace(/\s+/g, ' ').trim();

/**
 * Fetch one search page.
 *
 * DNS IS THE BOTTLENECK, NOT THE SITE. A 850-query sweep returned ENOTFOUND on 841 of them
 * after the first nine succeeded. The host resolver gives out under sustained lookups, and the
 * same failure hit Supabase mid-run as "fetch failed", which is how a 72-lead crawl was lost.
 *
 * So: retry ENOTFOUND and friends rather than treating them as "no results", and back off hard
 * when they cluster, because the resolver needs time rather than another immediate attempt.
 */
const DNS_ERRORS = /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|socket hang up|fetch failed/i;
let consecutiveDnsFailures = 0;

async function search(phrase, target) {
  const url = `${target.host}/search?q=${encodeURIComponent(`"${phrase}"`)}&l=${encodeURIComponent(target.place)}`;
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await axios.get(url, { headers: HEADERS, timeout: 25000 });
      consecutiveDnsFailures = 0;
      const m = String(res.data).match(/id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!m) return { jobs: [], total: 0 };
      const pp = JSON.parse(m[1]).props.pageProps;
      return { jobs: pp.jobs || [], total: pp.resultCount || 0 };
    } catch (e) {
      lastErr = e;
      const code = e.code || e.message || '';
      if (!DNS_ERRORS.test(code)) throw e;
      consecutiveDnsFailures++;
      // Escalating backoff. Once several in a row fail the resolver is saturated and only time
      // fixes it, so wait seconds rather than milliseconds.
      const wait = Math.min(30000, 2000 * Math.pow(2, attempt) + consecutiveDnsFailures * 1000);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

module.exports = { APPLICANT_FACING, INTERNAL_WORK, EXCLUDE_NAME, EXCLUDE_LARGE, extractQuote, inferIndustry };

// Only run when invoked directly, so the filters can be unit tested without hitting the network.
if (require.main === module) (async () => {
  const { data: existing } = await supabase.from(TABLE).select('business_name');
  const seen = new Set((existing || []).map(r => norm(r.business_name)));
  console.log(`${DRY ? 'DRY RUN. ' : ''}${seen.size} companies already in the list.\n`);

  const found = [];

  // Checkpoint to disk as we go. A sweep can run 40 minutes across 600 queries, and anything
  // that ends it early (a kill, a lost terminal, a laptop sleeping) would otherwise throw away
  // every result, because the batch used to be written only after the loop finished.
  const stamp = new Date().toISOString().slice(0, 10);
  const batchPath = `cadre/batches/${stamp}-finder-${REGION}.json`;
  const checkpoint = () => {
    try {
      fs.mkdirSync('cadre/batches', { recursive: true });
      fs.writeFileSync(batchPath, JSON.stringify(found, null, 1));
    } catch (e) { console.error(`  checkpoint failed: ${e.message}`); }
  };
  // Save on the way out too, however the process ends.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      checkpoint();
      console.log(`\nStopped. ${found.length} companies saved to ${batchPath}`);
      console.log(`Ingest them with: node cadre/ingest.js ${batchPath}`);
      process.exit(0);
    });
  }

  const phrases = PHRASES.slice(0, MAX_PHRASES);
  const targets = TARGETS.slice(0, MAX_LOCATIONS);

  for (const phrase of phrases) {
    for (const target of targets) {
      let r;
      globalThis.__queriesTried = (globalThis.__queriesTried || 0) + 1;
      try { r = await search(phrase, target); }
      catch (e) { console.log(`  ! ${phrase} / ${target.place}: ${e.response ? e.response.status : e.code}`); continue; }
      globalThis.__queriesOk = (globalThis.__queriesOk || 0) + 1;
      await new Promise(res => setTimeout(res, GAP_MS));
      if (consecutiveDnsFailures >= 3) {
        console.log('  … resolver struggling, pausing 60s');
        await new Promise(res => setTimeout(res, 60000));
        consecutiveDnsFailures = 0;
      }

      let added = 0;
      let deepUsed = 0;
      for (const job of r.jobs) {
        const company = String(job.company || '').trim();
        const snippet = String(job.snippet || '');
        if (!company) continue;
        let quoteSource = snippet;
        if (!snippet.toLowerCase().includes(phrase.toLowerCase())) {
          // Some country sites never put the matched phrase in the snippet. Fetch the posting,
          // but only for a few per query so this does not turn into 20 requests a search.
          if (deepUsed >= DEEP_PER_QUERY) continue;
          deepUsed++;
          await new Promise(r => setTimeout(r, 1200));
          const deep = await deepQuote(target, job, phrase);
          if (!deep) continue;
          quoteSource = deep;
        }
        const key = norm(company);
        if (!key || seen.has(key)) continue;
        if (EXCLUDE_NAME.some(re => re.test(company)) || EXCLUDE_LARGE.some(re => re.test(company))) continue;
        if (EXCLUDE_VERTICAL.some(re => re.test(company + " " + job.title))) continue;
        // NEVER the employer or the other excluded organisation, at company level. This matters
        // more now that healthcare is searched rather than filtered out, because the employer is
        // a healthcare organisation and would otherwise be a textbook match for these phrases.
        const dnc = excludedOrgReason(company, null);
        if (dnc) { console.log(`  ! skipped excluded org: ${company}`); continue; }

        const quote = extractQuote(quoteSource, phrase);
        if (quote.length < 25) continue;
        if (APPLICANT_FACING.some(re => re.test(quote))) continue;
        if (!INTERNAL_WORK.test(quote)) continue;

        seen.add(key);
        found.push({
          business_name: company,
          city: String(job.location || '').trim() || null,
          industry: inferIndustry(`${job.title} ${company} ${snippet}`),
          source: 'simplyhired',
          signal_type: /matrix|spreadsheet|binder|by hand|manual/i.test(quote) ? 'manual_tracking' : 'hiring_credentialing',
          signal_quote: quote,
          signal_url: jobUrl(target, job, phrase),
          signal_date: new Date().toISOString().slice(0, 10),
          qualification_score: scoreOf(quote, phrase),
          personalization_basis: `published signal: ${phrase}`,
          notes: `[${target.region.toUpperCase()}] Found via SimplyHired phrase "${phrase}" in ${target.place}. Job title: ${job.title}.`,
        });
        added++;
      }
      if (added) checkpoint();
      console.log(`  ${String(r.total).padStart(4)} hits  ${added ? '+' + added : '  '}  "${phrase}" / ${target.place}`);
    }
  }

  console.log(`\n${found.length} new companies.\n`);
  for (const f of found.slice(0, 15)) {
    console.log(`  ${f.qualification_score}/10  ${f.business_name.slice(0, 34).padEnd(36)}${String(f.city).slice(0, 18).padEnd(20)}${f.industry}`);
    console.log(`        "${f.signal_quote.slice(0, 100)}"`);
  }
  if (found.length > 15) console.log(`  ... and ${found.length - 15} more`);

  // ALWAYS write the batch to disk first.
  //
  // A 40-minute CA+US sweep found 72 companies and then lost every one of them to a single
  // "fetch failed" on the first insert. Forty minutes of requests thrown away because the
  // results only existed in memory. The file is written before any further network call, so a
  // failed run can be re-ingested with cadre/ingest.js instead of re-crawled.
  checkpoint();
  console.log(`Saved to ${batchPath}`);

  if (DRY || !found.length) { console.log(`${DRY ? 'Dry run, nothing written to the database.' : 'Nothing new.'}`); return; }

  let ok = 0, failed = 0;
  for (const f of found) {
    let inserted = false;
    for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
      const { error } = await supabase.from(TABLE).insert(f);
      if (!error) { inserted = true; break; }
      // A transient network error should not cost a lead that took a crawl to find.
      if (/fetch failed|ETIMEDOUT|ECONNRESET|socket hang up/i.test(error.message) && attempt < 2) {
        await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
        continue;
      }
      console.error(`  insert failed ${f.business_name}: ${error.message}`);
      break;
    }
    inserted ? ok++ : failed++;
  }
  console.log(`\nInserted ${ok}${failed ? `, ${failed} failed (re-run: node cadre/ingest.js ${batchPath})` : ''}.`);
  console.log(`Next: node tempo/hunt-emails.js --table ${TABLE}`);
})().then(() => {
  // A sweep where EVERY query failed must not exit 0. The first Actions dispatch 403'd all 84
  // queries (SimplyHired blocks datacenter IPs), reported success, and saved nothing: a silent
  // zero wearing a green tick. The counters are set in the query loop.
  if (globalThis.__queriesTried > 10 && globalThis.__queriesOk === 0) {
    console.error(`ALL ${globalThis.__queriesTried} queries failed. This environment cannot reach the source.`);
    process.exit(1);
  }
}).catch(e => { console.error('lead finder failed:', e.message); process.exit(1); });
