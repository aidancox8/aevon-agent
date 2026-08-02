#!/usr/bin/env node
/**
 * find-partners.js
 * Builds a referral-partner list: people who are standing there when a clinic owner
 * discovers they cannot schedule their staff.
 *
 * Deliberately its own table, not `leads` or `tempo_leads`. A partner must never be swept
 * into cold outreach: the pitch is "send clients my way and I pay you", which is a
 * conversation, not a sequence. Keeping them in a separate table makes that structural
 * rather than a rule someone has to remember.
 *
 * The strongest category is EMR and Jane implementation consultants. Jane's own guidance
 * says admin and front desk staff cannot go on its schedule and suggests an external
 * calendar, so these consultants already hit this wall for their clients and currently end
 * the conversation with "use a spreadsheet".
 *
 *   node find-partners.js                  Lower Mainland
 *   node find-partners.js --region canada  wider sweep
 *   node find-partners.js --dry-run        search and print, save nothing
 */
require('dotenv').config();
const axios = require('axios');
const supabase = require('./lib/supabase');
const { findContact } = require('./lib/contact-finder');

const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY;
const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
const DRY = process.argv.includes('--dry-run');
const REGION = (() => {
  const i = process.argv.indexOf('--region');
  return i > -1 ? process.argv[i + 1] : 'bc';
})();

const CITIES_BC = [
  'Vancouver BC', 'Burnaby BC', 'Surrey BC', 'Richmond BC', 'Langley BC',
  'Coquitlam BC', 'Abbotsford BC', 'North Vancouver BC', 'New Westminster BC', 'Victoria BC',
];
const CITIES_WIDE = [...CITIES_BC, 'Calgary AB', 'Edmonton AB', 'Toronto ON', 'Ottawa ON', 'Winnipeg MB', 'Halifax NS'];

// Each category is a distinct reason the partner already has the conversation.
const CATEGORIES = [
  { key: 'emr-consultant',      queries: ['Jane app consultant', 'EMR implementation consultant healthcare', 'clinic software consultant', 'practice management software consultant'] },
  { key: 'practice-consultant', queries: ['medical practice management consultant', 'clinic operations consultant', 'healthcare practice consultant'] },
  { key: 'locum-agency',        queries: ['physiotherapy locum agency', 'allied health staffing agency', 'healthcare staffing agency clinics'] },
  { key: 'clinic-broker',       queries: ['medical practice broker', 'healthcare practice sales broker', 'clinic startup consultant'] },
];

async function searchPlaces(query) {
  const res = await axios.post(PLACES_URL, { textQuery: query, maxResultCount: 20 }, {
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': MAPS_KEY,
      'X-Goog-FieldMask': ['places.displayName', 'places.formattedAddress', 'places.websiteUri', 'places.internationalPhoneNumber'].join(','),
    },
  }).catch(e => { console.log(`  (places error: ${e.response?.status || e.message})`); return null; });
  return res?.data?.places || [];
}

// Chains and franchises that will never refer a bespoke build.
// Jane itself is not a partner, and the big staffing chains will never refer a bespoke build.
const SKIP = /^jane software|staples|ups store|h&r block|indeed|randstad|robert half|adecco|kelly services|healwell|telus health/i;

(async () => {
  if (!MAPS_KEY) throw new Error('No Google Places key in env.');
  const cities = REGION === 'canada' ? CITIES_WIDE : CITIES_BC;
  console.log(`${DRY ? 'DRY RUN. ' : ''}Searching ${cities.length} cities across ${CATEGORIES.length} partner categories.\n`);

  const seen = new Set();
  let found = 0, saved = 0;

  for (const cat of CATEGORIES) {
    console.log(`── ${cat.key}`);
    for (const city of cities) {
      for (const q of cat.queries) {
        const places = await searchPlaces(`${q} in ${city}`);
        for (const p of places) {
          const name = p.displayName?.text?.trim();
          if (!name || SKIP.test(name)) continue;
          const key = `${name.toLowerCase()}|${city}`;
          if (seen.has(key)) continue;
          seen.add(key);
          found++;

          // Only worth keeping if there is a website to reach them through.
          const website = p.websiteUri || null;
          if (!website) continue;

          let email = null, quality = null, contactName = null, contactRole = null;
          const c = await findContact(website).catch(() => null);
          if (c) { email = c.email || null; quality = c.emailQuality || null; contactName = c.contactName || null; contactRole = c.contactRole || null; }

          console.log(`   ${name.slice(0, 44).padEnd(44)} ${email || 'no email'}`);
          if (DRY || !email) continue;

          const { error } = await supabase.from('partners').insert({
            business_name: name, category: cat.key, address: p.formattedAddress || null,
            city, phone: p.internationalPhoneNumber || null, website,
            email, email_quality: quality, contact_name: contactName, contact_role: contactRole,
          });
          if (!error) saved++;
          else if (!/duplicate|unique/i.test(error.message)) console.log(`     (save failed: ${error.message})`);
        }
        await new Promise(r => setTimeout(r, 400));
      }
    }
  }
  console.log(`\nDone. ${found} distinct businesses seen, ${saved} saved with an email.`);
})().catch(e => { console.error('partner search failed:', e.message); process.exit(1); });
