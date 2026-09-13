#!/usr/bin/env node
/**
 * cadre/import-from-aevon.js, the Aevon general list re-read for Cadre.
 *
 * The Aevon table holds 9,000 Lower Mainland businesses found by category on Google Places, most
 * of them far too small for Cadre (a dental clinic, a notary). But a few categories overlap the
 * Cadre profile (contractors, manufacturers, logistics, nonprofits, schools, care), and nobody
 * ever sized them. Apollo's company enrichment sizes a domain for free, so every Aevon lead in an
 * overlapping category gets a headcount, and the ones between 100 and 1,000 staff are copied into
 * cadre_leads with whatever contact the Aevon list already had. They carry no job posting, so
 * they take the industry template, and they are tagged so the two campaigns can be told apart.
 *
 * Leads that opted out, bounced or replied on the Aevon campaign are never copied.
 *
 *   node cadre/import-from-aevon.js --dry --limit 30
 *   node cadre/import-from-aevon.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const supabase = require('../lib/supabase');

const DRY = process.argv.includes('--dry');
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : dflt; };
const LIMIT = parseInt(arg('limit', '3000'), 10);
const KEY = process.env.APOLLO_API_KEY;
if (!KEY) { console.error('No APOLLO_API_KEY in .env'); process.exit(1); }

const CATEGORIES = [
  'general contractor', 'manufacturing company', 'plumbing company', 'HVAC company', 'field service company',
  'commercial landscaping company', 'moving company', 'logistics company', 'property management company',
  'private school', 'nonprofit organization', 'medical clinic', 'engineering firm', 'trucking company',
  'security company', 'senior care', 'home care', 'childcare', 'daycare', 'electrical contractor',
  'roofing company', 'construction company', 'warehouse', 'food manufacturer', 'cleaning company',
];
const OUT = ['replied', 'dont_contact', 'unsubscribed', 'bounced', 'converted'];
const apexOf = (w) => String(w || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FREEMAIL = /@(gmail|yahoo|hotmail|outlook|icloud|live|shaw|telus|aol)\./i;
const FRONT_DOOR = /^(info|contact|hello|office|admin|reception|sales|support|enquiries|inquiries)@/i;

(async () => {
  const { data: existing } = await supabase.from('cadre_leads').select('website, business_name');
  const have = new Set((existing || []).map((r) => apexOf(r.website)).filter(Boolean));
  const haveNames = new Set((existing || []).map((r) => String(r.business_name).toLowerCase()));

  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('leads')
      .select('id, business_name, website, email, contact_name, industry, city, address, status, notes')
      .in('industry', CATEGORIES).not('website', 'is', null).range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < 1000) break;
  }
  const todo = rows.filter((l) => !OUT.includes(l.status) && !/cadre-import:/.test(l.notes || ''))
    .filter((l) => { const a = apexOf(l.website); return a && !have.has(a) && !haveNames.has(String(l.business_name).toLowerCase()); })
    .slice(0, LIMIT);
  console.log(`${DRY ? 'DRY RUN: ' : ''}${rows.length} Aevon lead(s) in overlapping categories, ${todo.length} to size.\n`);

  let inBand = 0, small = 0, big = 0, none = 0, copied = 0;
  const seen = new Set();
  for (const l of todo) {
    const apex = apexOf(l.website);
    if (seen.has(apex)) continue; seen.add(apex);
    let org = null;
    try {
      const r = await fetch(`https://api.apollo.io/api/v1/organizations/enrich?domain=${encodeURIComponent(apex)}`, { headers: { 'x-api-key': KEY, 'Cache-Control': 'no-cache' } });
      if (r.status === 429) { console.log('  !!   rate limited, waiting 60s'); await sleep(60000); continue; }
      org = r.status === 200 ? (await r.json()).organization : null;
    } catch (e) { console.log(`  !!   ${l.business_name}  ${e.message}`); continue; }
    await sleep(400);
    const n = org && org.estimated_num_employees;
    const tag = String(l.business_name).slice(0, 34).padEnd(36);
    if (!n) { none++; if (!DRY) await supabase.from('leads').update({ notes: `${l.notes ? l.notes + ' | ' : ''}cadre-import: no size` }).eq('id', l.id); continue; }
    if (n < 100) { small++; if (!DRY) await supabase.from('leads').update({ notes: `${l.notes ? l.notes + ' | ' : ''}cadre-import: ${n} staff, too small` }).eq('id', l.id); continue; }
    if (n > 1000) { big++; console.log(`  --   ${tag}${String(n).padStart(6)}  over 1,000`); if (!DRY) await supabase.from('leads').update({ notes: `${l.notes ? l.notes + ' | ' : ''}cadre-import: ${n} staff, too big` }).eq('id', l.id); continue; }
    inBand++;
    const email = l.email && !FREEMAIL.test(l.email) ? l.email : null;
    const quality = !email ? null : FRONT_DOOR.test(email) ? 'generic' : 'personal';
    console.log(`  ok   ${tag}${String(n).padStart(6)}  ${(org.industry || '').slice(0, 22).padEnd(24)}${(l.contact_name || '-').slice(0, 20).padEnd(22)}${email || '-'}`);
    if (DRY) continue;
    const { error: e } = await supabase.from('cadre_leads').insert({
      business_name: l.business_name, website: l.website, city: l.city || null, address: l.address || null,
      industry: l.industry, source: 'aevon-list', staff_estimate: n,
      contact_name: l.contact_name || null, email, email_quality: quality,
      signal_type: 'title', signal_quote: null, signal_url: null, personalization_basis: 'industry-template',
      qualification_score: 6, status: 'queued',
      notes: `aevon-list: copied from leads ${l.id}; size-from-apollo: ~${n} staff (Apollo estimate for ${apex}, ${org.industry || 'industry unknown'}); industry ${org.industry || l.industry}`,
    });
    if (e) { console.log(`       insert failed: ${e.message}`); continue; }
    copied++;
    await supabase.from('leads').update({ notes: `${l.notes ? l.notes + ' | ' : ''}cadre-import: copied to cadre_leads (${n} staff)` }).eq('id', l.id);
  }
  console.log(`\nin band ${inBand} (copied ${copied}) | under 100: ${small} | over 1,000: ${big} | no size: ${none}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
