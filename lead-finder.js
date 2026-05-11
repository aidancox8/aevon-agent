/**
 * lead-finder.js
 * Searches Google Places for businesses across the Lower Mainland,
 * uses Gemini to qualify each lead by reading their website,
 * and stores qualified leads in Supabase.
 *
 * Usage:
 *   node lead-finder.js                          (runs all queries)
 *   node lead-finder.js --query "dental clinics" --city "Surrey BC"
 *   node lead-finder.js --min-score 7            (only save score 7+)
 */

require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const supabase = require('./lib/supabase');
const { generate } = require('./lib/gemini');

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
  'North Vancouver BC',
  'New Westminster BC',
];

const SEARCH_QUERIES = [
  // Property & real estate
  'property management company',
  // Professional services
  'marketing agency',
  'engineering firm',
  'staffing agency',
  'insurance brokerage',
  'IT consulting firm',
  'environmental consulting firm',
  'architecture firm',
  'management consulting firm',
  'public relations firm',
  'market research firm',
  'recruitment agency',
  'surveying company',
  'inspection company',
  // Trades & field service
  'HVAC company',
  'plumbing company',
  'electrical contractor',
  'equipment rental company',
  'moving company',
  'courier company',
  'field service company',
  // Corporate & distribution
  'trading company',
  'import export company',
  'distribution company',
  'wholesale distributor',
  'logistics company',
  'manufacturing company',
  'media company',
  'research company',
  'pharmaceutical company',
  // Clinics & healthcare
  'medical clinic',
  'dental clinic',
  'physiotherapy clinic',
  'chiropractic clinic',
  'optometry clinic',
  'veterinary clinic',
];

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { minScore: 7 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--query') result.query = args[++i];
    if (args[i] === '--city') result.city = args[++i];
    if (args[i] === '--min-score') result.minScore = parseInt(args[++i], 10);
    if (args[i] === '--pages') result.pages = parseInt(args[++i], 10);
  }
  return result;
}

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

async function scrapeWebsite(websiteUrl) {
  if (!websiteUrl) return { email: null, text: '' };
  try {
    const res = await axios.get(websiteUrl, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AevonBot/1.0)' },
    });
    const $ = cheerio.load(res.data);

    // Remove script/style noise
    $('script, style, noscript').remove();
    const text = $('body').text().replace(/\s+/g, ' ').slice(0, 3000);

    // Find email
    let email = null;
    $('a[href^="mailto:"]').each((_, el) => {
      const href = $(el).attr('href');
      const addr = href.replace('mailto:', '').split('?')[0].trim().toLowerCase();
      if (addr.includes('@')) { email = addr; return false; }
    });

    if (!email) {
      const match = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}(?=[^a-zA-Z]|$)/);
      if (match) email = match[0].toLowerCase();
    }

    return { email, text };
  } catch {
    return { email: null, text: '' };
  }
}

async function qualifyLead(business, websiteText) {
  const prompt = `You are evaluating whether a small business is a good prospect for Aevon, a custom business app development company.

Aevon builds custom internal software for businesses in the Lower Mainland, BC. Clients pay a one-time build fee ($3,000-$15,000) and own the software outright. Typical projects: internal workflow tools, scheduling systems, client portals, document management, field reporting apps, AI-powered knowledge bases.

Good prospects (score 8-10):
- 15-100 employees — large enough to have real operational pain and budget to spend
- Clear operational complexity (multiple staff roles, field workers, client intake, scheduling, inventory, reporting)
- Professional services, healthcare, distribution, or corporate ops — industries where staff time is expensive and inefficiency has real cost
- Signs of budget: professional website, multiple locations, named team members, established brand
- B2B focused — they have clients or customers they manage

Acceptable prospects (score 6-7):
- 5-15 employees with clear operational pain
- Trades businesses (HVAC, plumbing, electrical) with dispatch and job tracking needs

Bad prospects (score 1-5):
- Solo operators or owner-only businesses — no budget, no need
- Pure retail (restaurant, cafe, salon, grocery) — no internal ops complexity
- Residential-only service providers with no staff
- Enterprise companies with IT departments
- No web presence or clearly out of business
- Franchises of large chains (e.g. RE/MAX individual agents, Tim Hortons)

Business details:
- Name: ${business.name}
- Address: ${business.address}
- Website: ${business.website || 'none'}

Website text excerpt:
${websiteText || '(no website content available)'}

Respond with JSON only:
{
  "score": <integer 1-10>,
  "notes": "<one sentence explaining the score>"
}`;

  try {
    const raw = await generate(prompt);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return { score: 5, notes: 'Could not parse qualification response' };
    return JSON.parse(match[0]);
  } catch {
    return { score: 5, notes: 'Qualification failed' };
  }
}

async function isDuplicate(businessName, website) {
  // Check by name first
  const { data: byName } = await supabase
    .from('leads').select('id').eq('business_name', businessName).limit(1);
  if (byName && byName.length > 0) return true;

  // Check by website if available
  if (website) {
    const { data: bySite } = await supabase
      .from('leads').select('id').eq('website', website).limit(1);
    if (bySite && bySite.length > 0) return true;
  }

  return false;
}

async function run() {
  const args = parseArgs();
  const queries = args.query ? [args.query] : SEARCH_QUERIES;
  const cities = args.city ? [args.city] : CITIES;
  const maxPages = args.pages || 1;
  const minScore = args.minScore;

  let totalFound = 0;
  let totalQualified = 0;
  let totalSaved = 0;
  let totalSkipped = 0;

  for (const query of queries) {
    for (const city of cities) {
      const fullQuery = `${query} ${city}`;
      console.log(`\nSearching: "${fullQuery}"`);

      let pageToken = null;
      let page = 0;

      do {
        const data = await searchPlaces(fullQuery, pageToken);
        const places = data.places || [];
        pageToken = data.nextPageToken || null;
        page++;

        for (const place of places) {
          const name = place.displayName?.text || 'Unknown';
          const website = place.websiteUri || null;
          totalFound++;

          if (await isDuplicate(name, website)) {
            totalSkipped++;
            continue;
          }

          process.stdout.write(`  [${name}]... `);

          // Scrape website for email + content
          const { email, text } = await scrapeWebsite(website);

          // Qualify with Gemini
          const { score, notes } = await qualifyLead(
            { name, address: place.formattedAddress, website },
            text
          );

          if (score < minScore) {
            console.log(`skip (score ${score}/10: ${notes})`);
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }

          totalQualified++;
          console.log(`score ${score}/10 | ${email || 'no email'}`);

          await supabase.from('leads').insert({
            business_name: name,
            address: place.formattedAddress || null,
            phone: place.internationalPhoneNumber || null,
            website,
            email,
            industry: query,
            city,
            status: 'queued',
            sequence_step: 0,
            qualification_score: score,
            qualification_notes: notes,
          });

          totalSaved++;
          await new Promise(r => setTimeout(r, 2500));
        }
      } while (pageToken && page < maxPages);
    }
  }

  console.log(`\nDone.`);
  console.log(`Found: ${totalFound} | Qualified (${minScore}+): ${totalQualified} | Saved: ${totalSaved} | Skipped (dupe): ${totalSkipped}`);
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
