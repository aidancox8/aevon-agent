#!/usr/bin/env node
/**
 * Convert already-written closing asks into the {{ASK}} token.
 *
 * Without this, every queued email that already ends with an ask would get a SECOND one
 * appended at send time, because applyAsk falls back to appending when it finds no token.
 * Tokenizing them means the stored copy holds only the personalized part, so they behave
 * exactly like newly generated emails and pick up whatever lib/offer.js currently says.
 *
 *   node tokenize-asks.js --dry
 *   node tokenize-asks.js --table tempo_leads
 */
require('dotenv').config();
const supabase = require('./lib/supabase');
const { AEVON_ASKS, TEMPO_ASKS } = require('./lib/offer');

const DRY = process.argv.includes('--dry');
const TABLE = (() => {
  const i = process.argv.indexOf('--table');
  const t = i > -1 ? process.argv[i + 1] : 'leads';
  if (!['leads', 'tempo_leads'].includes(t)) throw new Error('--table must be leads or tempo_leads');
  return t;
})();

(async () => {
  const known = TABLE === 'tempo_leads' ? TEMPO_ASKS : AEVON_ASKS;
  const rows = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await supabase.from(TABLE)
      .select('id, business_name, email_body')
      .eq('status', 'queued').is('last_sent_at', null).not('email_body', 'is', null)
      .range(f, f + 999);
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
  }

  let tokenized = 0, already = 0, noMatch = 0;
  for (const r of rows) {
    const body = r.email_body;
    if (body.includes('{{ASK}}')) { already++; continue; }

    let next;
    const hit = known.find(a => body.includes(a));
    if (hit) {
      next = body.replace(hit, '{{ASK}}');
    } else {
      // Copy the model wrote under the older prompt: it already carries its own offer and
      // closing question, so appending the token's ask at send time would produce two asks
      // in one email. Strip the trailing sentences that ARE the ask (a closing question, or
      // a sentence promising the free build) and let the token supply the current one.
      const sentences = body.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g);
      if (!sentences || sentences.length < 3) { noMatch++; continue; }
      const isAsk = s => /\?\s*$/.test(s.trim())
        || /\b(i'?(ll|d)\s+build|build (a working version|it for you|the first version)|for free|no charge|free (of charge|while)|yours either way)\b/i.test(s);
      let end = sentences.length;
      while (end > 0 && isAsk(sentences[end - 1])) end--;
      const head = sentences.slice(0, end).join('').trim();
      // Refuse to gut the email. If removing the ask leaves almost nothing, the personalized
      // part was never really there, so leave it for a proper rewrite.
      if (end === sentences.length || head.split(/\s+/).filter(Boolean).length < 20) { noMatch++; continue; }
      next = `${head} {{ASK}}`;
    }
    next = next.replace(/\s+\{\{ASK\}\}/, ' {{ASK}}').trim();
    if (DRY) { if (tokenized < 2) console.log(`\n--- ${r.business_name}\n${next}`); tokenized++; continue; }
    const { error } = await supabase.from(TABLE).update({ email_body: next }).eq('id', r.id);
    if (error) { console.log(`  failed ${r.business_name}: ${error.message}`); continue; }
    tokenized++;
    if (tokenized % 500 === 0) console.log(`  ${tokenized} tokenized...`);
  }
  console.log(`\n${DRY ? 'Would tokenize' : 'Tokenized'} ${tokenized} | already had token ${already} | no known ask ${noMatch}`);
})().catch(e => { console.error('tokenize failed:', e.message); process.exit(1); });
