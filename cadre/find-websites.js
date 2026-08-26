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
 * Is the place in the city we already have for this lead?
 *
 * Accents have to come off BOTH sides. The lead table stores city names ASCII-folded by the job
 * scraper ("Trois-Rivieres QC", "Saint-Valerien-de-Milton QC") while Places returns them properly
 * spelled ("Trois-Rivieres" with the accent). Comparing raw strings rejected every Quebec lead
 * that actually matched, which looked like a data problem and was a comparison problem.
 */
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function cityMatches(leadCity, formattedAddress) {
  const city = fold(leadCity).replace(/\s+[a-z]{2}$/, '').trim();
  if (!city) return true;                       // nothing to contradict
  return fold(formattedAddress).includes(city);
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

    const hit = places.find(p =>
      p.websiteUri && !SOCIAL.test(p.websiteUri)
      && namesMatch(lead.business_name, p.displayName && p.displayName.text)
      && cityMatches(lead.city, p.formattedAddress));

    if (!hit) {
      // Say WHY, so the gap is legible rather than just a smaller number. A near miss on the
      // name is a very different problem from the company having no web presence at all.
      const near = places.find(p => namesMatch(lead.business_name, p.displayName && p.displayName.text));
      if (near && near.websiteUri) { rejected++; console.log(`  skip ${String(lead.business_name).slice(0, 34).padEnd(36)}found "${near.displayName.text}" but wrong city (${near.formattedAddress || '?'})`); }
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

  console.log(`\nFound ${found} website(s). ${rejected} rejected on city, ${missing} with no confident match.`);
  if (found) console.log('Next: node tempo/hunt-emails.js --table cadre_leads');
})().catch(e => { console.error('find-websites failed:', e.message); process.exit(1); });
