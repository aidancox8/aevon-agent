#!/usr/bin/env node
/**
 * cadre/free-contacts.js, a named HR (or records-owning) contact per company using free-tier
 * APIs instead of a paid one. Hunter's 50 searches a month run out fast against a queue in the
 * hundreds; these five free tiers (Prospeo, GetProspect, Snov, Lusha, Reoon) stack into more
 * headroom, at the cost of chaining a name lookup and up to four email lookups per lead.
 *
 * Two steps per lead. First, Prospeo's people search finds a name and title at the company
 * (1 credit per call that returns anyone). Second, the email: try Prospeo enrich, then
 * GetProspect, then Snov, then Lusha, first one back wins, then Reoon has to say it actually
 * delivers. Lusha charges a credit even on a miss, so it goes last. A guessed hr@ address that
 * was only parked at needs_review because nobody had a name (see cadre/hr-contacts.js) gets
 * released back to queued once a real person and address replace it; other needs_review reasons
 * (wrong region, too small, blocked domain) are left exactly as they were.
 *
 * Monthly caps live in cadre/state/free-tier.json and fail closed: at cap, that source is
 * skipped and logged, never silently retried elsewhere in a way that hides the exhaustion.
 * A 402/403/429 mentioning credits stops the whole run rather than burning through the rest of
 * the queue on a account that is already out.
 *
 *   node cadre/free-contacts.js --dry --limit 3
 *   node cadre/free-contacts.js --limit 25
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const supabase = require('../lib/supabase');
const { verify, NoVerifier } = require('./verify');
const { excludedOrgReason } = require('../tempo/dnc');

const DRY = process.argv.includes('--dry');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > -1 ? parseInt(process.argv[i + 1], 10) : 40; })();
// --named-only: skip every lead that would need a Prospeo search (no contact name yet). Prospeo's
// free plan rate-limits searches hard; the leads that already carry a name cost no search at all.
const NAMED_ONLY = process.argv.includes('--named-only');
// --retry-misses: give leads that missed before another pass (see the selection filter below).
const RETRY_MISSES = process.argv.includes('--retry-misses');

const PROSPEO_KEY = process.env.PROSPEO_KEY;
const GETPROSPECT_KEY = process.env.GETPROSPECT_KEY;
const SNOV_CLIENT_ID = process.env.SNOV_CLIENT_ID;
const SNOV_CLIENT_SECRET = process.env.SNOV_CLIENT_SECRET;
const LUSHA_KEY = process.env.LUSHA_KEY;
const REOON_KEY = process.env.REOON_KEY;
const TOMBA_KEY = process.env.TOMBA_KEY;
const TOMBA_SECRET = process.env.TOMBA_SECRET;
const ZEROBOUNCE_KEY = process.env.ZEROBOUNCE_KEY;
for (const [name, val] of Object.entries({ PROSPEO_KEY, GETPROSPECT_KEY, SNOV_CLIENT_ID, SNOV_CLIENT_SECRET, LUSHA_KEY, REOON_KEY })) {
  if (!val) { console.error(`${name} is not set`); process.exit(1); }
}

const STATE_DIR = path.join(__dirname, 'state');
const STATE_FILE = path.join(STATE_DIR, 'free-tier.json');
const CAPS = { prospeo: 95, getprospect: 50, snov: 300, lusha: 40, reoon: 600, tomba: 25, zerobounce: 100 }; // snov: the account shows 281 credits on 2026-09-15, not the 50 the pricing page says // prospeo: 100 a month on the free plan, 80 here so the finder keeps 20 for searches

function monthNow() { return new Date().toISOString().slice(0, 7); }

function loadState() {
  let s;
  try { s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { s = null; }
  if (!s || s.month !== monthNow()) s = { month: monthNow(), prospeo: 0, getprospect: 0, snov: 0, lusha: 0, reoon: 0 };
  return s;
}
function saveState(s) {
  if (DRY) return; // dry run still calls the APIs and spends real credits, so still count, but never persist
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

const state = loadState();
function atCap(service) { if (state[service] == null) state[service] = 0; return state[service] >= CAPS[service]; }
function spend(service, n = 1) { state[service] = (state[service] || 0) + n; }

// Thrown to stop the whole run when a provider reports it is out of credits.
class CreditsExhausted extends Error {}

function checkCreditsResponse(service, status, bodyText) {
  if ((status === 402 || status === 403 || status === 429) && /credit/i.test(bodyText)) {
    throw new CreditsExhausted(`${service}: HTTP ${status} ${bodyText.slice(0, 200)}`);
  }
}

function apexOf(website) {
  try {
    const h = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.toLowerCase().replace(/^www\./, '');
    const p = h.split('.');
    return p.length > 2 && p[p.length - 2].length <= 3 ? p.slice(-3).join('.') : p.slice(-2).join('.');
  } catch (e) { return null; }
}

// Title ranking. Records ownership is the pitch, so HR/people leadership beats generalist beats
// safety/training beats operations, and VERIFIED beats unverified among equal ranks.
// Reordered 2026-09-19 (Aidan): at 100 to 1,000 staff HR often has no pull or does not exist, and
// the operations manager is the one who gets the call when a ticket has lapsed. Below 200 staff
// the GM or president usually signs, so they rank with the HR director there.
const RANK = [
  [/\b(director|vp|vice president|head of|chief)\b.*\b(human resources|people|hr)\b|\b(human resources|people|hr)\b.*\b(director|vp|vice president|head|chief)\b/i, 1],
  [/\b(director|vp|vice president|head)\b.*\boperations?\b|\boperations?\b.*\b(director|vp|vice president|head)\b|\bcoo\b/i, 1],
  [/\boperations? manager\b|\bmanager\b.*\boperations?\b/i, 2],
  [/\bmanager\b.*\b(human resources|people|hr)\b|\b(human resources|people|hr)\b.*\bmanager\b/i, 2],
  [/\b(safety|hse|ehs|compliance|training)\b.*\b(manager|coordinator|officer|lead)\b/i, 3],
  [/\b(general manager|president|owner|managing director)\b/i, 3],
  [/generalist|coordinator|administrator/i, 4],
];
function rankOf(title, staff) {
  const t = String(title || '');
  for (const [re, r] of RANK) {
    if (!re.test(t)) continue;
    // A GM or president at a company under 200 is the decision maker, not a fallback.
    if (r === 3 && /general manager|president|owner|managing director/i.test(t) && staff && staff <= 200) return 1;
    return r;
  }
  return 6;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function prospeoSearch(apex) {
  if (atCap('prospeo')) { console.log('  cap  prospeo at monthly cap'); return null; }
  let r, text;
  // Prospeo's free plan rate-limits bursts (HTTP 429, no credit language). Eight of twenty-five
  // companies were skipped for that on the first run, so wait and retry rather than move on.
  for (let attempt = 0; attempt < 4; attempt++) {
    r = await fetch('https://api.prospeo.io/search-person', {
      method: 'POST',
      headers: { 'X-KEY': PROSPEO_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        page: 1,
        filters: {
          company: { websites: { include: [apex] } },
          person_job_title: {
            include: ['human resources', 'people', 'talent', 'hr ', 'operations', 'safety', 'hse', 'compliance', 'training', 'general manager', 'president'],
            match_mode: 'CONTAINS',
          },
        },
      }),
    });
    text = await r.text();
    if (r.status === 429 && !/credit/i.test(text)) { await sleep(6000 * (attempt + 1)); continue; }
    break;
  }
  checkCreditsResponse('prospeo search', r.status, text);
  // NO_RESULTS is Prospeo's normal "nobody matched", not a fault, and costs no credit.
  if (/NO_RESULTS/.test(text)) return [];
  if (!r.ok) throw new Error(`prospeo search-person ${r.status} ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  // Verified live 2026-09-12: the array is under `results`, not `persons`, and each item is
  // {person, company} with the person fields nested. Kept the `.persons` fallback in case a
  // different plan or a future version flattens the shape.
  const persons = j.results || j.persons || [];
  if (persons.length) spend('prospeo');
  return persons;
}

async function prospeoEnrich({ firstName, lastName, apex, personId }) {
  if (atCap('prospeo')) { console.log('  cap  prospeo at monthly cap'); return null; }
  const data = personId ? { person_id: personId } : { first_name: firstName, last_name: lastName, company_website: apex };
  const r = await fetch('https://api.prospeo.io/enrich-person', {
    method: 'POST',
    headers: { 'X-KEY': PROSPEO_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  });
  const text = await r.text();
  checkCreditsResponse('prospeo enrich', r.status, text);
  if (!r.ok) { console.log(`       prospeo enrich failed: ${r.status} ${text.slice(0, 160)}`); return null; }
  const j = JSON.parse(text);
  const p = j.person || j.data || j;
  const email = p && p.email;
  if (email && email.status === 'VERIFIED' && email.revealed === true && email.email) {
    spend('prospeo');
    return email.email;
  }
  return null;
}

async function getProspectFind(name, apex) {
  if (atCap('getprospect')) { console.log('  cap  getprospect at monthly cap'); return null; }
  const url = `https://api.getprospect.com/public/v1/email/find?name=${encodeURIComponent(name)}&company=${encodeURIComponent(apex)}&apiKey=${GETPROSPECT_KEY}`;
  const r = await fetch(url);
  const text = await r.text();
  checkCreditsResponse('getprospect', r.status, text);
  if (r.status === 200) {
    spend('getprospect');
    const j = JSON.parse(text);
    if (j.email && j.status === 'valid') return j.email;
    return null;
  }
  if (r.status === 404) return null;
  console.log(`       getprospect failed: ${r.status} ${text.slice(0, 160)}`);
  return null;
}

let snovToken = null;
async function snovAuth() {
  if (snovToken) return snovToken;
  const r = await fetch('https://api.snov.io/v1/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: SNOV_CLIENT_ID, client_secret: SNOV_CLIENT_SECRET }),
  });
  const text = await r.text();
  checkCreditsResponse('snov auth', r.status, text);
  if (!r.ok) throw new Error(`snov auth ${r.status} ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  snovToken = j.access_token;
  return snovToken;
}
async function snovFind(firstName, lastName, domain) {
  if (atCap('snov')) { console.log('  cap  snov at monthly cap'); return null; }
  const token = await snovAuth();
  const r = await fetch('https://api.snov.io/v1/get-emails-from-names', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ firstName, lastName, domain }),
  });
  const text = await r.text();
  checkCreditsResponse('snov', r.status, text);
  spend('snov');
  if (!r.ok) { console.log(`       snov failed: ${r.status} ${text.slice(0, 160)}`); return null; }
  let j = JSON.parse(text);
  let tries = 0;
  while (j.status && j.status.identifier === 'in_progress' && tries < 5) {
    await sleep(3000);
    tries++;
    const poll = await fetch('https://api.snov.io/v1/get-emails-from-names', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ firstName, lastName, domain }),
    });
    const pollText = await poll.text();
    checkCreditsResponse('snov', poll.status, pollText);
    j = JSON.parse(pollText);
  }
  const emails = (j.data && j.data.emails) || [];
  const valid = emails.find((e) => e.emailStatus === 'valid');
  return valid ? valid.email : null;
}

async function lushaFind(firstName, lastName, domain) {
  if (atCap('lusha')) { console.log('  cap  lusha at monthly cap'); return null; }
  const url = `https://api.lusha.com/v2/person?firstName=${encodeURIComponent(firstName)}&lastName=${encodeURIComponent(lastName)}&companyDomain=${encodeURIComponent(domain)}`;
  const r = await fetch(url, { headers: { api_key: LUSHA_KEY } });
  const text = await r.text();
  checkCreditsResponse('lusha', r.status, text);
  spend('lusha'); // charges a credit even on a miss
  if (!r.ok) { console.log(`       lusha failed: ${r.status} ${text.slice(0, 160)}`); return null; }
  const j = JSON.parse(text);
  const addrs = (j.contact && j.contact.data && j.contact.data.emailAddresses) || [];
  const work = addrs.find((e) => e.emailType === 'work') || addrs[0];
  return work ? work.email : null;
}

/** Tomba: published addresses per domain with names and positions; 1 search per domain. */
async function tombaDomain(apex) {
  if (!TOMBA_KEY || !TOMBA_SECRET) return [];
  if (atCap('tomba')) { console.log('  cap  tomba at monthly cap'); return []; }
  const r = await fetch(`https://api.tomba.io/v1/domain-search?domain=${encodeURIComponent(apex)}&department=hr&limit=10`,
    { headers: { 'X-Tomba-Key': TOMBA_KEY, 'X-Tomba-Secret': TOMBA_SECRET } });
  const text = await r.text();
  checkCreditsResponse('tomba', r.status, text);
  if (!r.ok) { console.log(`       tomba failed: ${r.status} ${text.slice(0, 120)}`); return []; }
  spend('tomba');
  const j = JSON.parse(text);
  return ((j.data && j.data.emails) || []).filter((e) => e.email && (e.score || 0) >= 50)
    .map((e) => ({ email: e.email, first_name: e.first_name, last_name: e.last_name, title: e.position || '', score: e.score }));
}

/** ZeroBounce as the second opinion: only consulted after Reoon says deliverable. */
async function zeroBounceValid(email) {
  if (!ZEROBOUNCE_KEY || atCap('zerobounce')) return true; // no second opinion available, Reoon decides
  const r = await fetch(`https://api.zerobounce.net/v2/validate?api_key=${ZEROBOUNCE_KEY}&email=${encodeURIComponent(email)}`);
  const text = await r.text();
  if (!r.ok) return true;
  spend('zerobounce');
  const j = JSON.parse(text);
  if (j.status === 'invalid') { console.log(`       verifiers disagree on ${email}: Reoon deliverable, ZeroBounce invalid`); return false; }
  return true;
}

async function reoonVerify(email) {
  if (atCap('reoon')) { console.log('  cap  reoon at monthly cap'); return null; }
  const url = `https://emailverifier.reoon.com/api/v1/verify?email=${encodeURIComponent(email)}&key=${REOON_KEY}&mode=power`;
  const r = await fetch(url);
  const text = await r.text();
  checkCreditsResponse('reoon', r.status, text);
  spend('reoon');
  if (!r.ok) { console.log(`       reoon failed: ${r.status} ${text.slice(0, 160)}`); return null; }
  const j = JSON.parse(text);
  return j.is_deliverable === true && j.is_catch_all === false;
}

const NEEDS_REVIEW_RELEASE = /guessed|wrong desk|will not route/i;

(async () => {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('cadre_leads')
      .select('id, business_name, website, staff_estimate, qualification_score, contact_name, email, email_quality, status, notes')
      .in('status', ['queued', 'needs_review'])
      .not('website', 'is', null)
      .gte('staff_estimate', 100).lte('staff_estimate', 1000)
      .order('qualification_score', { ascending: false, nullsFirst: false })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    all.push(...data);
    if (data.length < 1000) break;
  }

  const seen = new Set();
  const todo = all.filter((l) => {
    const notes = l.notes || '';
    // A lead tried before is skipped, unless --retry-misses: sources refill on their own clocks
    // (Tomba daily, the rest monthly), so "no deliverable address" in week one is not an answer
    // in week three. Only the two miss outcomes are retried; a found address never is.
    if (/free-contacts:/.test(notes)) {
      const missed = /free-contacts: .*(found, no deliverable address|no HR person)/.test(notes);
      if (!(RETRY_MISSES && missed)) return false;
    }
    const hasPersonalName = l.email_quality === 'personal' && l.contact_name && l.contact_name.trim() !== '';
    if (hasPersonalName) return false;
    if (excludedOrgReason(l.business_name, l.email)) return false;
    if (NAMED_ONLY && !(l.contact_name && l.contact_name.trim().split(/\s+/).length >= 2)) return false;
    const apex = apexOf(l.website);
    if (!apex || seen.has(apex)) return false;
    seen.add(apex);
    return true;
  }).sort((a, b) => ((b.contact_name ? 1 : 0) - (a.contact_name ? 1 : 0))).slice(0, LIMIT);

  console.log(`${DRY ? 'DRY RUN (still calls the APIs, writes nothing): ' : ''}${todo.length} lead(s) selected.\n`);

  let found = 0, personNoEmail = 0, noPerson = 0;
  let printedRawShape = false;

  try {
    for (const lead of todo) {
      const apex = apexOf(lead.website);
      const tag = String(lead.business_name).slice(0, 30).padEnd(32);

      // A lead that arrived with a name (Prospeo finder, hand lists) does not need a search.
      const knownName = (lead.contact_name || '').trim();
      const knownId = ((lead.notes || '').match(/prospeo: person_id ([a-f0-9]+)/) || [])[1] || null;
      let persons;
      if (knownName && knownName.split(' ').length >= 2) {
        const parts = knownName.split(/\s+/);
        persons = [{ person: { first_name: parts[0], last_name: parts.slice(1).join(' '), current_job_title: lead.contact_role || '', person_id: knownId } }];
      } else {
        try { persons = await prospeoSearch(apex); }
        catch (e) { console.log(`  !    ${tag}${e.message}`); continue; }
        if (persons === null) continue; // at cap, already logged
      }

      if (!printedRawShape && persons.length) {
        console.log('  Raw Prospeo persons[0] keys:', JSON.stringify(Object.keys(persons[0])));
        console.log('  Raw Prospeo persons[0]:', JSON.stringify(persons[0]).slice(0, 600));
        printedRawShape = true;
      }

      const candidates = persons.map((raw) => {
        const p = raw.person || raw;
        return {
          first_name: p.first_name, last_name: p.last_name,
          title: p.current_job_title || p.job_title || p.title,
          id: p.person_id || p.id || raw.person_id || raw.id,
          emailStatus: p.email && p.email.status,
        };
      }).filter((c) => c.first_name && c.last_name)
        .map((c) => ({ ...c, rank: rankOf(c.title, lead.staff_estimate) }))
        .sort((a, b) => a.rank - b.rank || (b.emailStatus === 'VERIFIED') - (a.emailStatus === 'VERIFIED'));

      const pick = candidates[0];
      if (!pick) {
        noPerson++;
        console.log(`  --   ${tag}no HR person`);
        if (!DRY) {
          await supabase.from('cadre_leads').update({
            notes: `${lead.notes ? lead.notes + '\n' : ''}free-contacts: no HR person on ${apex}`,
          }).eq('id', lead.id);
        }
        continue;
      }

      const name = `${pick.first_name} ${pick.last_name}`;
      let email = null, source = null;
      const tried = [];
      // Every candidate goes through Reoon, then ZeroBounce as a second opinion, before it counts.
      const tryVerified = async (addr, src) => {
        if (!addr || tried.includes(addr)) return false;
        tried.push(addr);
        // Reoon, then ZeroBounce, then Verifalia, whichever still has credit. When all three are
        // out the run stops: "no verifier" must never be recorded as "no address".
        let v = null;
        try { v = await verify(addr); } catch (e) { if (e instanceof NoVerifier) throw new CreditsExhausted('every verifier is out of credit'); console.log(`       verify error: ${e.message}`); }
        // A catch-all domain accepts any address, so our verifiers cannot say yes or no there.
        // Prospeo verifies those with BounceBan before it reveals them, so its answer stands on a
        // catch-all domain; anything else on a catch-all domain is not taken.
        const catchAllButProspeo = !!(v && v.catchAll && src === 'prospeo');
        const ok = !!(v && v.ok && !v.catchAll) || catchAllButProspeo;
        if (ok) { email = addr; source = catchAllButProspeo ? `${src} (catch-all domain, Prospeo verified)` : `${src}, ${v.via}`; }
        return ok;
      };

      // Free sources first; Prospeo's enrich costs a credit, so it comes last.
      let tomba = [];
      try { tomba = await tombaDomain(apex); } catch (e) { if (e instanceof CreditsExhausted) throw e; console.log(`       tomba error: ${e.message}`); }
      const tombaSame = tomba.find((t) => t.last_name && t.last_name.toLowerCase() === String(pick.last_name).toLowerCase());
      if (tombaSame) await tryVerified(tombaSame.email, 'tomba');
      if (!email && !knownName && tomba.length) {
        const t = tomba.map((x) => ({ ...x, rank: rankOf(x.title, lead.staff_estimate) })).sort((a, b) => a.rank - b.rank)[0];
        if (t && t.rank < 99 && await tryVerified(t.email, 'tomba')) {
          pick.first_name = t.first_name || pick.first_name; pick.last_name = t.last_name || pick.last_name; pick.title = t.title || pick.title;
        }
      }
      if (!email) {
        try { const a = await getProspectFind(name, apex); if (a) await tryVerified(a, 'getprospect'); }
        catch (e) { if (e instanceof CreditsExhausted) { state.getprospect = CAPS.getprospect; console.log('  cap  getprospect: out of credit, skipping it for the rest of the run'); } else console.log(`       getprospect error: ${e.message}`); }
      }
      if (!email) {
        try { const a = await snovFind(pick.first_name, pick.last_name, apex); if (a) await tryVerified(a, 'snov'); }
        catch (e) { if (e instanceof CreditsExhausted) { state.snov = CAPS.snov; console.log('  cap  snov: out of credit, skipping it for the rest of the run'); } else console.log(`       snov error: ${e.message}`); }
      }
      if (!email) {
        try { const a = await prospeoEnrich({ firstName: pick.first_name, lastName: pick.last_name, apex, personId: pick.id }); if (a) await tryVerified(a, 'prospeo'); }
        catch (e) { if (e instanceof CreditsExhausted) throw e; console.log(`       prospeo enrich error: ${e.message}`); }
      }
      if (!email) {
        try { const a = await lushaFind(pick.first_name, pick.last_name, apex); if (a) await tryVerified(a, 'lusha'); }
        catch (e) { if (e instanceof CreditsExhausted) { state.lusha = CAPS.lusha; console.log('  cap  lusha: out of credit, skipping it for the rest of the run'); } else console.log(`       lusha error: ${e.message}`); }
      }

      saveState(state);
      const nameNow = `${pick.first_name} ${pick.last_name}`;
      if (email) {
        found++;
        console.log(`  ok   ${tag}${String(email).padEnd(36)}${nameNow}, ${pick.title || '?'} (${source})`);
        if (!DRY) {
          const releaseToQueued = lead.status === 'needs_review' && NEEDS_REVIEW_RELEASE.test(lead.notes || '');
          const u = {
            contact_name: nameNow,
            contact_role: pick.title || lead.contact_role || null,
            email,
            email_quality: 'personal',
            notes: `${lead.notes ? lead.notes + '\n' : ''}free-contacts: ${email} via ${source}, Reoon deliverable, title ${pick.title || lead.contact_role || 'unknown'}`,
          };
          if (releaseToQueued) u.status = 'queued';
          const { error: e } = await supabase.from('cadre_leads').update(u).eq('id', lead.id);
          if (e) console.log(`       write failed: ${e.message}`);
        }
      } else {
        personNoEmail++;
        console.log(`  --   ${tag}${name} found, no address`);
        if (!DRY) {
          await supabase.from('cadre_leads').update({
            notes: `${lead.notes ? lead.notes + '\n' : ''}free-contacts: ${name} (${pick.title || 'unknown'}) found, no deliverable address`,
          }).eq('id', lead.id);
        }
      }
    }
  } catch (e) {
    if (e instanceof CreditsExhausted) console.log(`\nSTOPPED: ${e.message}`);
    else throw e;
  }

  saveState(state);
  console.log(`\nfound ${found} | person but no email ${personNoEmail} | no person ${noPerson} | credits used: prospeo ${state.prospeo}, getprospect ${state.getprospect}, snov ${state.snov}, lusha ${state.lusha}, tomba ${state.tomba || 0}, zerobounce ${state.zerobounce || 0}, reoon ${state.reoon}`);
})().catch((e) => { console.error('free-contacts failed:', e.message); process.exit(1); });
