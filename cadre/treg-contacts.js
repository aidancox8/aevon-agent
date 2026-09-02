#!/usr/bin/env node
/**
 * cadre/treg-contacts.js — put a NAME on a lead that only has a generic inbox.
 *
 * WHY. 39 of the first 49 Cadre sends went to info@ as "Hi there". A receptionist reading a
 * message that quotes a job ad, addressed to nobody, files it as a misdirected application.
 * The person who wrote that ad is the buyer. This finds them.
 *
 * Two metered calls per lead, both through treg.to (see lib/treg.js):
 *   1. findymail.search.employees   website + job titles -> name, title, LinkedIn URL   ~$0.02
 *   2. treg.people.email.find       LinkedIn URL -> work email                          ~$0.009
 * Measured 2026-09-02: step 1 charges even when it finds nobody. Budget accordingly.
 *
 * Writes contact_name and contact_role on a hit. Writes the found email ONLY at
 * status='needs_review' with email_quality='treg', never straight into the live queue, because
 * a source that has not been evaluated does not get to send unattended. Release with
 * cadre/hr-contacts.js --release after reading them.
 *
 *   node cadre/treg-contacts.js                      dry run, no calls, no spend
 *   node cadre/treg-contacts.js --run --limit 10 --budget 40     spends, needs TREG_ARMED=true
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const supabase = require('../lib/supabase');
const treg = require('../lib/treg');
const { excludedOrgReason } = require('../tempo/dnc');

const TABLE = 'cadre_leads';
const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const val = (f, d) => { const i = args.indexOf(`--${f}`); return i > -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const RUN = has('run');
const LIMIT = parseInt(val('limit', '10'), 10);
const BUDGET_CENTS = parseFloat(val('budget', '40'));

/** The person who keeps the training matrix. Never the owner, never sales. */
const JOB_TITLES = ['Human Resources', 'HR Manager', 'HR Coordinator', 'Health and Safety', 'Safety Manager', 'Compliance Manager', 'Training Coordinator', 'Training Manager'];

function apexOf(website) {
  try {
    const h = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.toLowerCase().replace(/^www\./, '');
    const p = h.split('.');
    return p.length > 2 && p[p.length - 2].length <= 3 ? p.slice(-3).join('.') : p.slice(-2).join('.');
  } catch (e) { return null; }
}

async function targets() {
  const { data, error } = await supabase.from(TABLE)
    .select('id, business_name, website, email, email_quality, qualification_score')
    .in('status', ['queued', 'needs_review'])
    .is('contact_name', null)
    .not('website', 'is', null)
    .order('qualification_score', { ascending: false, nullsFirst: false });
  if (error) throw new Error(error.message);
  const seen = new Set();
  return (data || []).filter((l) => {
    if (l.email_quality === 'personal') return false;       // already a named address
    if (excludedOrgReason(l.business_name, l.email)) return false;
    const apex = apexOf(l.website);
    if (!apex || seen.has(apex)) return false;
    seen.add(apex); l.apex = apex; return true;
  });
}

(async () => {
  const leads = await targets();
  const batch = leads.slice(0, LIMIT);
  console.log(`${leads.length} lead(s) have a generic or guessed address and no named contact.`);
  if (!RUN) {
    console.log('DRY RUN. No calls, no spend, no writes.\n');
    batch.forEach((l, i) => console.log(`  ${String(i + 1).padStart(3)}. ${String(l.business_name).slice(0, 36).padEnd(38)}${l.apex}`));
    console.log('\n  node cadre/treg-contacts.js --run --limit 10 --budget 40   (TREG_ARMED=true)');
    return;
  }
  if (!treg.ARMED) throw new Error('TREG_ARMED is not "true". Nothing was called.');

  const budget = treg.newBudget(BUDGET_CENTS);
  let named = 0, emailed = 0, spent = 0;
  console.log(`Running ${batch.length}, hard cap ${BUDGET_CENTS} cents. Balance $${(await treg.balance()).usd}.\n`);

  for (const lead of batch) {
    if (budget.spentMicro >= budget.capMicro) { console.log('  ! budget reached'); break; }
    const tag = String(lead.business_name).slice(0, 30).padEnd(32);
    try {
      const r1 = await treg.call('findymail.search.employees', {}, {
        method: 'POST', budget, body: { website: lead.apex, job_titles: JOB_TITLES, count: 1 },
      });
      spent += r1.costCents;
      const p = Array.isArray(r1.data) ? r1.data[0] : null;
      if (!p || !p.name) { console.log(`  --   ${tag}nobody with those titles   ${r1.costCents.toFixed(1)}c`); continue; }
      named += 1;
      const update = { contact_name: p.name, contact_role: p.jobTitle || null };

      let emailNote = 'no email found';
      if (p.linkedinUrl && budget.spentMicro < budget.capMicro) {
        try {
          const r2 = await treg.call('treg.people.email.find', {}, { method: 'POST', budget, body: { linkedin_url: p.linkedinUrl } });
          spent += r2.costCents;
          const blob = JSON.stringify(r2.data || {});
          const m = blob.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
          if (m) {
            emailed += 1;
            update.email = m[0].toLowerCase();
            update.email_quality = 'treg';
            update.status = 'needs_review';
            emailNote = m[0];
          }
        } catch (e) { emailNote = `email lookup: ${e.message}`; }
      }
      const { error } = await supabase.from(TABLE).update(update).eq('id', lead.id);
      console.log(`  ${error ? '!!' : 'ok'}   ${tag}${String(p.name).slice(0, 22).padEnd(24)}${String(p.jobTitle || '').slice(0, 26).padEnd(28)}${emailNote}`);
    } catch (e) {
      console.log(`  !    ${tag}${e.message}`);
      if (e.status === 402) break;
    }
  }
  console.log(`\nNamed ${named}, emailed ${emailed}, spent ${spent.toFixed(1)}c. Balance $${(await treg.balance()).usd}.`);
  if (emailed) console.log(`Found emails sit at status='needs_review'. Release: node cadre/hr-contacts.js --release <n>`);
})().catch((e) => { console.error('treg-contacts failed:', e.message); process.exit(1); });
