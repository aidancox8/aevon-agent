/**
 * tempo/enrich-list.js
 * Fallback lead source for when the Google Places key is down (403): takes a hand /
 * web-search-built list of clinic {name, website, city} in seed-clinics.json, scrapes
 * each site for a contact email, qualifies it with Gemini, and saves fits to tempo_leads.
 * No Google Places API needed — only site scraping + Gemini (which work).
 *
 * Usage:
 *   node tempo/enrich-list.js                    # uses tempo/seed-clinics.json, score 6+
 *   node tempo/enrich-list.js --file mylist.json --min-score 7
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const supabase = require('../lib/supabase');
const { createGenerate } = require('../lib/gemini');
const { findContact } = require('../lib/contact-finder');

const TABLE = 'tempo_leads';
const generate = createGenerate(process.env.GEMINI_API_KEY_AGENT || process.env.GEMINI_API_KEY);

const EXCLUDE_NAMES = ['changepain', 'change pain', 'artus'];
const isExcluded = (name, website) => {
  const n = (name || '').toLowerCase(), w = (website || '').toLowerCase();
  return EXCLUDE_NAMES.some(x => n.includes(x) || w.includes(x.replace(/\s+/g, '')));
};

const GEMINI_MIN_GAP = 4200;
let lastGeminiAt = 0;
async function geminiRateLimited(prompt) {
  const gap = Date.now() - lastGeminiAt;
  if (gap < GEMINI_MIN_GAP) await new Promise(r => setTimeout(r, GEMINI_MIN_GAP - gap));
  lastGeminiAt = Date.now();
  return generate(prompt);
}

async function qualifyLead(business, websiteText) {
  const prompt = `You are a lead qualifier for Tempo, a custom-built staff and room SCHEDULING app for multi-provider clinics. Score how well this clinic fits Tempo — i.e. how complex and manual their weekly STAFF + ROOM scheduling likely is.

Tempo replaces spreadsheet/paper scheduling. It builds the weekly grid of which provider is in which room on which day, sends SMS/email shift + on-call reminders, handles cover, syncs time off with payroll, and reports on room utilization. Best fit: a clinic with MULTIPLE practitioners rotating across MULTIPLE rooms/service types. Having an EMR or patient-booking tool does NOT disqualify — those book PATIENTS; Tempo schedules STAFF and ROOMS.

SCORE 8-10: clearly multiple practitioners/disciplines, multiple rooms, shift/on-call/weekend hours, or multiple locations; established.
SCORE 6-7: a handful of providers with rotation or part-time staff needing coordination.
SCORE 1-5: solo/single provider; franchise on head-office systems; one room/one person; no site; hospital/enterprise.

Business details:
- Name: ${business.name}
- Address: ${business.address || business.city}
- Website: ${business.website || 'none'}

Website content:
${websiteText || '(no website text — score conservatively)'}

Respond with JSON only:
{ "score": <integer 1-10>, "notes": "<one specific sentence naming the concrete signal (providers, rooms, locations, hours) and why they fit Tempo if 6+>" }`;
  try {
    const raw = await geminiRateLimited(prompt);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return { score: 5, notes: 'Could not parse qualification response' };
    return JSON.parse(match[0]);
  } catch (err) { return { score: 0, notes: `Gemini error: ${err.message}` }; }
}

async function run() {
  const args = process.argv.slice(2);
  let file = path.join(__dirname, 'seed-clinics.json');
  let minScore = 6;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file') file = args[++i];
    if (args[i] === '--min-score') minScore = parseInt(args[++i], 10);
  }

  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`[Tempo enrich] ${list.length} clinics from ${path.basename(file)}\n`);

  const { data: existing } = await supabase.from(TABLE).select('business_name, website');
  const seenNames = new Set((existing || []).map(r => (r.business_name || '').toLowerCase()));
  const seenSites = new Set((existing || []).map(r => (r.website || '').toLowerCase()).filter(Boolean));

  let saved = 0, skipped = 0, excluded = 0, lowscore = 0;
  for (const c of list) {
    process.stdout.write(`  [${c.name}]... `);
    if (isExcluded(c.name, c.website)) { console.log('EXCLUDED'); excluded++; continue; }
    if (seenNames.has(c.name.toLowerCase()) || (c.website && seenSites.has(c.website.toLowerCase()))) { console.log('dupe'); skipped++; continue; }

    let contact = { email: null, emailQuality: null, contactName: null, contactRole: null, text: '' };
    try { contact = await findContact(c.website); } catch { /* keep defaults */ }
    const { score, notes } = await qualifyLead(c, contact.text);
    if (score < minScore) { console.log(`skip (score ${score}/10)`); lowscore++; continue; }

    const { error } = await supabase.from(TABLE).insert({
      business_name: c.name, website: c.website || null, city: c.city || null,
      email: contact.email, email_quality: contact.emailQuality,
      contact_name: contact.contactName, contact_role: contact.contactRole,
      industry: 'multidisciplinary clinic', status: 'queued', sequence_step: 0,
      qualification_score: score, qualification_notes: notes, source: 'tempo:web-enrich',
    });
    if (error) { console.log(`  (db skip: ${error.message})`); skipped++; continue; }
    seenNames.add(c.name.toLowerCase());
    if (c.website) seenSites.add(c.website.toLowerCase());
    console.log(`saved score ${score}/10 | ${contact.email || 'no email found'}`);
    saved++;
  }
  console.log(`\nDone. Saved: ${saved} | Low-score: ${lowscore} | Dupe: ${skipped} | Excluded: ${excluded}`);
}

run().catch(err => { console.error('Fatal error:', err.message); process.exit(1); });
