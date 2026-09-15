#!/usr/bin/env node
/**
 * cadre/pattern-guess.js, the free multiplier: name plus format plus a verifier.
 *
 * Prospeo's search results mask the address but leak two things for free: the first letter of
 * the mailbox and the real mail domain (systemair.net for a company whose site is systemair.com).
 * With the person's name that leaves three or four plausible mailboxes, and Reoon's free
 * verifier (600 a month) says which one exists. Where Reoon reports the domain as catch-all the
 * answer is meaningless and the lead is left alone rather than guessed.
 *
 * Only runs on leads that already have a name and a size in band and no address. Candidates in
 * order of how often they are right in this list so far: flast, first.last, first, firstlast,
 * f.last, first_last. Stops at the first deliverable one.
 *
 *   node cadre/pattern-guess.js --dry --limit 10
 *   node cadre/pattern-guess.js --limit 150
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const supabase = require('../lib/supabase');

const DRY = process.argv.includes('--dry');
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : dflt; };
const LIMIT = parseInt(arg('limit', '150'), 10);
// --retry: second pass over leads where the first four formats missed, trying the rarer ones.
const RETRY = process.argv.includes('--retry');
const REOON_KEY = process.env.REOON_KEY;
const ZB_KEY = process.env.ZEROBOUNCE_KEY;
const STATE_FILE = path.join(__dirname, 'state', 'free-tier.json');
const CAPS = { reoon: 600, zerobounce: 100 };

function loadState() {
  try { const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); if (s.month === new Date().toISOString().slice(0, 7)) return s; } catch (e) { /* fresh */ }
  return { month: new Date().toISOString().slice(0, 7) };
}
const state = loadState();
const left = (k) => CAPS[k] - (state[k] || 0);
const spend = (k) => { state[k] = (state[k] || 0) + 1; fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); };

const apexOf = (w) => String(w || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
const clean = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

/** Masked addresses from the finder's raw pages: full name -> { first letter, domain }. */
function maskedByName() {
  const map = new Map();
  for (const f of fs.readdirSync(path.join(__dirname, 'batches'))) {
    if (!/^prospeo-raw-.*\.json$/.test(f)) continue;
    let j; try { j = JSON.parse(fs.readFileSync(path.join(__dirname, 'batches', f), 'utf8')); } catch (e) { continue; }
    const pages = Array.isArray(j) ? j : [j];
    for (const page of pages) {
      for (const x of (page.results || [])) {
        const p = x.person || {}; const m = (p.email && p.email.email) || '';
        const mm = m.match(/^([a-z0-9])[*]+@(.+)$/i);
        if (p.full_name && mm) map.set(p.full_name.toLowerCase(), { letter: mm[1].toLowerCase(), domain: mm[2].toLowerCase(), status: p.email.status });
      }
    }
  }
  return map;
}

function candidates(first, last, domain) {
  const f = clean(first), l = clean(last.split(/\s+/).pop());
  if (!f || !l) return [];
  const all = [`${f[0]}${l}`, `${f}.${l}`, `${f}`, `${f}${l}`, `${f[0]}.${l}`, `${f}_${l}`, `${f}${l[0]}`, `${l}${f[0]}`, `${l}.${f}`, `${f}-${l}`];
  return (RETRY ? all.slice(4) : all.slice(0, 4)).map((x) => `${x}@${domain}`);
}

async function reoon(email) {
  const r = await fetch(`https://emailverifier.reoon.com/api/v1/verify?email=${encodeURIComponent(email)}&key=${REOON_KEY}&mode=power`);
  const j = await r.json(); spend('reoon');
  return { ok: j.is_deliverable === true && j.is_catch_all !== true, catchAll: j.is_catch_all === true, status: j.status };
}
async function zerobounce(email) {
  if (!ZB_KEY || left('zerobounce') <= 0) return true;
  const r = await fetch(`https://api.zerobounce.net/v2/validate?api_key=${ZB_KEY}&email=${encodeURIComponent(email)}`);
  const j = await r.json(); spend('zerobounce');
  return j.status !== 'invalid';
}

(async () => {
  const masked = maskedByName();
  const { data, error } = await supabase.from('cadre_leads')
    .select('id, business_name, website, contact_name, contact_role, staff_estimate, notes, status')
    .in('status', ['queued', 'needs_review']).is('email', null)
    .not('contact_name', 'is', null).gte('staff_estimate', 100).lte('staff_estimate', 1000)
    .order('qualification_score', { ascending: false, nullsFirst: false }).limit(1000);
  if (error) throw new Error(error.message);
  const todo = data.filter((l) => {
    const n = l.notes || '';
    const eligible = RETRY ? (/pattern-guess: none of/.test(n) && !/pattern-guess: retry/.test(n)) : !/pattern-guess:/.test(n);
    return eligible && (l.contact_name || '').trim().split(/\s+/).length >= 2;
  }).slice(0, LIMIT);
  console.log(`${DRY ? 'DRY RUN: ' : ''}${todo.length} named lead(s) without an address. Reoon checks left this month: ${left('reoon')}.\n`);

  let found = 0, catchAll = 0, miss = 0;
  for (const lead of todo) {
    if (left('reoon') < 6) { console.log('  cap  reoon nearly out for the month, stopping'); break; }
    const parts = lead.contact_name.trim().split(/\s+/);
    const first = parts[0], last = parts.slice(1).join(' ');
    const hint = masked.get(lead.contact_name.toLowerCase());
    const domain = (hint && hint.domain) || apexOf(lead.website);
    const tag = String(lead.business_name).slice(0, 30).padEnd(32);
    let cands = candidates(first, last, domain);
    if (hint) cands = cands.filter((c) => c[0] === hint.letter).concat(cands.filter((c) => c[0] !== hint.letter));
    let hit = null, isCatchAll = false;
    for (const c of cands.slice(0, RETRY ? 6 : 4)) {
      let v; try { v = await reoon(c); } catch (e) { console.log(`       reoon error ${e.message}`); break; }
      if (v.catchAll) { isCatchAll = true; break; }
      if (v.ok && await zerobounce(c)) { hit = c; break; }
    }
    if (isCatchAll) {
      catchAll++; console.log(`  --   ${tag}${domain} is catch-all, cannot verify`);
      if (!DRY) await supabase.from('cadre_leads').update({ notes: `${lead.notes ? lead.notes + '\n' : ''}pattern-guess: ${domain} is catch-all, no guess made` }).eq('id', lead.id);
      continue;
    }
    if (!hit) {
      miss++; console.log(`  --   ${tag}no format verified for ${lead.contact_name} at ${domain}`);
      if (!DRY) await supabase.from('cadre_leads').update({ notes: `${lead.notes ? lead.notes + '\n' : ''}pattern-guess: ${RETRY ? 'retry, ' : ''}none of ${cands.length} formats verified at ${domain}` }).eq('id', lead.id);
      continue;
    }
    found++;
    console.log(`  ok   ${tag}${hit.padEnd(38)}${lead.contact_name}, ${lead.contact_role || ''}`);
    if (!DRY) {
      const u = { email: hit, email_quality: 'personal', notes: `${lead.notes ? lead.notes + '\n' : ''}pattern-guess: ${hit} built from name and format, Reoon deliverable, not catch-all` };
      if (lead.status === 'needs_review' && /guessed|wrong desk|will not route|size unknown/i.test(lead.notes || '')) u.status = 'queued';
      const { error: e } = await supabase.from('cadre_leads').update(u).eq('id', lead.id);
      if (e) console.log(`       write failed: ${e.message}`);
    }
  }
  console.log(`\nfound ${found} | catch-all ${catchAll} | no format ${miss} | reoon used this month ${state.reoon || 0}, zerobounce ${state.zerobounce || 0}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
