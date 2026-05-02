/**
 * lead-finder.js
 * Searches Google Places for businesses in the Lower Mainland,
 * scrapes contact emails from their websites, and stores leads in Supabase.
 *
 * Usage: node lead-finder.js --industry "accounting firms" --city "Vancouver BC"
 */

require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const supabase = require('./lib/supabase');

const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';

const CITIES = [
  'Vancouver BC',
  'Burnaby BC',
  'Surrey BC',
  'Richmond BC',
  'Langley BC',
  'Coquitlam BC',
  'Abbotsford BC',
];

const INDUSTRIES = [
  'accounting firms',
  'law firms',
  'dental clinics',
  'real estate agencies',
  'marketing agencies',
  'construction companies',
  'property management companies',
  'insurance brokers',
  'financial advisors',
  'physiotherapy clinics',
];

// Parse CLI args: --industry "..." --city "..."
function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--industry') result.industry = args[++i];
    if (args[i] === '--city') result.city = args[++i];
    if (args[i] === '--pages') result.pages = parseInt(args[++i], 10);
  }
  return result;
}

// Search Google Places and return up to 20 results per query
async function searchPlaces(query, pageToken = null) {
  const body = { textQuery: query, maxResultCount: 20 };
  if (pageToken) body.pageToken = pageToken;

  const res = await axios.post(PLACES_URL, body, {
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': MAPS_KEY,
      'X-Goog-FieldMask': [
        'places.displayName',
        'places.formattedAddress',
        'places.websiteUri',
        'places.internationalPhoneNumber',
        'nextPageToken',
      ].join(','),
    },
  });

  return res.data;
}

// Scrape a business website for contact email addresses
async function scrapeEmail(websiteUrl) {
  if (!websiteUrl) return null;
  try {
    const res = await axios.get(websiteUrl, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AevonBot/1.0)' },
    });
    const $ = cheerio.load(res.data);
    const text = $.text();

    // Find email-like patterns in page text
    const match = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}(?=[^a-zA-Z]|$)/);
    if (match) return match[0].toLowerCase();

    // Also check mailto links
    let mailtoEmail = null;
    $('a[href^="mailto:"]').each((_, el) => {
      const href = $(el).attr('href');
      const email = href.replace('mailto:', '').split('?')[0].trim();
      if (email && email.includes('@')) {
        mailtoEmail = email.toLowerCase();
        return false; // break
      }
    });

    return mailtoEmail;
  } catch {
    return null;
  }
}

// Check if this business already exists in Supabase
async function isDuplicate(businessName, website) {
  const { data } = await supabase
    .from('leads')
    .select('id')
    .or(`business_name.eq."${businessName}",website.eq."${website}"`)
    .limit(1);
  return data && data.length > 0;
}

// Store lead in Supabase
async function saveLead(lead) {
  const { error } = await supabase.from('leads').insert(lead);
  if (error) throw new Error(`Supabase insert failed: ${error.message}`);
}

async function run() {
  const args = parseArgs();
  const industries = args.industry ? [args.industry] : INDUSTRIES;
  const cities = args.city ? [args.city] : CITIES;
  const maxPages = args.pages || 1;

  let totalFound = 0;
  let totalSaved = 0;
  let totalSkipped = 0;

  for (const industry of industries) {
    for (const city of cities) {
      const query = `${industry} ${city}`;
      console.log(`\nSearching: "${query}"`);

      let pageToken = null;
      let page = 0;

      do {
        const data = await searchPlaces(query, pageToken);
        const places = data.places || [];
        pageToken = data.nextPageToken || null;
        page++;

        for (const place of places) {
          const name = place.displayName?.text || 'Unknown';
          const website = place.websiteUri || null;
          totalFound++;

          // Dedup check
          if (await isDuplicate(name, website)) {
            console.log(`  [skip] ${name} (already exists)`);
            totalSkipped++;
            continue;
          }

          // Scrape email
          process.stdout.write(`  [scraping] ${name}...`);
          const email = await scrapeEmail(website);
          console.log(email ? ` ${email}` : ' no email found');

          const lead = {
            business_name: name,
            address: place.formattedAddress || null,
            phone: place.internationalPhoneNumber || null,
            website,
            email,
            industry,
            city,
            status: 'queued',
            sequence_step: 0,
          };

          await saveLead(lead);
          totalSaved++;

          // Polite delay between scrapes
          await new Promise(r => setTimeout(r, 1200));
        }
      } while (pageToken && page < maxPages);
    }
  }

  console.log(`\nDone. Found: ${totalFound} | Saved: ${totalSaved} | Skipped: ${totalSkipped}`);
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
