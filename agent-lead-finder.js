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
  const prompt = `You are a strict lead qualifier for Aevon, a company that builds custom AI agents for businesses in the Lower Mainland, BC. Your job is to identify businesses with high-volume, repetitive knowledge work that an AI agent could automate — outreach, research, drafting, routing, intake, scheduling, or reporting.

The ideal AI agent client has real operational volume, real staff doing repetitive work, and real budget. They are not looking for a SaaS subscription — they want a custom agent that runs their specific process.

IMPORTANT — healthcare clinics: Using JaneApp, an EMR, or a standard booking tool does NOT disqualify a clinic. Those tools only handle scheduling and clinical notes. Multi-disciplinary clinics (physio + massage + chiro + kinesiology + OT, etc.) still do ICBC/WCB billing, insurance pre-authorization, waitlist management, intake routing, and insurer reporting manually. These are exactly the workflows an AI agent automates. Multiple practitioners or locations = strong signal.

SCORE 8-10 (strong fit — save these):
- Active outbound BD teams: staffing agencies, recruiters, real estate teams, insurance brokers, mortgage brokers, business brokers doing ongoing prospecting and follow-up
- Agencies generating lots of written output: marketing, PR, content, advertising — writing proposals, reports, pitches, client updates repeatedly
- Professional services with high research/drafting volume: law firms doing research and document drafting, accountants generating reports, consultants writing proposals
- Multi-disciplinary health clinics with 3+ practitioners or 2+ locations — ICBC/WCB billing and multi-practitioner coordination are prime agent targets
- High-volume intake or scheduling: any business processing 30+ inbound inquiries or appointments per week
- Import/export, logistics, or freight companies routing documents and communications daily
- Evidence of budget: polished website, named staff, multiple service lines, established history

SCORE 6-7 (acceptable — save only if clear agent fit is visible):
- Smaller agencies or professional services firms with clear repetitive output needs
- Clinics with multiple practitioners or ICBC/WCB mentions even if modest size
- Property management companies with regular document and communication workflows

SCORE 1-5 (reject — do not save):
- Solo operators or owner-only businesses with no staff
- Pure consumer retail, restaurants, cafes, salons, gyms — no repetitive knowledge work
- Franchises of large chains — they use franchisor systems
- Enterprise companies (100+ staff) — they have internal AI/IT teams
- Businesses with no evidence of outbound, research, or document-heavy workflows
- Companies where the core work is already fully productized (e.g. a SaaS startup)
- No website or clearly a placeholder

A professional website alone is not enough — look for evidence of real volume and repetitive knowledge tasks. For clinics, ICBC/WCB billing, multiple modalities, or multiple locations are strong positive signals even if the business looks small.

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
