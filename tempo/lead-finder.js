/**
 * tempo/lead-finder.js
 * Finds multi-provider CLINICS in the Lower Mainland that likely schedule their
 * staff and rooms by hand (spreadsheets / paper), qualifies them with Gemini,
 * and stores them in the SEPARATE `tempo_leads` table.
 *
 * This is the Tempo (clinic-scheduling) campaign — a duplicate of the Aevon lead
 * finder, kept apart so the two never mix and you can switch back anytime.
 *
 * Usage:
 *   node tempo/lead-finder.js
 *   node tempo/lead-finder.js --query "physiotherapy clinic" --city "Surrey BC"
 *   node tempo/lead-finder.js --min-score 7 --pages 2
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const axios = require('axios');
const supabase = require('../lib/supabase');
const { createGenerate } = require('../lib/gemini');
const { findContact } = require('../lib/contact-finder');
const { dncReason } = require('./dnc');

const TABLE = 'tempo_leads';
const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
const generate = createGenerate(process.env.GEMINI_API_KEY_AGENT || process.env.GEMINI_API_KEY);
const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';

// Never prospect these — the user's employer + one explicit exclusion.
const EXCLUDE_NAMES = ['changepain', 'change pain', 'artus'];
// National chains run head-office scheduling systems — wrong ICP, skip at intake.
const CHAIN_NAMES = ['lifemark', 'pt health', 'pthealth', 'cbi health', 'myodetox', 'athletico', 'physiomobility', 'kinatex', 'proactive physiotherapy group'];
function isChain(name, website) {
  const n = (name || '').toLowerCase();
  const w = (website || '').toLowerCase();
  return CHAIN_NAMES.some(x => n.includes(x) || w.includes(x.replace(/\s+/g, '')));
}

function isExcluded(name, website) {
  const n = (name || '').toLowerCase();
  const w = (website || '').toLowerCase();
  return EXCLUDE_NAMES.some(x => n.includes(x) || w.includes(x.replace(/\s+/g, '')));
}

const CITIES_BC = [
  'Vancouver BC', 'Burnaby BC', 'Surrey BC', 'Richmond BC', 'Langley BC',
  'Coquitlam BC', 'Abbotsford BC', 'North Vancouver BC', 'New Westminster BC',
  'Delta BC', 'Port Coquitlam BC', 'West Vancouver BC', 'Maple Ridge BC', 'White Rock BC',
];
// National sweep (--region canada): major metros outside the Lower Mainland.
// Quebec deliberately excluded for now — Bill 96 French-language rules for
// commercial email make English cold outreach there a compliance question.
const CITIES_CANADA = [
  'Victoria BC', 'Kelowna BC', 'Kamloops BC', 'Nanaimo BC',
  'Calgary AB', 'Edmonton AB', 'Red Deer AB', 'Lethbridge AB',
  'Saskatoon SK', 'Regina SK', 'Winnipeg MB',
  'Toronto ON', 'Mississauga ON', 'Brampton ON', 'Hamilton ON', 'Ottawa ON',
  'London ON', 'Kitchener ON', 'Waterloo ON', 'Guelph ON', 'Burlington ON',
  'Oakville ON', 'Markham ON', 'Vaughan ON', 'Barrie ON', 'Oshawa ON',
  'Halifax NS', 'Moncton NB', 'Fredericton NB', 'Charlottetown PE', "St. John's NL",
];

// Multi-provider, room-based clinics — the practices whose staff/room scheduling
// is genuinely painful and usually lives in a spreadsheet. This is Tempo's market.
const SEARCH_QUERIES = [
  'multidisciplinary health clinic',
  'physiotherapy clinic',
  'chiropractic clinic',
  'rehabilitation clinic',
  'sports medicine clinic',
  'pain management clinic',
  'physical therapy and rehabilitation clinic',
  'orthopedic clinic',
  'ICBC rehabilitation clinic',
  'concussion clinic',
  'occupational therapy clinic',
  'kinesiology clinic',
  'wellness and rehabilitation clinic',
  'medical clinic',
  'family practice clinic',
  'walk-in medical clinic',
  'chiropractic and physiotherapy clinic',
  'naturopathic clinic',
  'spine and sports clinic',
  'integrated health clinic',
];

const CA_PROVINCES = new Set(['BC', 'AB', 'SK', 'MB', 'ON', 'QC', 'NS', 'NB', 'PE', 'NL', 'YT', 'NT', 'NU']);
function matchesRegion(addr, city) {
  const m = (city || '').trim().match(/\b([A-Z]{2})$/);
  if (!m) return false;
  const code = m[1];
  const inRegion = new RegExp(`\\b${code}\\b`).test(addr);
  if (CA_PROVINCES.has(code)) return inRegion && /canada/i.test(addr);
  return inRegion && /\bUSA\b|united states/i.test(addr);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { minScore: 7 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--query') result.query = args[++i];
    if (args[i] === '--city') result.city = args[++i];
    if (args[i] === '--min-score') result.minScore = parseInt(args[++i], 10);
    if (args[i] === '--pages') result.pages = parseInt(args[++i], 10);
    if (args[i] === '--region') result.region = args[++i]; // bc (default) | canada | all
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
      'X-Goog-FieldMask': ['places.displayName', 'places.formattedAddress', 'places.websiteUri', 'places.internationalPhoneNumber', 'nextPageToken'].join(','),
    },
  });
  return res.data;
}

const GEMINI_MIN_GAP = 4200;
let lastGeminiAt = 0;
async function geminiRateLimited(prompt) {
  const gap = Date.now() - lastGeminiAt;
  if (gap < GEMINI_MIN_GAP) await new Promise(r => setTimeout(r, GEMINI_MIN_GAP - gap));
  lastGeminiAt = Date.now();
  return generate(prompt);
}

// Score a clinic on FIT FOR TEMPO: does it have multiple providers + rooms whose
// weekly staff/room schedule is complex enough that a spreadsheet is painful?
async function qualifyLead(business, websiteText) {
  const prompt = `You are a lead qualifier for Tempo, a custom-built staff and room SCHEDULING app for multi-provider clinics. Score how well this clinic fits Tempo — i.e. how complex and manual their weekly STAFF + ROOM scheduling likely is.

Tempo replaces spreadsheet/paper scheduling. It builds the weekly grid of which provider is in which room on which day, sends SMS/email shift + on-call reminders, handles shift and on-call cover, syncs time off with payroll, and reports on room utilization. So the best fit is a clinic with MULTIPLE practitioners rotating across MULTIPLE rooms/service types.

IMPORTANT: having an EMR or an online patient-booking tool does NOT disqualify them. Those book PATIENTS. Tempo schedules STAFF and ROOMS — a different problem almost always still done in a spreadsheet.

SCORE 8-10 (strong fit):
- Clearly multiple practitioners / disciplines (e.g. physio + chiro + massage + kinesiology), or a sizeable medical group
- Multiple treatment rooms or service areas that providers rotate through
- Signs of shift work, on-call, or extended/weekend hours that need coverage planning
- Multiple locations
- Established: polished site, named team of several providers, years operating

SCORE 6-7 (acceptable):
- A handful of providers with some rotation or part-time staff whose schedule clearly takes coordination

SCORE 1-5 (reject):
- Solo practitioner or single provider (no staff scheduling problem)
- Franchise/chain location on head-office systems
- Pure consumer service with one room and one person
- No website or a placeholder
- A hospital or enterprise (200+ staff) with dedicated scheduling software/IT

Business details:
- Name: ${business.name}
- Address: ${business.address}
- Website: ${business.website || 'none'}

Website content:
${websiteText || '(no website available — score conservatively)'}

Respond with JSON only:
{
  "score": <integer 1-10>,
  "notes": "<one specific sentence: name the concrete signal (number/type of providers, rooms, locations, hours) and why they fit Tempo if 6+>"
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

function buildDedupSets(existing) {
  return {
    names: new Set((existing || []).map(r => r.business_name?.toLowerCase())),
    sites: new Set((existing || []).map(r => r.website?.toLowerCase()).filter(Boolean)),
  };
}
function isDuplicate({ names, sites }, businessName, website) {
  if (names.has(businessName.toLowerCase())) return true;
  if (website && sites.has(website.toLowerCase())) return true;
  return false;
}

async function run() {
  const args = parseArgs();
  const queries = args.query ? [args.query] : SEARCH_QUERIES.slice().sort(() => Math.random() - 0.5);
  const regionCities = args.region === 'canada' ? CITIES_CANADA
    : args.region === 'all' ? [...CITIES_BC, ...CITIES_CANADA]
    : CITIES_BC;
  const cities = args.city ? [args.city] : regionCities;
  const maxPages = args.pages || 1;
  const minScore = args.minScore;

  console.log(`[Tempo] Loading existing ${TABLE} for dedup...`);
  const { data: existing, error: dedupErr } = await supabase.from(TABLE).select('business_name, website');
  if (dedupErr) throw new Error(`Failed to load ${TABLE}: ${dedupErr.message} (did you run tempo/schema-tempo-leads.sql?)`);
  const dedup = buildDedupSets(existing);
  console.log(`  ${existing?.length || 0} existing clinic leads.\n`);

  let savedSinceRefresh = 0;
  async function refreshDedup() {
    const { data } = await supabase.from(TABLE).select('business_name, website');
    const fresh = buildDedupSets(data);
    dedup.names = fresh.names; dedup.sites = fresh.sites; savedSinceRefresh = 0;
  }

  let totalFound = 0, totalQualified = 0, totalSaved = 0, totalSkipped = 0, totalExcluded = 0;

  for (const query of queries) {
    for (const city of cities) {
      const fullQuery = `${query} ${city}`;
      console.log(`\nSearching: "${fullQuery}"`);
      let pageToken = null, page = 0;
      do {
        const data = await searchPlaces(fullQuery, pageToken);
        const places = data.places || [];
        pageToken = data.nextPageToken || null;
        page++;

        const fresh = places.filter(place => {
          const name = place.displayName?.text || 'Unknown';
          const website = place.websiteUri || null;
          totalFound++;
          if (isExcluded(name, website)) { totalExcluded++; return false; }       // Changepain / Artus
          if (!matchesRegion(place.formattedAddress || '', city)) { totalSkipped++; return false; }
          if (isDuplicate(dedup, name, website)) { totalSkipped++; return false; }
          return true;
        });

        const scraped = await Promise.all(fresh.map(async place => ({ place, contact: await findContact(place.websiteUri || null) })));

        for (const { place, contact } of scraped) {
          let { email, emailQuality, contactName, contactRole, text } = contact;
          // A scraped contact can be a Changepain person moonlighting at this
          // clinic — strip them at intake so they never enter the pipeline.
          const dnc = dncReason(contactName, email);
          if (dnc) {
            if (dncReason(null, email)) { email = null; emailQuality = null; }
            contactName = null; contactRole = null;
          }
          const name = place.displayName?.text || 'Unknown';
          const website = place.websiteUri || null;
          process.stdout.write(`  [${name}]... `);

          const { score, notes } = await qualifyLead({ name, address: place.formattedAddress, website }, text);
          if (score < minScore) { console.log(`skip (score ${score}/10: ${notes})`); continue; }

          totalQualified++;
          console.log(`score ${score}/10 | ${email || 'no email'}${emailQuality ? ' (' + emailQuality + ')' : ''}${contactName ? ' | ' + contactName : ''}`);

          const { error: insertErr } = await supabase.from(TABLE).insert({
            business_name: name, address: place.formattedAddress || null, phone: place.internationalPhoneNumber || null,
            website, email, email_quality: emailQuality, contact_name: contactName, contact_role: contactRole,
            industry: query, city, status: 'queued', sequence_step: 0,
            qualification_score: score, qualification_notes: notes, source: 'tempo:' + query,
          });
          if (insertErr) { console.log(`  (skipped duplicate in DB)`); continue; }

          dedup.names.add(name.toLowerCase());
          if (website) dedup.sites.add(website.toLowerCase());
          totalSaved++; savedSinceRefresh++;
          if (savedSinceRefresh >= 20) await refreshDedup();
        }
      } while (pageToken && page < maxPages);
    }
  }

  console.log(`\nDone.`);
  console.log(`Found: ${totalFound} | Qualified (${minScore}+): ${totalQualified} | Saved: ${totalSaved} | Skipped (dupe/geo): ${totalSkipped} | Excluded (Changepain/Artus): ${totalExcluded}`);
}

run().catch(err => { console.error('Fatal error:', err.message); process.exit(1); });
