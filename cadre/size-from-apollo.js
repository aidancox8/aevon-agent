#!/usr/bin/env node
/**
 * cadre/size-from-apollo.js, headcount for every lead with a website, from Apollo's company
 * enrichment endpoint, which the free plan still serves (checked 2026-09-12: people search and
 * people match return 403 "not included in your Free plan"; organizations/enrich returns 200
 * with estimated_num_employees, industry, city, state, country). No credits are charged for it
 * on the free plan as far as the response shows; the run prints the count of calls so a charge
 * would be visible against the account's credit balance.
 *
 * Apollo's figure is an estimate (mostly LinkedIn-derived), so it is stored as one: the note
 * says where it came from and the sender's gates treat it like any other estimate.
 *
 *   node cadre/size-from-apollo.js --dry --limit 20
 *   node cadre/size-from-apollo.js --limit 400
 *   node cadre/size-from-apollo.js --all        also re-check leads that already have a size
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const supabase = require('../lib/supabase');

const DRY = process.argv.includes('--dry');
const ALL = process.argv.includes('--all');
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : dflt; };
const LIMIT = parseInt(arg('limit', '400'), 10);
const KEY = process.env.APOLLO_API_KEY;
if (!KEY) { console.error('No APOLLO_API_KEY in .env'); process.exit(1); }

const apexOf = (w) => String(w || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let q = supabase.from('cadre_leads')
    .select('id, business_name, website, staff_estimate, notes, status')
    .in('status', ['queued', 'needs_review', 'sent'])
    .not('website', 'is', null)
    .order('qualification_score', { ascending: false, nullsFirst: false })
    .limit(2000);
  if (!ALL) q = q.is('staff_estimate', null);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const todo = data.filter((l) => !/size-from-apollo:/.test(l.notes || '')).slice(0, LIMIT);
  console.log(`${DRY ? 'DRY RUN: ' : ''}${data.length} candidate(s), ${todo.length} to look up.\n`);

  let sized = 0, none = 0, failed = 0, calls = 0;
  const cache = new Map();
  for (const lead of todo) {
    const apex = apexOf(lead.website);
    if (!apex) { none++; continue; }
    let org = cache.get(apex);
    if (org === undefined) {
      try {
        const r = await fetch(`https://api.apollo.io/api/v1/organizations/enrich?domain=${encodeURIComponent(apex)}`,
          { headers: { 'x-api-key': KEY, 'Cache-Control': 'no-cache' } });
        calls++;
        if (r.status === 429) { console.log('  !!   rate limited, waiting 60s'); await sleep(60000); cache.set(apex, undefined); continue; }
        const j = r.status === 200 ? await r.json() : null;
        org = (j && j.organization) || null;
      } catch (e) { org = null; failed++; console.log(`  !!   ${lead.business_name.slice(0, 34).padEnd(36)}${e.message}`); continue; }
      cache.set(apex, org);
      await sleep(400);
    }
    const n = org && org.estimated_num_employees;
    if (!n) {
      none++;
      console.log(`  --   ${lead.business_name.slice(0, 34).padEnd(36)}no figure for ${apex}`);
      if (!DRY) await supabase.from('cadre_leads').update({ notes: `${lead.notes ? lead.notes + ' | ' : ''}size-from-apollo: no figure for ${apex}` }).eq('id', lead.id);
      continue;
    }
    sized++;
    const where = [org.city, org.state, org.country].filter(Boolean).join(', ');
    console.log(`  ok   ${lead.business_name.slice(0, 34).padEnd(36)}${String(n).padStart(6)}   ${(org.industry || '').slice(0, 24).padEnd(26)}${where}`);
    if (!DRY) {
      await supabase.from('cadre_leads').update({
        staff_estimate: n,
        notes: `${lead.notes ? lead.notes + ' | ' : ''}size-from-apollo: ~${n} staff (Apollo estimate for ${apex}, ${org.industry || 'industry unknown'}, ${where})`,
      }).eq('id', lead.id);
    }
  }
  console.log(`\nsized ${sized} | no figure ${none} | failed ${failed} | API calls ${calls}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
