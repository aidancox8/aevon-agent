#!/usr/bin/env node
/**
 * cadre/format-guess.js
 *
 * Turns a Muse-named person into an address: build the mailbox from the company's email format,
 * then let Verifalia say whether it exists. Done by hand on 2026-10-27 and it found 2 of 6, where
 * the free finder chain found 0 of 15.
 *
 * Order of candidates: the format shown by Muse's format_evidence (one published address at the
 * domain) if there is one, else first.last, flast, first. A domain is probed first with a
 * nonsense mailbox; if that is not rejected the server accepts anything (catch-all) and no guess
 * can be trusted, so the lead is left alone.
 *
 * Verifalia credit (about 25 a day) is shared with posting-autopilot.js, so this is capped with
 * --checks (default 8) and stops on a 402.
 *
 *   node cadre/format-guess.js [--checks 8] [--dry]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const { createClient } = require('@supabase/supabase-js');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const DRY = process.argv.includes('--dry');
let budget = parseInt(arg('--checks', '8'), 10);
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const auth = 'Basic ' + Buffer.from(`${process.env.VERIFALIA_USER}:${process.env.VERIFALIA_PASS}`).toString('base64');
const sleep = ms => new Promise(r => setTimeout(r, ms));
class OutOfCredit extends Error {}

async function check(email) {
  if (budget <= 0) throw new OutOfCredit('daily check budget used');
  budget--;
  const r = await fetch('https://api.verifalia.com/v2.6/email-validations?waitTime=30000', {
    method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [{ inputData: email }] }) });
  if (r.status === 402) throw new OutOfCredit('Verifalia out of credit');
  let j = await r.json();
  if (!j.overview) throw new Error(`verifalia ${r.status}`);
  for (let i = 0; i < 12 && j.overview.status !== 'Completed'; i++) {
    await sleep(8000);
    j = await (await fetch(`https://api.verifalia.com/v2.6/email-validations/${j.overview.id}`, { headers: { Authorization: auth } })).json();
  }
  const e = (j.entries.data || j.entries)[0];
  return e.classification;
}

const apex = w => { if (!w) return null; try { return new URL(/^https?:/i.test(w) ? w : `https://${w}`).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } };
const clean = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

/** Mailbox from a published example: "jane.doe@x.com" for Jane Doe gives the pattern. */
function fromEvidence(evidence, f, l) {
  const local = String(evidence || '').split('@')[0].toLowerCase();
  if (!local || /^(info|hr|admin|sales|office|careers|jobs|contact|hello|support|accounts?)$/.test(local)) return null;
  if (local.includes('.')) { const [a, b] = local.split('.'); return a.length === 1 ? `${f[0]}.${l}` : b.length === 1 ? `${f}.${l[0]}` : `${f}.${l}`; }
  if (local.includes('_')) return `${f}_${l}`;
  return null; // jsmith vs johns vs john: ambiguous without the person's name, fall back to the defaults
}

(async () => {
  const { data, error } = await sb.from('cadre_leads').select('*').like('notes', '%muse 20%').not('contact_name', 'is', null);
  if (error) throw new Error(error.message);
  const todo = data.filter(l => l.email_quality !== 'personal' && !/format-guess/.test(l.notes || '') && apex(l.website)
    && l.contact_name.trim().split(/\s+/).length >= 2 && !/\b[A-Z]\.?$/.test(l.contact_name.trim()));
  console.log(`${todo.length} named lead(s) without a verified address, ${budget} check(s) to spend.`);
  let found = 0;
  try {
    for (const l of todo) {
      const dom = apex(l.website);
      const parts = l.contact_name.replace(/,.*$/, '').trim().split(/\s+/);
      const f = clean(parts[0]), last = clean(parts[parts.length - 1]);
      if (!f || !last) continue;
      const ev = (l.notes.match(/format evidence (\S+@\S+)/) || [])[1];
      const cands = [...new Set([fromEvidence(ev, f, last), `${f}.${last}`, `${f[0]}${last}`, f].filter(Boolean))].map(x => `${x}@${dom}`);
      if (DRY) { console.log(`${l.business_name}: would try ${cands.join(', ')}`); continue; }
      const probe = await check(`zq${Date.now() % 100000}x@${dom}`);
      let hit = null, tried = [];
      if (probe === 'Undeliverable') {
        for (const c of cands) { const v = await check(c); tried.push(`${c} ${v}`); if (v === 'Deliverable') { hit = c; break; } }
      }
      const u = hit
        ? { email: hit, email_quality: 'personal', notes: `${l.notes} | format-guess ${new Date().toISOString().slice(0, 10)}: ${hit} Verifalia Deliverable` }
        : { notes: `${l.notes} | format-guess ${new Date().toISOString().slice(0, 10)}: ${probe !== 'Undeliverable' ? 'domain accepts anything, not guessed' : 'no pattern verified'}` };
      await sb.from('cadre_leads').update(u).eq('id', l.id);
      if (hit) found++;
      console.log(`${l.business_name}: ${hit || (probe !== 'Undeliverable' ? 'catch-all, skipped' : 'none')} ${tried.join('; ')}`);
    }
  } catch (e) { if (!(e instanceof OutOfCredit)) throw e; console.log(`Stopped: ${e.message}.`); }
  console.log(`Found ${found}.`);
})().catch(e => { console.error(e.message); process.exit(1); });
