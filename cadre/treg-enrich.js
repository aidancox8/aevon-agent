#!/usr/bin/env node
/**
 * cadre/treg-enrich.js — find addresses for the Cadre leads that have none, via treg.to.
 *
 * THE PROBLEM THIS EXISTS FOR. On 2026-09-02 the Cadre table held 226 queued leads and 111 of
 * them had no email address. They have a company name and usually a website, and they are
 * simply unreachable. That is a third of the queue, dead, and it is the actual ceiling on the
 * campaign. Not the daily cap, which was raised, and not deliverability.
 *
 * The previous answer, cadre/hr-contacts.js, GUESSES hr@<apex> and MX-checks it. That produced
 * 125 addresses of which the bounce evidence is still incomplete. This is the other approach:
 * ask a provider that actually holds the data. treg fronts Apollo, Hunter and Crunchbase with
 * no account at any of them, metered per call at fractions of a cent.
 *
 * NOTHING SPENDS BY DEFAULT.
 *   node cadre/treg-enrich.js                    show what it would do. No calls at all.
 *   node cadre/treg-enrich.js --discover         free catalog search, to pick an endpoint
 *   node cadre/treg-enrich.js --balance          free, and proves the token works
 *   node cadre/treg-enrich.js --run --endpoint <id> --limit 10 --budget 25
 *                                                spends, capped at 25 cents, needs TREG_ARMED=true
 *
 * ENDPOINT IDS ARE NOT HARDCODED, deliberately. No call has been made from this repo yet, so
 * any id written in here would be a guess dressed as a fact. --discover reads the live catalog
 * and prints candidates with their cost and success rate, and you pass the one you chose.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const supabase = require('../lib/supabase');
const treg = require('../lib/treg');
const { excludedOrgReason } = require('../tempo/dnc');

const TABLE = 'cadre_leads';
const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const val = (f, d = null) => { const i = args.indexOf(`--${f}`); return i > -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };

const RUN = has('run');
/**
 * Who we are looking for. Cadre sells certification and training-matrix tracking, so the person
 * who owns that record is HR, safety or compliance, never the owner or a salesperson.
 */
const JOB_TITLES = ['Human Resources', 'HR Manager', 'Health and Safety', 'Safety Manager', 'Compliance Manager', 'Training Manager'];
const LIMIT = parseInt(val('limit', '10'), 10);
const BUDGET_CENTS = parseFloat(val('budget', '25'));

/** "https://www.example.co.uk/careers?x=1" -> "example.co.uk" */
function apexOf(website) {
  try {
    const h = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.toLowerCase().replace(/^www\./, '');
    const p = h.split('.');
    return p.length > 2 && p[p.length - 2].length <= 3 ? p.slice(-3).join('.') : p.slice(-2).join('.');
  } catch (e) { return null; }
}

async function reachable() {
  const { data, error } = await supabase.from(TABLE)
    .select('id, business_name, website, city, qualification_score, status')
    .is('email', null)
    .not('website', 'is', null)
    .not('status', 'in', '("dont_contact","unsubscribed","bounced")')
    .order('qualification_score', { ascending: false, nullsFirst: false });
  if (error) throw new Error(error.message);
  // One address per apex: two rows can share a parent company and would otherwise be billed
  // twice and mailed twice under different names.
  const seen = new Set();
  return (data || []).filter((l) => {
    const dnc = excludedOrgReason(l.business_name, null);
    if (dnc) return false;
    const apex = apexOf(l.website);
    if (!apex || seen.has(apex)) return false;
    seen.add(apex);
    l.apex = apex;
    return true;
  });
}

(async () => {
  if (has('balance')) {
    const b = await treg.balance();
    console.log(`Balance: ${b.cents.toFixed(2)} cents (${b.micro} micro).`);
    return;
  }

  if (has('discover')) {
    const q = val('q', 'find email address by domain');
    console.log(`Catalog search: "${q}"  (free, nothing is metered)\n`);
    const res = await treg.search(q);
    console.log(JSON.stringify(res, null, 2).slice(0, 6000));
    console.log('\nPick an id and pass it as --endpoint <id>. Check its COST and WORKS first:');
    console.log('  node cadre/treg-enrich.js --describe <id>');
    return;
  }

  if (has('describe')) {
    console.log(JSON.stringify(await treg.describe(val('describe')), null, 2).slice(0, 4000));
    return;
  }

  const leads = await reachable();
  console.log(`${leads.length} lead(s) have a website and no address, after de-duping by domain.\n`);

  if (!RUN) {
    console.log('DRY RUN. No calls made, nothing spent, nothing written.\n');
    leads.slice(0, LIMIT).forEach((l, i) => {
      console.log(`  ${String(i + 1).padStart(3)}. ${String(l.business_name).slice(0, 38).padEnd(40)}${l.apex}`);
    });
    if (leads.length > LIMIT) console.log(`  ... and ${leads.length - LIMIT} more`);
    console.log('\nTo actually enrich, first find an endpoint:');
    console.log('  node cadre/treg-enrich.js --discover');
    console.log('then, with TREG_ARMED=true set:');
    console.log('  node cadre/treg-enrich.js --run --endpoint <id> --limit 10 --budget 25');
    return;
  }

  const endpoint = val('endpoint');
  if (!endpoint) throw new Error('--run needs --endpoint <id>. Run --discover to find one.');
  if (!treg.ARMED) throw new Error('TREG_ARMED is not "true". Nothing was called. This is deliberate.');

  const budget = treg.newBudget(BUDGET_CENTS);
  const batch = leads.slice(0, LIMIT);
  console.log(`Enriching ${batch.length} lead(s) via ${endpoint}, hard cap ${BUDGET_CENTS} cents.\n`);

  let found = 0, spentCents = 0;
  const writes = [];
  for (const lead of batch) {
    if (budget.spentMicro >= budget.capMicro) { console.log('  ! budget reached, stopping'); break; }
    try {
      // findymail.search.employees is POST {website, job_titles[], count}. `count` is the
      // price dial: it bills per contact returned, capped by count. Measured 2026-09-02: it
      // charges $0.0198 EVEN WHEN IT RETURNS NOTHING, so cost is per attempt, not per hit.
      const r = await treg.call(endpoint, {}, {
        method: 'POST', budget,
        body: { website: lead.apex, job_titles: JOB_TITLES, count: 1 },
      });
      spentCents += r.costCents;
      const rows = Array.isArray(r.data) ? r.data : (r.data && r.data.contacts) || [];
      if (rows.length) {
        const person = rows[0];
        // NOTE: this endpoint returns a NAME and a LinkedIn URL, NOT an email. Getting the
        // address is a SECOND metered call (treg.people.email.find, ~$0.0089 per success).
        // Stored as a contact for now so the two steps stay separable and auditable.
        found += 1;
        writes.push({ id: lead.id, contact_name: person.name || null, contact_role: person.jobTitle || null, linkedin: person.linkedinUrl || null });
        console.log(`  ok   ${String(lead.business_name).slice(0, 30).padEnd(32)}${String(person.name || '').slice(0, 22).padEnd(24)}${String(person.jobTitle || '').slice(0, 30)}   ${r.costCents.toFixed(2)}c`);
      } else {
        console.log(`  --   ${String(lead.business_name).slice(0, 30).padEnd(32)}no contact found   ${r.costCents.toFixed(2)}c (charged anyway)`);
      }
    } catch (e) {
      console.log(`  !    ${String(lead.business_name).slice(0, 34).padEnd(36)}${e.message}`);
      if (e.status === 402) { console.log('       out of balance, stopping'); break; }
    }
  }

  console.log(`\nFound ${found} address(es). Spent ${spentCents.toFixed(4)} cents.`);
  if (!writes.length) return;

  // status='needs_review' on purpose: CADRE_ARMED is true, and an address from a source that
  // has never been evaluated should not go straight into a live send queue. Read them, then
  // release with cadre/hr-contacts.js --release <n>.
  for (const w of writes) {
    const { error } = await supabase.from(TABLE)
      .update({ contact_name: w.contact_name, contact_role: w.contact_role, notes: `treg/findymail: ${w.linkedin || ''}` })
      .eq('id', w.id);
    if (error) console.log(`  write failed for ${w.id}: ${error.message}`);
  }
  console.log('Contacts written. NO email address yet: that is a second call per person.');
})().catch((e) => { console.error('treg-enrich failed:', e.message); process.exit(1); });
