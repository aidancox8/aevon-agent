#!/usr/bin/env node
/**
 * Remove the retired free-build promise from queued copy.
 *
 * The Aevon offer stopped being "I'll build it for you, free" on 2026-08-19 (the reasoning is
 * in the AEVON block of lib/offer.js). The closing ask is a token, so lib/offer.js fixed that
 * instantly, but the promise is also argued in the Gemini-written body of 1,206 first emails
 * and 1,102 second emails, and no token reaches those. Left alone they would send a paragraph
 * promising free work and then a closing question that offers nothing, which is worse than
 * either version on its own.
 *
 * This removes the free CLAUSE, not the sentence. "I'd build a tool that reads your incoming
 * service inquiries and sorts them for your dispatchers, free." is a usable capability line
 * once the last word is gone; deleting the whole sentence would leave an email with no reason
 * for existing. Sentences that exist only to justify the free work are dropped whole.
 *
 *   node strip-free-build.js --dry
 *   node strip-free-build.js
 */
require('dotenv').config();
const supabase = require('./lib/supabase');

const DRY = process.argv.includes('--dry');
const FIELDS = ['email_body', 'followup_body', 'followup2_body'];

/**
 * Which body fields have not been sent yet, so are still safe to edit.
 *
 * The previous filter here was `last_sent_at IS NULL`, which meant a lead that had received
 * email 1 was skipped entirely, and its queued follow-ups kept the retired copy forever. That
 * is backwards: those are the emails still due to go out. But the already-sent field must not
 * be rewritten either, because the stored copy is the only record of what was actually sent.
 * Sequence step says exactly which is which.
 */
function unsentFields(step) {
  const n = Number(step) || 0;
  return ['email_body', 'followup_body', 'followup2_body'].slice(n);
}


/** Trailing or parenthetical promises of free work, removed in place. */
const CLAUSES = [
  /,?\s*(?:and\s+)?(?:it'?s|they'?re|that'?s)?\s*(?:completely\s+|entirely\s+|totally\s+)?free of charge\b/gi,
  /,?\s*(?:completely\s+|entirely\s+|totally\s+)?for free\b/gi,
  /,?\s*at no cost(?:\s+to you)?\b/gi,
  /,?\s*(?:with\s+)?no charge\b/gi,
  /,?\s*free(?:\s+of\s+charge)?(?=\s*[.,;]|\s*$)/gi,
  /\s*(?:it'?s|and it'?s|this is)\s+(?:completely\s+)?free\b\.?/gi,
  /,?\s*yours (?:to keep )?either way\b/gi,
  /,?\s*(?:and\s+)?(?:it'?s|it is)\s+yours (?:to keep )?(?:either way|whether[^.]*)/gi,
];

/** Sentences whose only job is to justify the free work. Dropped whole. */
const SENTENCES = [
  /\bno (?:catch|strings|obligation|invoice|bill)\b/i,
  /\byours (?:to keep )?(?:either way|whether we work together or not)\b/i,
  /\bi'?m not (?:going to )?(?:charge|charging) you\b/i,
  /\bwon'?t cost you (?:a thing|anything|a cent|a penny)\b/i,
];

const MENTIONS_FREE = /\bfree\b|no charge|at no cost|yours (?:to keep )?either way/i;

function clean(text) {
  if (!text || !MENTIONS_FREE.test(text)) return null;
  const paras = String(text).split(/\n\n+/).map(p => {
    const sentences = p.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) || [p];
    return sentences
      .filter(s => !SENTENCES.some(re => re.test(s)))
      .map(s => {
        let out = s;
        for (const re of CLAUSES) out = out.replace(re, '');
        // A clause removal can leave " ." or a doubled comma.
        return out.replace(/\s+([.,;!?])/g, '$1').replace(/,\s*([.;])/g, '$1').replace(/\s{2,}/g, ' ');
      })
      .join('')
      .trim();
  }).filter(Boolean);

  const out = paras.join('\n\n').trim();
  if (out === String(text).trim()) return null;
  // Refuse to gut an email. A body carrying {{ASK}} gains ~20 words at send time; one without
  // it has to stand alone. Anything shorter than this is left for regen-copy to rewrite.
  const floor = out.includes('{{ASK}}') ? 25 : 40;
  if (out.split(/\s+/).length < floor) return null;
  if (MENTIONS_FREE.test(out.replace(/\{\{ASK\}\}/g, ''))) return null; // did not fully clean
  return out;
}

(async () => {
  let rows = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await supabase.from('leads')
      .select(`id, business_name, sequence_step, ${FIELDS.join(', ')}`)
      .eq('status', 'queued').range(f, f + 999);
    if (error) throw new Error(error.message);
    rows = rows.concat(data);
    if (data.length < 1000) break;
  }

  let changed = 0, skipped = 0, samples = 0;
  for (const r of rows) {
    const patch = {};
    for (const field of unsentFields(r.sequence_step)) {
      const out = clean(r[field]);
      if (out !== null) patch[field] = out;
      else if (MENTIONS_FREE.test(String(r[field] || '').replace(/\{\{ASK\}\}/g, ''))) skipped++;
    }
    if (!Object.keys(patch).length) continue;
    changed++;
    if (samples < 4) {
      samples++;
      const f = Object.keys(patch)[0];
      console.log(`\n--- ${r.business_name} [${f}]\nBEFORE: ${String(r[f]).replace(/\n/g, ' ')}\nAFTER : ${patch[f].replace(/\n/g, ' ')}`);
    }
    if (!DRY) {
      const { error } = await supabase.from('leads').update(patch).eq('id', r.id);
      if (error) console.error(`  ${r.id}: ${error.message}`);
    }
  }
  console.log(`\n${DRY ? '[dry] would update' : 'updated'} ${changed} leads. ${skipped} field(s) left for regen-copy (too short after cleaning, or an unrecognised shape).`);
})();
