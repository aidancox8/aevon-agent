#!/usr/bin/env node
/**
 * cadre/hunter-contacts.js, a named HR contact per company from Hunter's domain search.
 *
 * One call per company returns the domain's email pattern and the people Hunter has on file,
 * filtered to the HR department, each with a title and a confidence score. For Maple Lodge Farms
 * (2026-09-09) that was five named HR staff at 96 to 99 percent from a site that publishes no
 * address at all. This is the name-plus-format method Aidan described, done by the vendor that
 * indexes it, and it is the first source that turns a "no email" lead into a person.
 *
 * Free plan: 50 searches a month, 100 verifications. So the order matters: highest
 * qualification score first, known size 100+ first, and one search per domain ever.
 *
 * Title ranking, because the pitch is records: HR Manager or Director, then People/HR Business
 * Partner, then Generalist or Coordinator or Administrator, then Talent/Recruiting, then anyone
 * in HR. Confidence under 85 is skipped, and a domain with no HR person is noted so it is never
 * searched again.
 *
 *   node cadre/hunter-contacts.js --dry --limit 3
 *   node cadre/hunter-contacts.js --limit 45
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const supabase = require('../lib/supabase');
const { excludedOrgReason } = require('../tempo/dnc');

const DRY = process.argv.includes('--dry');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > -1 ? parseInt(process.argv[i + 1], 10) : 10; })();
const MIN_CONF = 85;
const KEY = process.env.HUNTER_KEY;
if (!KEY) { console.error('HUNTER_KEY is not set'); process.exit(1); }

const RANK = [
  [/\b(chief people|vp|vice president|head of|director)\b.*\b(people|hr|human)|\b(people|hr|human)\b.*\b(director|vp|head)\b/i, 1],
  [/\b(hr|human resources|people)\b.*\bmanager\b|\bmanager\b.*\b(hr|human resources|people)\b/i, 2],
  [/business partner|hrbp/i, 3],
  [/\b(generalist|coordinator|administrator|advisor|specialist)\b/i, 4],
  [/talent|recruit|acquisition/i, 5],
];
function rankOf(position) {
  const p = String(position || '');
  for (const [re, r] of RANK) if (re.test(p)) return r;
  return 6;
}

function apexOf(website) {
  try {
    const h = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.toLowerCase().replace(/^www\./, '');
    const p = h.split('.');
    return p.length > 2 && p[p.length - 2].length <= 3 ? p.slice(-3).join('.') : p.slice(-2).join('.');
  } catch (e) { return null; }
}

async function account() {
  const r = await fetch(`https://api.hunter.io/v2/account?api_key=${KEY}`);
  const j = await r.json();
  return j.data ? j.data.requests : null;
}

async function domainSearch(domain) {
  const r = await fetch(`https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&department=hr&limit=10&api_key=${KEY}`);
  const j = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j.errors || j).slice(0, 160)}`);
  return j.data;
}

(async () => {
  const before = await account();
  if (!before) throw new Error('Hunter account check failed');
  const left = before.searches.remaining;
  console.log(`Hunter: ${left} searches and ${before.verifications.remaining} verifications left this month.`);
  const budget = Math.min(LIMIT, Math.max(0, left - 2));   // keep two in hand
  if (!budget) { console.log('No searches to spend.'); return; }

  // Leads that need a person: no email, or only a front-door address. Never one we searched before.
  const { data, error } = await supabase.from('cadre_leads')
    .select('id, business_name, website, email, email_quality, staff_estimate, qualification_score, notes, copy_locked')
    .eq('status', 'queued').not('website', 'is', null)
    .or('email.is.null,email_quality.eq.generic')
    .order('qualification_score', { ascending: false, nullsFirst: false })
    .limit(400);
  if (error) throw new Error(error.message);
  const seen = new Set();
  const todo = data.filter((l) => {
    if (/hunter-contacts:/.test(l.notes || '')) return false;
    if (excludedOrgReason(l.business_name, l.email)) return false;
    const apex = apexOf(l.website); if (!apex || seen.has(apex)) return false; seen.add(apex); return true;
  })
    // Known 100+ first, then unknown size, then anything else. Score already sorted within.
    .sort((a, b) => ((b.staff_estimate >= 100) - (a.staff_estimate >= 100)) || ((a.staff_estimate == null) - (b.staff_estimate == null)))
    .slice(0, budget);
  console.log(`${DRY ? 'DRY RUN: ' : ''}${todo.length} domain(s) to search.\n`);

  let found = 0, none = 0, used = 0;
  for (const lead of todo) {
    const apex = apexOf(lead.website);
    const tag = `${String(lead.business_name).slice(0, 28).padEnd(30)}${apex.padEnd(28)}`;
    let d;
    try { d = await domainSearch(apex); used++; }
    catch (e) { console.log(`  !    ${tag}${e.message}`); if (/429|limit/i.test(e.message)) break; continue; }
    const people = (d.emails || []).filter((e) => e.confidence >= MIN_CONF && e.first_name && e.last_name)
      .map((e) => ({ ...e, rank: rankOf(e.position) })).sort((a, b) => a.rank - b.rank || b.confidence - a.confidence);
    const pick = people[0];
    if (!pick) {
      none++;
      console.log(`  --   ${tag}no HR person at ${MIN_CONF}+ (${(d.emails || []).length} in dept, pattern ${d.pattern || '?'})`);
      if (!DRY) await supabase.from('cadre_leads').update({ email_hunt_attempted_at: new Date().toISOString(), notes: `${lead.notes ? lead.notes + '\n' : ''}hunter-contacts: no HR person on ${apex}, pattern ${d.pattern || 'unknown'}` }).eq('id', lead.id);
      continue;
    }
    found++;
    const name = `${pick.first_name} ${pick.last_name}`;
    console.log(`  ok   ${tag}${pick.value.padEnd(38)}${name}, ${pick.position || '?'} (${pick.confidence})${people.length > 1 ? `  +${people.length - 1}` : ''}`);
    if (DRY) continue;
    // Locked (hand-written) copy keeps its text and just gets the better address; generated copy
    // is cleared so the personalizer writes it again for a named person. The first run guarded
    // the whole update on copy_locked, wrote nothing for locked leads, and searched them twice.
    const u = {
      email: pick.value, email_quality: 'personal', contact_name: name, contact_role: pick.position || null,
      email_hunt_attempted_at: new Date().toISOString(),
      notes: `${lead.notes ? lead.notes + '\n' : ''}hunter-contacts: ${pick.value} conf ${pick.confidence}, pattern ${d.pattern || '?'}, ${people.length} HR people on file${lead.email ? `; replaced ${lead.email}` : ''}`,
    };
    if (!lead.copy_locked) Object.assign(u, { email_subject: null, email_body: null, scheduled_send_at: null });
    const { error: e } = await supabase.from('cadre_leads').update(u).eq('id', lead.id);
    if (e) console.log(`       write failed: ${e.message}`);
  }
  const after = await account();
  console.log(`\nfound ${found} | none ${none} | searches used ${used}, ${after ? after.searches.remaining : '?'} left this month.`);
  if (!DRY && found) console.log('Next: node cadre/personalizer.js --limit 100, then node cadre/schedule.js');
})().catch((e) => { console.error('hunter-contacts failed:', e.message); process.exit(1); });
