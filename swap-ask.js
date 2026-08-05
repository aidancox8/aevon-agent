#!/usr/bin/env node
/**
 * Replace the closing ask in queued copy: "want a 90-second demo?" becomes the free build.
 *
 * Why not just let regen-copy rewrite these properly? Because it does ~280 a night against a
 * shared API budget, and ~3,000 queued emails still ask people to watch a demo. At 57 initial
 * sends a day that is weeks of asking for the wrong thing, and the point of the offer change
 * was to get conversations started now.
 *
 * This is surgical: the last sentence of these emails is formulaic ("Happy to send over a
 * 90-second demo?", "Reply yes and I'll send it over"), so it can be swapped without touching
 * the personalized opening, which is the part worth keeping. Anything that does not match a
 * known shape is left alone for the full rewrite.
 *
 *   node swap-ask.js --dry
 *   node swap-ask.js --table tempo_leads
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

// The stock closers the old prompt produced.
const DEMO_ASK = /(happy to |i'?d be happy to )?(just )?(reply|send)[^.!?]*?(90[- ]second demo|demo)[^.!?]*[.!?]|(happy to send[^.!?]*[.!?])|(want (to see )?a[^.!?]*demo[^.!?]*[.!?])|(reply with ['"]?yes['"]?[^.!?]*[.!?])|(just reply ['"]?yes['"]?[^.!?]*[.!?])/gi;

// Varied so a batch does not read as one mail merge. Each asks a real question that is
// interesting to answer and costs one line, and each leads with the free build rather than
// asking someone to watch something.
const AEVON_ASKS = [
  "If you tell me the one job your team does by hand, I'll build a working version of it for you, free. Which one would you pick?",
  "Name the one manual job you'd hand over tomorrow and I'll build it for you, free, yours either way.",
  "I'll build one of these for you free while I'm early and taking on a few. What's the job that eats the most time?",
  "Tell me the one thing your team still does by hand and I'll build it, free. It's yours whether we work together or not.",
  "What's the one manual job you'd get rid of first? I'll build a working version of it for you, no charge.",
];

const TEMPO_ASKS = [
  "I'll set Tempo up around your clinic and you can run it free for two weeks. Who builds your schedule now, and how long does it take them?",
  "Want me to set it up for your rooms and disciplines? Two weeks free, and nothing to cancel if you walk away.",
  "I'm setting up the first few clinics myself to get it right. Two weeks free, built around your week. Worth a look at yours?",
  "Say the word and I'll build your first week around your actual rooms and staff. Free for two weeks.",
];

// Anything still pitching a demo or a one-word yes has to go, not just the final sentence.
// Cutting only the last match left emails reading "Want to see a 90-second demo? Name the one
// manual job you'd hand over" — two competing asks, which is worse than the original.
const MENTIONS_DEMO = /(90[- ]?second demo|\bdemo\b|reply\s+with\s+['"]?yes|just\s+reply\s+['"]?yes)/i;

function swap(text, asks, i) {
  if (!text) return null;
  if (!MENTIONS_DEMO.test(text)) return null;

  const paras = String(text).split(/\n\n+/);
  const cleaned = paras.map(p => {
    const sentences = p.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) || [p];
    return sentences.filter(s => !MENTIONS_DEMO.test(s)).join('').replace(/\s+/g, ' ').trim();
  }).filter(Boolean);

  const head = cleaned.join('\n\n').trim();
  // If removing every demo mention guts the email, leave it for the full rewrite rather than
  // sending a stub.
  if (head.split(/\s+/).filter(Boolean).length < 20) return null;
  return `${head} ${asks[i % asks.length]}`;
}

(async () => {
  const asks = TABLE === 'tempo_leads' ? TEMPO_ASKS : AEVON_ASKS;
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

  let changed = 0, left = 0;
  for (const [i, r] of rows.entries()) {
    const next = swap(r.email_body, asks, i);
    if (!next) { left++; continue; }
    if (DRY) {
      if (changed < 3) console.log(`\n--- ${r.business_name}\n${next}`);
      changed++;
      continue;
    }
    const { error } = await supabase.from(TABLE).update({ email_body: next }).eq('id', r.id);
    if (error) { console.log(`  failed ${r.business_name}: ${error.message}`); continue; }
    changed++;
    if (changed % 250 === 0) console.log(`  ${changed} swapped...`);
  }
  console.log(`\n${DRY ? 'Would swap' : 'Swapped'} ${changed} | left for full rewrite ${left}`);
})().catch(e => { console.error('swap failed:', e.message); process.exit(1); });
