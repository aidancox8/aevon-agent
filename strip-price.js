#!/usr/bin/env node
/**
 * Remove retired pricing from queued copy.
 *
 * The offer changed to a free build, but ~3,000 pre-generated emails still quote "$1,500 flat
 * setup" and "$150/month". regen-copy rewrites them properly, and does a better job, but only
 * ~280 a night, so roughly 900 emails quoting a price that contradicts the offer would go out
 * before it caught up. This is the stopgap: surgically drop the price sentence and leave the
 * rest of the copy alone, so nothing ships with the contradiction while the rewrite proceeds.
 *
 *   node strip-price.js --dry
 *   node strip-price.js --table tempo_leads
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

const HAS_PRICE = /\$\s?1,?500|\$\s?150\b|150\s*\/\s*mo/i;

/**
 * Drop whole sentences that carry a price, rather than blanking the number and leaving
 * "It is a flat setup, live in a week" dangling. Splits on sentence boundaries, keeps
 * everything else verbatim, and tidies the spacing.
 */
function stripPrice(text) {
  if (!text || !HAS_PRICE.test(text)) return null;
  const paras = String(text).split(/\n\n+/);
  const cleanedParas = paras.map(p => {
    // Keep the delimiter with each sentence so rebuilding does not lose punctuation.
    const sentences = p.match(/[^.!?]+[.!?]+[\s]*|[^.!?]+$/g) || [p];
    const kept = sentences.filter(s => !HAS_PRICE.test(s));
    return kept.join('').replace(/\s+/g, ' ').trim();
  }).filter(Boolean);

  const out = cleanedParas.join('\n\n').trim();
  // If stripping gutted the email, say so rather than sending three words. The caller skips
  // these and leaves them for regen-copy to rewrite properly.
  if (out.split(/\s+/).filter(Boolean).length < 18) return { tooShort: true, text: out };
  return { text: out };
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

  let changed = 0, skipped = 0, untouched = 0;
  for (const r of rows) {
    const patch = {};
    let gutted = false;
    for (const field of ['email_body', 'followup_body', 'followup2_body']) {
      const res = stripPrice(r[field]);
      if (!res) continue;
      if (res.tooShort) { gutted = true; break; }
      patch[field] = res.text;
    }
    if (gutted) { skipped++; continue; }
    if (!Object.keys(patch).length) { untouched++; continue; }

    if (DRY) {
      if (changed < 2) {
        console.log(`\n--- ${r.business_name}`);
        console.log('BEFORE: ' + String(r.email_body).slice(0, 240).replace(/\n/g, ' '));
        console.log('AFTER : ' + String(patch.email_body || r.email_body).slice(0, 240).replace(/\n/g, ' '));
      }
      changed++;
      continue;
    }
    const { error } = await supabase.from(TABLE).update(patch).eq('id', r.id);
    if (error) { console.log(`  failed ${r.business_name}: ${error.message}`); continue; }
    changed++;
    if (changed % 250 === 0) console.log(`  ${changed} cleaned...`);
  }

  console.log(`\n${DRY ? 'Would clean' : 'Cleaned'} ${changed} | left for full rewrite ${skipped} | no price ${untouched}`);
})().catch(e => { console.error('strip failed:', e.message); process.exit(1); });
