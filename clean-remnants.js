#!/usr/bin/env node
/**
 * Remove sentence fragments left behind when the demo ask was swapped out.
 *
 * swap-ask removed sentences that MENTIONED a demo, but some emails split the offer across
 * two sentences: "...want a 90-second demo? Happy to send it over." Only the first matched,
 * so the second survived and now dangles in front of the real ask, referring to something
 * that is no longer being offered.
 *
 *   node clean-remnants.js --dry
 *   node clean-remnants.js --table tempo_leads
 */
require('dotenv').config();
const supabase = require('./lib/supabase');

const DRY = process.argv.includes('--dry');
const TABLE = (() => {
  const i = process.argv.indexOf('--table');
  const t = i > -1 ? process.argv[i + 1] : 'leads';
  if (!['leads', 'tempo_leads'].includes(t)) throw new Error('--table must be leads or tempo_leads');
  return t;
})();

// Sentences that only made sense alongside a demo offer. Deliberately narrow: each has to be
// a whole short sentence about sending or showing something, not a substring that could
// appear inside a legitimate line about the business.
const REMNANTS = [
  /\s*(?:I'?d be |I'?m )?happy to send (?:it|one|that|this) over\.?/gi,
  /\s*I'?ll send (?:it|one|that) over\.?/gi,
  /\s*Happy to (?:share|send) (?:it|more|one)\.?/gi,
  /\s*(?:It'?s|That'?s) about (?:90|ninety) seconds\.?/gi,
  /\s*(?:It )?takes (?:90|ninety) seconds\.?/gi,
  /\s*No pitch,? just (?:the|a) (?:video|demo|clip)\.?/gi,
];

function clean(text) {
  if (!text) return null;
  let out = text;
  let hit = false;
  for (const re of REMNANTS) {
    if (re.test(out)) { hit = true; out = out.replace(re, ''); }
  }
  if (!hit) return null;
  // Tidy the seams: doubled spaces, a space before punctuation, blank lines left behind.
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,!?])/g, '$1').replace(/\n{3,}/g, '\n\n').trim();
  if (out.replace('{{ASK}}', '').split(/\s+/).filter(Boolean).length < 12) return null;
  return out;
}

(async () => {
  const rows = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await supabase.from(TABLE)
      .select('id, business_name, email_body, followup_body, followup2_body')
      .eq('status', 'queued').is('last_sent_at', null)
      .range(f, f + 999);
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
  }

  let changed = 0;
  for (const r of rows) {
    const patch = {};
    for (const field of ['email_body', 'followup_body', 'followup2_body']) {
      const next = clean(r[field]);
      if (next) patch[field] = next;
    }
    if (!Object.keys(patch).length) continue;
    if (DRY) { if (changed < 2) console.log(`\n--- ${r.business_name}\n${patch.email_body || '(follow-up only)'}`); changed++; continue; }
    const { error } = await supabase.from(TABLE).update(patch).eq('id', r.id);
    if (error) { console.log(`  failed ${r.business_name}: ${error.message}`); continue; }
    changed++;
    if (changed % 100 === 0) console.log(`  ${changed} cleaned...`);
  }
  console.log(`\n${DRY ? 'Would clean' : 'Cleaned'} ${changed}`);
})().catch(e => { console.error('clean failed:', e.message); process.exit(1); });
