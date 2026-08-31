#!/usr/bin/env node
/**
 * cadre/find-websites.js — give the email hunter something to hunt.
 *
 * THE ACTUAL BOTTLENECK. Of 111 Cadre leads with no email address, 71 have no website either.
 * tempo/hunt-emails.js crawls a site for published addresses, so with no site there is nothing
 * for it to do, and re-running it on those rows will never help. They came from job-board
 * scraping, which yields a company name, a city and a posting, but often no homepage.
 *
 * This fills that gap from Google Places, matching on name plus city. Then the hunter can run.
 *
 * WHY IT IS FUSSY ABOUT MATCHING. "Empire Roofing" exists in a dozen cities and "Supreme Motors"
 * in more. Attaching the wrong website is worse than attaching none: the hunter would then find
 * a real, published, completely unrelated company's address, and every downstream guard would
 * pass it, because there is nothing wrong with the address except that it belongs to strangers.
 * So a result is only accepted when the returned name genuinely corresponds to the lead's name
 * and the address sits in the city we already have.
 *
 *   node cadre/find-websites.js --dry
 *   node cadre/find-websites.js --limit 20
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const supabase = require('../lib/supabase');

const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
const KEY = process.env.GOOGLE_MAPS_API_KEY;
const DRY = process.argv.includes('--dry');
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  return i > -1 ? parseInt(process.argv[i + 1], 10) : null;
})();

/** Strip the noise that stops two spellings of the same company matching. */
const norm = s => String(s || '').toLowerCase()
  .replace(/[.,'’"()]/g, ' ')
  .replace(/\b(ltd|limited|inc|incorporated|llc|l\.?p|corp|corporation|co|company|group|holdings|enterprises|industries|services|solutions|the|and|&)\b/g, ' ')
  .replace(/\s+/g, ' ').trim();

/** Do these two company names refer to the same business? */
function namesMatch(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  // Every significant word of the shorter name must appear in the longer one. "Empire Roofing"
  // matching "Empire Roofing & Sheet Metal" is right; matching "Empire Motors" is not.
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const words = short.split(' ').filter(w => w.length > 2);
  return words.length > 0 && words.every(w => long.includes(w));
}

/**
 * Is this Places result plausibly the same company we already have?
 *
 * City-exact matching was wrong and was the single reason this script returned almost nothing.
 * The lead's city comes from a JOB POSTING, which names where the work is; Places returns the
 * company's REGISTERED ADDRESS. A Richmond BC manufacturer advertising a Vancouver BC role was
 * rejected as "wrong city" even though it was obviously the same business. Measured on a sample
 * of 12 leads, city-exact accepted zero of them.
 *
 * So the test is REGION, not city: same province or state is close enough when the name already
 * matched strictly, and the name test is what actually guards against "Empire Roofing" in a
 * dozen cities. City is still used, as a bonus rather than a requirement.
 *
 * Accents come off BOTH sides. The lead table stores city names ASCII-folded by the job scraper
 * ("Trois-Rivieres QC") while Places returns them properly spelled. Comparing raw strings
 * rejected every Quebec lead that matched, which looked like a data problem and was a
 * comparison problem.
 */
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** "Sugar Land, TX" -> "tx"; "Abbotsford BC" -> "bc"; "Watford" -> null. */
function regionOf(leadCity) {
  const m = fold(leadCity).match(/[,\s]\s*([a-z]{2})\s*$/);
  return m ? m[1] : null;
}

/** "Sugar Land, TX" -> "sugar land"; "Abbotsford BC" -> "abbotsford". */
function cityOf(leadCity) {
  return fold(leadCity).replace(/[,\s]\s*[a-z]{2}\s*$/, '').replace(/,\s*$/, '').trim();
}

function placeMatches(leadCity, formattedAddress) {
  const addr = fold(formattedAddress);
  if (!addr) return false;
  const region = regionOf(leadCity);
  const city = cityOf(leadCity);
  // Region is the real gate when we have one: a two-letter code appears in the formatted
  // address as its own token, so match it that way rather than as a substring ("on" would
  // otherwise hit "Toronto").
  if (region) return new RegExp('(^|[, ])' + region + '([, ]|$)', 'i').test(addr);
  // No region code (UK and Irish towns mostly). Fall back to the town name.
  if (city) return addr.includes(city);
  return true; // nothing to contradict
}

const SOCIAL = /(facebook|instagram|linkedin|twitter|x\.com|youtube|tiktok|indeed|glassdoor|ziprecruiter|yelp|bbb\.org|mapquest|yellowpages|google\.com)/i;

async function lookup(name, city) {
  const res = await fetch(PLACES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': KEY,
      'X-Goog-FieldMask': 'places.displayName,places.websiteUri,places.formattedAddress',
    },
    body: JSON.stringify({ textQuery: `${name} ${city || ''}`.trim(), maxResultCount: 5 }),
  });
  if (!res.ok) throw new Error(`Places ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return (await res.json()).places || [];
}

(async () => {
  if (!KEY) throw new Error('GOOGLE_MAPS_API_KEY missing from .env');

  const { data: leads, error } = await supabase.from('cadre_leads')
    .select('id, business_name, city, website, email, status, qualification_score')
    .is('website', null).is('email', null)
    .not('status', 'in', '("dont_contact","unsubscribed","bounced")')
    .order('qualification_score', { ascending: false, nullsFirst: false });
  if (error) throw new Error(error.message);

  const batch = LIMIT ? leads.slice(0, LIMIT) : leads;
  console.log(`${DRY ? 'DRY RUN: ' : ''}looking up ${batch.length} lead(s) with no website\n`);

  let found = 0, rejected = 0, missing = 0;
  for (const lead of batch) {
    let places;
    try {
      places = await lookup(lead.business_name, lead.city);
    } catch (e) {
      console.log(`  ERR  ${String(lead.business_name).slice(0, 34).padEnd(36)}${e.message}`);
      continue;
    }

    const usable = places.filter(p => p.websiteUri && !SOCIAL.test(p.websiteUri)
      && namesMatch(lead.business_name, p.displayName && p.displayName.text));

    // Same region is the ordinary case.
    let hit = usable.find(p => placeMatches(lead.city, p.formattedAddress));

    // Cross-region fallback, for national companies hiring away from head office (a Gatineau QC
    // posting whose company is registered in Ottawa ON, across the river). Only when the
    // normalised name matches EXACTLY and is the ONLY exact match Places returned: a generic
    // name like "Empire Roofing" comes back several times over and is refused here, which is the
    // collision the region test exists to prevent.
    if (!hit) {
      const exact = usable.filter(p => norm(p.displayName && p.displayName.text) === norm(lead.business_name));
      if (exact.length === 1) hit = exact[0];
    }

    if (!hit) {
      // Say WHY, so the gap is legible rather than just a smaller number. A near miss on the
      // name is a very different problem from the company having no web presence at all.
      const near = places.find(p => namesMatch(lead.business_name, p.displayName && p.displayName.text));
      if (near && near.websiteUri) { rejected++; console.log(`  skip ${String(lead.business_name).slice(0, 34).padEnd(36)}found "${near.displayName.text}" but wrong region (${near.formattedAddress || '?'})`); }
      else if (near) { missing++; console.log(`  none ${String(lead.business_name).slice(0, 34).padEnd(36)}listed but has no website`); }
      else { missing++; console.log(`  none ${String(lead.business_name).slice(0, 34).padEnd(36)}no confident match`); }
      continue;
    }

    found++;
    console.log(`  ok   ${String(lead.business_name).slice(0, 34).padEnd(36)}${hit.websiteUri}`);
    if (!DRY) {
      const { error: e2 } = await supabase.from('cadre_leads')
        .update({ website: hit.websiteUri }).eq('id', lead.id);
      if (e2) console.log(`       FAILED to save: ${e2.message}`);
    }
  }

  console.log(`\nFound ${found} website(s). ${rejected} rejected on region, ${missing} with no confident match.`);
  if (found) console.log('Next: node tempo/hunt-emails.js --table cadre_leads');
})().catch(e => { console.error('find-websites failed:', e.message); process.exit(1); });
