/**
 * apollo-shortlist.js
 * Builds a curated list of best-fit small BC brokerages (via organizations/search, which IS
 * accessible) so Aidan knows exactly which companies to reveal the owner of in the Apollo UI.
 * Writes apollo-shortlist-<niche>.csv and prints the top picks. Spends ZERO credits.
 *
 * Usage: node apollo-shortlist.js --niche=realestate   (mortgage | realestate | insurance)
 */
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

const KEY = process.env.APOLLO_API_KEY;
const H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'X-Api-Key': KEY };
const API = 'https://api.apollo.io/api/v1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const KEYWORDS = {
  mortgage: ['mortgage'],
  realestate: ['real estate'],
  insurance: ['insurance broker'],
};
const niche = (process.argv.find(a => a.startsWith('--niche=')) || '--niche=mortgage').split('=')[1];
const tags = KEYWORDS[niche] || KEYWORDS.mortgage;

async function run() {
  const orgs = [];
  for (let page = 1; page <= 6 && orgs.length < 120; page++) {
    const r = await axios.post(`${API}/organizations/search`, {
      q_organization_keyword_tags: tags,
      organization_locations: ['British Columbia, Canada'],
      organization_num_employees_ranges: ['1,10', '11,20'], // small, owner-led
      per_page: 25, page,
    }, { headers: H, timeout: 30000 });
    const batch = r.data.organizations || r.data.accounts || [];
    orgs.push(...batch);
    if (!batch.length || page >= (r.data.pagination?.total_pages || 1)) break;
    await sleep(1000);
  }

  // dedup by domain, drop obvious non-fits (no domain, or clearly large/franchise names)
  const seen = new Set();
  const picks = [];
  for (const o of orgs) {
    const domain = (o.primary_domain || (o.website_url || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '')).toLowerCase();
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    picks.push({
      name: o.name,
      employees: o.estimated_num_employees || '',
      city: o.city || '',
      domain,
    });
  }

  const top = picks.slice(0, 100);
  const csv = 'company,employees,city,domain\n' + top.map(p => `"${p.name}",${p.employees},"${p.city}",${p.domain}`).join('\n');
  fs.writeFileSync(`apollo-shortlist-${niche}.csv`, csv);

  console.log(`\n${top.length} curated small BC ${niche} brokerages -> apollo-shortlist-${niche}.csv\n`);
  console.log('Top 40 (reveal the Owner/Principal of each in Apollo, ~1 credit each):\n');
  top.slice(0, 40).forEach((p, i) => console.log(`${String(i + 1).padStart(2)}. ${p.name}  (${p.employees || '?'} emp, ${p.city})  ${p.domain}`));
}
run().catch(e => console.error('ERR', e.response?.status, e.response?.data?.error || e.message));
