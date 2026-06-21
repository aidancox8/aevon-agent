/**
 * apollo-pipeline.js
 * Pulls verified named decision-makers from Apollo and loads them as leads so they
 * flow through the existing personalizer (demo-offer hook) + sender, tagged as an
 * "apollo" cohort for clean A/B measurement vs the scraped baseline.
 *
 * TWO MODES (because endpoint access depends on plan tier):
 *
 *   --mode=discover  (default)  Fully automated. mixed_people/search -> people/bulk_match.
 *                               Needs the People API (blocked on Basic; expected on
 *                               Professional trial). Run --dry-run first to confirm.
 *
 *   --mode=contacts             Guaranteed fallback. You search + reveal contacts in the
 *                               Apollo UI and save them to a List, then this pulls them
 *                               via contacts/search (confirmed accessible) and loads them.
 *                               Use --list="LIST NAME".
 *
 * Confirmed on the current key: organizations/search works (815 BC mortgage orgs),
 * contacts/search works. mixed_people/search, people/match, people/bulk_match are 403
 * on Basic and should unlock on Professional.
 *
 * Usage:
 *   node apollo-pipeline.js --mode=discover --niche=mortgage --dry-run   # test the trial's People API safely
 *   node apollo-pipeline.js --mode=discover --niche=mortgage --limit=100 # live insert
 *   node apollo-pipeline.js --mode=contacts --list="Aevon test" --niche=mortgage --dry-run
 *
 * ALWAYS run --dry-run first. It prints what WOULD be inserted and writes nothing.
 */
require('dotenv').config();
const axios = require('axios');
const supabase = require('./lib/supabase');

const KEY = process.env.APOLLO_API_KEY;
if (!KEY) { console.error('No APOLLO_API_KEY in .env'); process.exit(1); }

const API = 'https://api.apollo.io/api/v1';
const H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'X-Api-Key': KEY };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PLACEHOLDER = /not_unlocked|email_not_unlocked|@domain\.com$/i;

// `industry` MUST contain a word demoFit() in personalizer.js matches (insurance |
// mortgage | real estate/realtor/realty) so the Apollo cohort gets the demo-offer hook.
const NICHES = {
  mortgage: {
    industry: 'mortgage broker',
    person_titles: ['Owner', 'Principal Broker', 'Managing Broker', 'Broker Owner', 'Mortgage Broker', 'President', 'Founder', 'Managing Partner'],
    person_seniorities: ['owner', 'founder', 'partner', 'c_suite'],
    q_keywords: 'mortgage',
  },
  realestate: {
    industry: 'real estate brokerage',
    person_titles: ['Owner', 'Managing Broker', 'Broker Owner', 'Realtor', 'Real Estate Broker', 'President', 'Founder'],
    person_seniorities: ['owner', 'founder', 'partner', 'c_suite'],
    q_keywords: 'real estate brokerage',
  },
  insurance: {
    industry: 'insurance brokerage',
    person_titles: ['Owner', 'Principal', 'Managing Partner', 'President', 'Founder', 'Insurance Broker'],
    person_seniorities: ['owner', 'founder', 'partner', 'c_suite'],
    q_keywords: 'insurance brokerage',
  },
};

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const arg = (k, d) => { const a = args.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const MODE = arg('mode', 'discover');
const nicheArg = arg('niche', 'mortgage');
const LIMIT = parseInt(arg('limit', '100'), 10);
const LIST = arg('list', null);
const niche = NICHES[nicheArg];
if (!niche) { console.error('Unknown niche. Use mortgage | realestate | insurance'); process.exit(1); }

function bestEmail(m) {
  if (m.email && !PLACEHOLDER.test(m.email)) return m.email.toLowerCase();
  const pe = (m.personal_emails || []).find(e => e && !PLACEHOLDER.test(e));
  return pe ? pe.toLowerCase() : null;
}

function toLead(m) {
  const email = bestEmail(m);
  if (!email) return null;
  return {
    business_name: m.organization?.name || m.account?.name || m.organization_name || m.account_name || 'Unknown',
    email,
    email_quality: 'personal',
    contact_name: m.name || [m.first_name, m.last_name].filter(Boolean).join(' '),
    contact_role: m.title || null,
    website: m.organization?.website_url || (m.organization?.primary_domain ? 'https://' + m.organization.primary_domain : null),
    city: m.city || m.organization?.city || null,
    industry: niche.industry,
    status: 'queued',
    sequence_step: 0,
    qualification_score: 8,
    qualification_notes: 'Apollo verified decision-maker (trial cohort)',
    source: `apollo-${nicheArg}`,
    _state: (m.state || m.organization?.state || '').toLowerCase(),
    _country: (m.country || m.organization?.country || '').toLowerCase(),
  };
}

// ---- DISCOVER: People Search (no emails) -> Bulk Enrich (emails, 1 credit each) ----
async function discover(target) {
  const found = [];
  let page = 1;
  while (found.length < target && page <= 10) {
    const body = {
      person_titles: niche.person_titles, person_seniorities: niche.person_seniorities,
      person_locations: ['British Columbia, Canada'],
      organization_num_employees_ranges: ['1,10', '11,20', '21,50'],
      q_keywords: niche.q_keywords, page, per_page: 100,
    };
    const res = await axios.post(`${API}/mixed_people/search`, body, { headers: H, timeout: 30000 });
    const batch = res.data.people || [];
    const pag = res.data.pagination || {};
    if (page === 1) console.log(`search: ${pag.total_entries ?? '?'} total matches`);
    found.push(...batch);
    if (!batch.length || page >= (pag.total_pages || 1)) break;
    page++; await sleep(1200);
  }
  const people = found.slice(0, target);
  console.log(`enriching ${people.length} for emails...`);
  const out = [];
  for (let i = 0; i < people.length; i += 10) {
    const chunk = people.slice(i, i + 10);
    const details = chunk.map(p => ({
      id: p.id, first_name: p.first_name, last_name: p.last_name,
      organization_name: p.organization?.name,
      domain: p.organization?.primary_domain || (p.organization?.website_url || '').replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
    }));
    try {
      const res = await axios.post(`${API}/people/bulk_match`, { reveal_personal_emails: true, details }, { headers: H, timeout: 30000 });
      (res.data.matches || res.data.people || []).forEach(m => m && out.push(m));
      process.stdout.write(`  enriched ${Math.min(i + 10, people.length)}/${people.length}\r`);
    } catch (e) { console.error(`\n  enrich batch ${i} failed: ${e.response?.status} ${(e.response?.data?.error || '').slice(0, 80)}`); }
    await sleep(1200);
  }
  console.log('');
  return out;
}

// ---- CONTACTS: pull contacts you already revealed + saved in the Apollo UI ----
async function contacts() {
  const out = [];
  let page = 1;
  while (page <= 10) {
    const body = { page, per_page: 100 };
    if (LIST) body.contact_label_names = [LIST];
    const res = await axios.post(`${API}/contacts/search`, body, { headers: H, timeout: 30000 });
    const batch = res.data.contacts || [];
    const pag = res.data.pagination || {};
    if (page === 1) console.log(`contacts/search: ${pag.total_entries ?? 0} saved contacts${LIST ? ` in list "${LIST}"` : ''}`);
    out.push(...batch);
    if (!batch.length || page >= (pag.total_pages || 1)) break;
    page++; await sleep(800);
  }
  return out.slice(0, LIMIT);
}

async function run() {
  console.log(`\n=== Apollo pipeline | mode=${MODE} | niche=${nicheArg} | limit=${LIMIT} | ${DRY ? 'DRY RUN (no DB writes)' : 'LIVE (will insert)'} ===\n`);

  let raw;
  try {
    raw = MODE === 'contacts' ? await contacts() : await discover(LIMIT);
  } catch (e) {
    const s = e.response?.status;
    console.error(`\n${MODE} failed: ${s} ${(e.response?.data?.error || e.message || '').slice(0, 120)}`);
    if (s === 403) console.error(`This endpoint is not on your plan. If on the trial, try --mode=contacts (reveal in UI first), or confirm the People API is enabled.`);
    process.exit(1);
  }

  let leads = raw.map(toLead).filter(Boolean);
  // Geography guard: keep BC / Canada only when the field is present.
  leads = leads.filter(c => (!c._country || /canada/.test(c._country)) && (!c._state || /(bc|british columbia)/.test(c._state)));
  leads.forEach(c => { delete c._state; delete c._country; });
  console.log(`${leads.length} candidates with a real email.`);

  const { data: existing } = await supabase.from('leads').select('email');
  const have = new Set((existing || []).map(r => (r.email || '').toLowerCase()));
  const fresh = leads.filter(c => !have.has(c.email));
  console.log(`${fresh.length} are new (not already in the DB).`);

  console.log('\n--- sample (first 12) ---');
  fresh.slice(0, 12).forEach((c, i) => console.log(`${i + 1}. ${c.contact_name} | ${c.contact_role || ''} @ ${c.business_name} | ${c.email} | ${c.city || ''}`));

  if (DRY) { console.log(`\nDRY RUN complete. Would insert ${fresh.length} leads tagged source='apollo-${nicheArg}'. Re-run without --dry-run to insert.`); return; }
  if (!fresh.length) { console.log('\nNothing new to insert.'); return; }
  const { error } = await supabase.from('leads').insert(fresh);
  if (error) { console.error('INSERT failed:', error.message); return; }
  console.log(`\nInserted ${fresh.length} Apollo leads (status=queued, source=apollo-${nicheArg}).`);
  console.log(`Next: 6am personalizer writes demo-offer copy (named-first), sender emails them. Measure with: node apollo-report.js`);
}

run().catch(e => { console.error('Fatal:', e.response?.status, (e.response?.data?.error) || e.message); process.exit(1); });
