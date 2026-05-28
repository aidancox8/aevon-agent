/**
 * agent-lead-finder.js
 * Searches Google Places for businesses with high-volume repetitive knowledge work —
 * the kind that AI agents can automate (outreach, research, drafting, routing, scheduling).
 * Qualifies leads with Gemini and stores them in Supabase.
 *
 * Usage:
 *   node agent-lead-finder.js
 *   node agent-lead-finder.js --query "staffing agency" --city "Vancouver BC"
 *   node agent-lead-finder.js --min-score 7
 */

require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const supabase = require('./lib/supabase');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;

// Separate Gemini instance so agent-lead-finder uses its own API key and quota
const _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY_AGENT || process.env.GEMINI_API_KEY);
const _primary = _genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });
const _fallback = _genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

async function generate(prompt) {
  try {
    return (await _primary.generateContent(prompt)).response.text().trim();
  } catch (err) {
    if (err.message.includes('429') || err.message.includes('503')) {
      console.warn(`Primary unavailable, falling back...`);
      return (await _fallback.generateContent(prompt)).response.text().trim();
    }
    throw err;
  }
}
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

// Companies with high-volume repetitive knowledge work: outreach, research,
// writing, routing, intake, scheduling, reporting — all strong AI agent targets.
const SEARCH_QUERIES = [
  // Outbound-heavy: lots of prospecting, follow-up, proposal writing
  'staffing agency',
  'recruitment agency',
  'executive search firm',
  'real estate team',
  'real estate brokerage',
  'mortgage brokerage',
  'insurance brokerage',
  'business broker',
  'financial advisor',
  'investment advisor',
  // Agencies: content creation, client reporting, research, pitching
  'marketing agency',
  'digital marketing agency',
  'advertising agency',
  'public relations firm',
  'content marketing agency',
  'SEO agency',
  'media buying agency',
  // Professional services: research, drafting, reporting, client intake
  'law firm',
  'accounting firm',
  'business consulting firm',
  'management consulting firm',
  'market research firm',
  'grant writing firm',
  // High-volume intake and scheduling
  'medical clinic',
  'dental clinic',
  'physiotherapy clinic',
  'mental health clinic',
  'chiropractic clinic',
  'multidisciplinary health clinic',
  'sports medicine clinic',
  'occupational therapy clinic',
  'ICBC physiotherapy clinic',
  'kinesiology clinic',
  // Operations with repetitive document or data workflows
  'import export company',
  'logistics company',
  'freight company',
  'property management company',
  'commercial real estate company',
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
    $('script, style, noscript').remove();
    const text = $('body').text().replace(/\s+/g, ' ').slice(0, 3000);

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
  const prompt = `You are a lead qualifier for Aevon, a company that builds custom AI agents for businesses in the Lower Mainland, BC. Score this business based on how much repetitive, high-volume knowledge work their staff does — not based on their industry.

AI agents automate work that recurs on a predictable pattern: outreach sequences, document drafting, intake routing, report generation, data extraction, scheduling coordination. The question is whether this business's staff is clearly doing a lot of that kind of work manually.

IMPORTANT: Having a CRM, booking tool, EMR, or any standard SaaS does NOT disqualify a business. Those tools handle the core product — the repetitive coordination and knowledge work around them is what agents automate.

Score based on these observable signals:

SCORE 8-10 (strong fit):
- Staff clearly doing high-volume repetitive outreach or follow-up: prospecting, lead nurturing, client communication at scale
- Staff producing the same type of written output repeatedly: proposals, reports, briefs, assessments, summaries, claims
- High inbound volume that requires routing, qualification, or response: inquiries, applications, referrals, service requests
- Multiple people coordinating the same recurring process across clients, patients, or cases
- Established business with budget signals: polished website, named team, 5+ years operating, multiple service lines

SCORE 6-7 (acceptable if repetitive knowledge work is clearly visible):
- Smaller but evidence of a recurring outbound, drafting, or intake process
- Staff who clearly spend time on research, writing, or data entry that repeats

SCORE 1-5 (reject):
- Sole operator with no staff doing repetitive knowledge work
- Pure consumer service with no outbound, intake, or document workflows
- Franchise or chain location — uses parent company systems
- 100+ employees — has internal AI/IT team
- No website or clearly a placeholder
- Software or SaaS company — builds their own tools
- No observable evidence of repetitive knowledge work

Business details:
- Name: ${business.name}
- Address: ${business.address}
- Website: ${business.website || 'none'}

Website content:
${websiteText || '(no website available — score conservatively)'}

Respond with JSON only:
{
  "score": <integer 1-10>,
  "notes": "<one specific sentence explaining why — reference something concrete from the website or business type, and name the agent use case if score is 6+>"
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

        const fresh = places.filter(place => {
          const name = place.displayName?.text || 'Unknown';
          const website = place.websiteUri || null;
          totalFound++;
          if (isDuplicate(dedup, name, website)) { totalSkipped++; return false; }
          return true;
        });

        const scraped = await Promise.all(
          fresh.map(async place => {
            const { email, text } = await scrapeWebsite(place.websiteUri || null);
            return { place, email, text };
          })
        );

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
