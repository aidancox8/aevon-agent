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
  // Professional services
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
  'law firm',
  'accounting firm',
  'marketing agency',
  'digital marketing agency',
  'property management company',
  'interior design firm',
  'event management company',
  // Trades & field service
  'HVAC company',
  'plumbing company',
  'electrical contractor',
  'general contractor',
  'building inspection company',
  'home inspection company',
  'equipment rental company',
  'moving company',
  'courier company',
  'field service company',
  'security company',
  'commercial landscaping company',
  // Corporate & distribution
  'trading company',
  'import export company',
  'distribution company',
  'wholesale distributor',
  'logistics company',
  'freight company',
  'warehouse company',
  'manufacturing company',
  'media company',
  'research company',
  'pharmaceutical company',
  'nonprofit organization',
  'private school',
  // Sales & financial
  'real estate brokerage',
  'real estate team',
  'mortgage broker',
  'business broker',
  'financial planning firm',
  'investment advisory firm',
  // Clinics & healthcare
  'medical clinic',
  'dental clinic',
  'physiotherapy clinic',
  'chiropractic clinic',
  'optometry clinic',
  'veterinary clinic',
  'mental health clinic',
  'rehabilitation clinic',
  'medical imaging clinic',
  'multidisciplinary health clinic',
  'sports medicine clinic',
  'occupational therapy clinic',
  'ICBC physiotherapy clinic',
  'kinesiology clinic',
];

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { minScore: 8 };
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

// Minimum ms between Gemini calls to stay under rate limit
const GEMINI_MIN_GAP = 4200;
let lastGeminiAt = 0;

async function geminiRateLimited(prompt) {
  const now = Date.now();
  const gap = now - lastGeminiAt;
  if (gap < GEMINI_MIN_GAP) await new Promise(r => setTimeout(r, GEMINI_MIN_GAP - gap));
  lastGeminiAt = Date.now();
  return generate(prompt);
}

async function qualifyLead(business, websiteText) {
  const prompt = `You are a lead qualifier for Aevon, a custom software company in the Lower Mainland, BC that builds internal tools and workflow software for businesses. Score this business based on how much operational complexity they have — not based on their industry.

Aevon builds custom apps and workflow tools for businesses. Clients pay a one-time fee and own the software outright. The goal is to find businesses that are clearly dealing with manual, repetitive internal processes that off-the-shelf software doesn't fully solve.

IMPORTANT: Having industry-standard software (booking tools, EMRs, CRMs, accounting tools) does NOT disqualify a business. Those tools handle the core product — they don't automate the coordination, reporting, billing workflows, and internal processes around it.

Score based on these observable signals:

SCORE 8-10 (strong fit):
- Multiple staff roles that need to coordinate (not just one person doing everything)
- Evidence of high transaction or case volume: many clients, patients, jobs, properties, or orders managed simultaneously
- Repetitive document or reporting work visible: proposals, invoices, insurance claims, compliance reports, field reports generated repeatedly
- Multiple locations or teams sharing the same operational process
- Established business with budget signals: polished website, named team, 5+ years operating, multiple service lines
- Time-sensitive coordination where delays cost money: dispatching, intake routing, scheduling across staff

SCORE 6-7 (acceptable if clear friction is visible):
- Smaller operation but obvious manual workflow pain visible on their website
- Some staff coordination evident even if lean
- Clear growth trajectory suggesting increasing operational load

SCORE 1-5 (reject):
- Sole operator with no staff and no coordination needs
- Pure walk-in consumer service with no internal workflow complexity
- Franchise or chain location — uses parent company systems
- 100+ employees — has internal IT
- No website or clearly a placeholder
- Software or SaaS company — builds their own tools
- No observable evidence of coordination, volume, or repetitive internal work

Business details:
- Name: ${business.name}
- Address: ${business.address}
- Website: ${business.website || 'none'}

Website content:
${websiteText || '(no website available — score conservatively)'}

Respond with JSON only:
{
  "score": <integer 1-10>,
  "notes": "<one specific sentence explaining why this score — reference something concrete from the website or business type>"
}`;

  try {
    const raw = await geminiRateLimited(prompt);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return { score: 5, notes: 'Could not parse qualification response' };
    return JSON.parse(match[0]);
  } catch (err) {
    console.error(`  [Gemini error] ${err.message}`);
    return { score: 0, notes: `Gemini error: ${err.message}` };
  }
}

function buildDedupSets(existingLeads) {
  const names = new Set((existingLeads || []).map(r => r.business_name?.toLowerCase()));
  const sites = new Set((existingLeads || []).map(r => r.website?.toLowerCase()).filter(Boolean));
  return { names, sites };
}

function isDuplicate({ names, sites }, businessName, website) {
  if (names.has(businessName.toLowerCase())) return true;
  if (website && sites.has(website.toLowerCase())) return true;
  return false;
}

async function run() {
  const args = parseArgs();
  const queries = args.query ? [args.query] : SEARCH_QUERIES.slice().sort(() => Math.random() - 0.5);
  const cities = args.city ? [args.city] : CITIES;
  const maxPages = args.pages || 1;
  const minScore = args.minScore;

  // Load all existing leads once for in-memory dedup (avoids 2 DB queries per lead)
  console.log('Loading existing leads for dedup...');
  const { data: existingLeads, error: dedupErr } = await supabase
    .from('leads').select('business_name, website');
  if (dedupErr) throw new Error(`Failed to load existing leads: ${dedupErr.message}`);
  const dedup = buildDedupSets(existingLeads);
  console.log(`  ${existingLeads?.length || 0} existing leads loaded.\n`);

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

        // Filter dupes first (in-memory, instant)
        const fresh = places.filter(place => {
          const name = place.displayName?.text || 'Unknown';
          const website = place.websiteUri || null;
          totalFound++;
          if (isDuplicate(dedup, name, website)) { totalSkipped++; return false; }
          return true;
        });

        // Scrape all fresh leads in parallel (I/O bound — safe to parallelize)
        const scraped = await Promise.all(
          fresh.map(async place => {
            const { email, text } = await scrapeWebsite(place.websiteUri || null);
            return { place, email, text };
          })
        );

        // Qualify with Gemini sequentially (rate-limited)
        for (const { place, email, text } of scraped) {
          const name = place.displayName?.text || 'Unknown';
          const website = place.websiteUri || null;

          process.stdout.write(`  [${name}]... `);

          const { score, notes } = await qualifyLead(
            { name, address: place.formattedAddress, website },
            text
          );

          if (score < minScore) {
            console.log(`skip (score ${score}/10: ${notes})`);
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

          // Add to in-memory dedup so later queries in this run don't re-add
          dedup.names.add(name.toLowerCase());
          if (website) dedup.sites.add(website.toLowerCase());

          totalSaved++;
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
