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
const GAP_MS = 2500;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  // Required. Without an HTML Accept header SimplyHired answers 403.
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9',
  'Accept-Language': 'en-CA,en;q=0.9',
};

/** Ordered by yield. The first is worth more than the rest combined. */
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
];

const LOCATIONS = ['ontario', 'british columbia', 'alberta', 'quebec', 'manitoba',
  'saskatchewan', 'nova scotia', 'new brunswick', 'canada'];

/** Companies whose OWN BUSINESS is selling this, or who cannot buy. */
const EXCLUDE_NAME = [
  /\b(staffing|recruit|personnel|talent|placement|manpower|adecco|randstad|robert half|hays)\b/i,
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
];

/**
 * Verticals where this signal is structurally absent. Two sweeps confirmed healthcare and
 * property employers publish credentials as a requirement ON THE APPLICANT, not as internal
 * work, so a hit there is almost always a misread of a training-coordinator role.
 */
const EXCLUDE_VERTICAL = [
  /\b(clinic|dental|physiotherapy|chiropract|pharmacy|veterinar|hospice|long.?term care)\b/i,
  /\b(property management|strata|realty|real estate|brokerage|condominium)\b/i,
  /\b(retail|boutique|restaurant|hotel|resort)\b/i,
];

/** Map the posting to one of the verticals where this signal is real. */
function inferIndustry(text) {
  const t = text.toLowerCase();
  if (/\b(driver|fleet|trucking|transport|logistics|carrier|dispatch|dq file)\b/.test(t)) return 'transport';
  if (/\b(childcare|daycare|early learning|ece|youth|foster|residential|social services|community living|caregiver)\b/.test(t)) return 'childcare';
  if (/\b(guard|security|patrol|alarm)\b/.test(t)) return 'security';
  if (/\b(food|bakery|dairy|meat|produce|processing|haccp|foodsafe|brewery|seafood)\b/.test(t)) return 'food';
  if (/\b(laborator|lab tech|assay|geotech|testing services|quality control lab)\b/.test(t)) return 'lab';
  if (/\b(construct|contractor|electrical|plumbing|mechanical|roofing|excavat|welding|scaffold|crane|hvac|pipeline|drilling|oilfield|mining)\b/.test(t)) return 'trades';
  if (/\b(manufactur|plant|fabricat|machining|assembly|production|mill|foundry|extrusion)\b/.test(t)) return 'manufacturing';
  return 'manufacturing';
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

async function search(phrase, location) {
  const url = `https://www.simplyhired.ca/search?q=${encodeURIComponent(`"${phrase}"`)}&l=${encodeURIComponent(location)}`;
  const res = await axios.get(url, { headers: HEADERS, timeout: 25000 });
  const m = String(res.data).match(/id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return { jobs: [], total: 0 };
  const pp = JSON.parse(m[1]).props.pageProps;
  return { jobs: pp.jobs || [], total: pp.resultCount || 0 };
}

(async () => {
  const { data: existing } = await supabase.from(TABLE).select('business_name');
  const seen = new Set((existing || []).map(r => norm(r.business_name)));
  console.log(`${DRY ? 'DRY RUN. ' : ''}${seen.size} companies already in the list.\n`);

  const found = [];
  const phrases = PHRASES.slice(0, MAX_PHRASES);
  const locations = LOCATIONS.slice(0, MAX_LOCATIONS);

  for (const phrase of phrases) {
    for (const location of locations) {
      let r;
      try { r = await search(phrase, location); }
      catch (e) { console.log(`  ! ${phrase} / ${location}: ${e.response ? e.response.status : e.code}`); continue; }
      await new Promise(res => setTimeout(res, GAP_MS));

      let added = 0;
      for (const job of r.jobs) {
        const company = String(job.company || '').trim();
        const snippet = String(job.snippet || '');
        if (!company || !snippet.toLowerCase().includes(phrase.toLowerCase())) continue;
        const key = norm(company);
        if (!key || seen.has(key)) continue;
        if (EXCLUDE_NAME.some(re => re.test(company)) || EXCLUDE_LARGE.some(re => re.test(company))) continue;
        if (EXCLUDE_VERTICAL.some(re => re.test(company + " " + job.title))) continue;
        if (excludedOrgReason(company, null)) continue;

        const quote = extractQuote(snippet, phrase);
        if (quote.length < 25) continue;

        seen.add(key);
        found.push({
          business_name: company,
          city: String(job.location || '').trim() || null,
          industry: inferIndustry(`${job.title} ${company} ${snippet}`),
          source: 'simplyhired',
          signal_type: /matrix|spreadsheet|binder|by hand|manual/i.test(quote) ? 'manual_tracking' : 'hiring_credentialing',
          signal_quote: quote,
          signal_url: job.encodedUrl ? `https://www.simplyhired.ca${job.encodedUrl}` : `https://www.simplyhired.ca/search?q=${encodeURIComponent(`"${phrase}"`)}&l=${encodeURIComponent(location)}`,
          signal_date: new Date().toISOString().slice(0, 10),
          qualification_score: scoreOf(quote, phrase),
          personalization_basis: `published signal: ${phrase}`,
          notes: `Found via SimplyHired phrase "${phrase}" in ${location}. Job title: ${job.title}.`,
        });
        added++;
      }
      console.log(`  ${String(r.total).padStart(4)} hits  ${added ? '+' + added : '  '}  "${phrase}" / ${location}`);
    }
  }

  console.log(`\n${found.length} new companies.\n`);
  for (const f of found.slice(0, 15)) {
    console.log(`  ${f.qualification_score}/10  ${f.business_name.slice(0, 34).padEnd(36)}${String(f.city).slice(0, 18).padEnd(20)}${f.industry}`);
    console.log(`        "${f.signal_quote.slice(0, 100)}"`);
  }
  if (found.length > 15) console.log(`  ... and ${found.length - 15} more`);

  if (DRY || !found.length) { console.log(`\n${DRY ? 'Dry run, nothing written.' : 'Nothing new.'}`); return; }

  let ok = 0;
  for (const f of found) {
    const { error } = await supabase.from(TABLE).insert(f);
    if (error) { console.error(`  insert failed ${f.business_name}: ${error.message}`); continue; }
    ok++;
  }
  console.log(`\nInserted ${ok}. Next: node tempo/hunt-emails.js --table ${TABLE}`);
})().catch(e => { console.error('lead finder failed:', e.message); process.exit(1); });
