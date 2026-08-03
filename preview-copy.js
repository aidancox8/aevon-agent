#!/usr/bin/env node
/**
 * Preview what the personalizer would write, without touching the database.
 *
 * Generates copy for a few real queued leads and prints it. Nothing is saved and nothing
 * is sent, so this is the safe way to read a prompt change before it reaches prospects.
 *
 *   node preview-copy.js            3 leads
 *   node preview-copy.js --n 5      5 leads
 */
require('dotenv').config();
const supabase = require('./lib/supabase');
const { createGenerate } = require('./lib/gemini');
const { scrapeContext } = require('./lib/contact-finder');
const { buildPrompt } = require('./personalizer');

const generate = createGenerate(process.env.GEMINI_API_KEY);
const N = (() => {
  const i = process.argv.indexOf('--n');
  return i > -1 ? Math.max(1, parseInt(process.argv[i + 1], 10) || 3) : 3;
})();

function parseJsonObject(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/```json/gi, '').replace(/```/g, '');
  const start = s.indexOf('{');
  if (start < 0) return null;
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

// The stock AI cold-email closes. Escaped question marks matter here: "sound good?" without
// the backslash makes the d optional and matches half the language.
const BOT_CLOSES = /just reply yes|reply yes and|one word back|one word reply is plenty|sound good\?|worth a look\?|let me know if you'?re interested|would you be open to|no pressure|happy to share more|thoughts\?/i;

(async () => {
  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, business_name, industry, city, website, email, contact_name, contact_role, qualification_score, lead_insights')
    // Deliberately NOT filtered to un-personalized leads: this writes nothing, so it can
    // preview against any real lead, and normally every queued lead already has copy.
    .eq('status', 'queued').is('last_sent_at', null).not('email', 'is', null)
    .order('qualification_score', { ascending: false, nullsFirst: false })
    .limit(N * 4);
  if (error) throw new Error(error.message);
  if (!leads?.length) { console.log('No un-personalized queued leads to preview.'); return; }

  // Prefer leads from different industries, so the sample shows range rather than
  // four versions of the same email.
  const picked = [];
  const seen = new Set();
  for (const l of leads) {
    const k = (l.industry || '').toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); picked.push(l);
    if (picked.length === N) break;
  }
  while (picked.length < Math.min(N, leads.length)) {
    const l = leads.find(x => !picked.includes(x));
    if (!l) break;
    picked.push(l);
  }

  console.log(`\nPREVIEW ONLY — nothing is saved, nothing is sent.\n${'='.repeat(70)}`);
  for (const lead of picked) {
    const site = lead.website ? await scrapeContext(lead.website).catch(() => null) : null;
    let out = null;
    for (let attempt = 0; attempt < 2 && !out; attempt++) {
      const raw = await generate(buildPrompt(lead, site)).catch(e => { console.log('  (generate failed: ' + e.message + ')'); return null; });
      out = parseJsonObject(raw);
    }
    console.log(`\n── ${lead.business_name}  ·  ${lead.industry || 'unknown'}  ·  ${lead.city || ''}`);
    if (!out) { console.log('   could not generate'); continue; }
    console.log(`   SUBJECT: ${out.subject || out.email_subject || '(none)'}`);
    const body = out.body || out.email_body || '';
    console.log();
    body.split('\n').forEach(l => console.log('   ' + l));
    const first = body.trim().split(/[.!?]/)[0] || '';
    const opensWithUs = /^(aevon|we (build|are)|i'?m reaching)/i.test(first.trim());
    console.log(`\n   [opener check] ${opensWithUs ? 'FAIL — still leads with the sender' : 'ok — leads with their world'}`);
    const words = body.split(/\s+/).filter(Boolean).length;
    console.log(`   [word count]   ${words} ${words <= 55 ? 'ok' : 'OVER'}`);
    console.log(`   [close]        ${BOT_CLOSES.test(body) ? 'TEMPLATE: ' + body.match(BOT_CLOSES)[0] : 'ok'}`);
  }
  console.log(`\n${'='.repeat(70)}\n`);
})().catch(e => { console.error('preview failed:', e.message); process.exit(1); });
