#!/usr/bin/env node
/**
 * Preview Tempo copy without touching the database. Mirror of preview-copy.js.
 *   node preview-tempo-copy.js --n 3
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const supabase = require('./lib/supabase');
const { createGenerate } = require('./lib/gemini');
const { scrapeContext } = require('./lib/contact-finder');
const { buildPrompt } = require('./tempo/personalizer');

const generate = createGenerate(process.env.GEMINI_API_KEY);
const N = (() => { const i = process.argv.indexOf('--n'); return i > -1 ? parseInt(process.argv[i + 1], 10) : 3; })();

function parseJsonObject(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/```json/gi, '').replace(/```/g, '');
  const start = s.indexOf('{'); if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

const BOT_TELLS = /often find|rather than|remains |it usually ends up|the nuance of|streamline|leverage|seamless|robust|in today's|we understand|reach out|pain points|hi there/i;

// The stock AI cold-email closes. Escaped question marks matter here: "sound good?" without
// the backslash makes the d optional and matches half the language.
const BOT_CLOSES = /just reply yes|reply yes and|one word back|one word reply is plenty|sound good\?|worth a look\?|let me know if you'?re interested|would you be open to|no pressure|happy to share more|thoughts\?/i;

(async () => {
  const { data } = await supabase.from('tempo_leads')
    .select('id, business_name, industry, city, website, email_subject, email_body')
    .eq('status', 'queued').is('last_sent_at', null).not('email', 'is', null)
    .order('qualification_score', { ascending: false, nullsFirst: false }).limit(N);
  console.log('\nPREVIEW ONLY, nothing saved or sent.\n' + '='.repeat(68));
  for (const lead of data || []) {
    const site = lead.website ? await scrapeContext(lead.website).catch(() => null) : null;
    let out = null;
    for (let a = 0; a < 2 && !out; a++) {
      out = parseJsonObject(await generate(buildPrompt(lead, site, false)).catch(() => null));
    }
    console.log(`\n── ${lead.business_name} · ${lead.industry || ''} · ${lead.city || ''}`);
    if (!out) { console.log('   could not generate'); continue; }
    const body = out.email_body || '';
    console.log(`   SUBJECT: ${out.email_subject}\n`);
    body.split('\n').forEach(l => console.log('   ' + l));
    const words = body.split(/\s+/).filter(Boolean).length;
    const longest = Math.max(...body.split(/[.!?]/).map(s => s.split(/\s+/).filter(Boolean).length));
    console.log(`\n   words ${words} ${words <= 55 ? 'ok' : 'OVER'} | longest sentence ${longest} ${longest <= 20 ? 'ok' : 'OVER'} | close: ${BOT_CLOSES.test(body) ? "TEMPLATE: "+body.match(BOT_CLOSES)[0] : "ok"} | bot tells: ${BOT_TELLS.test(body) ? 'FOUND: ' + body.match(BOT_TELLS)[0] : 'none'}`);
  }
  console.log('\n' + '='.repeat(68) + '\n');
})().catch(e => { console.error('preview failed:', e.message); process.exit(1); });
