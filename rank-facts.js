#!/usr/bin/env node
/**
 * rank-facts.js
 * Joins the two fact scans (forms-scan.jsonl, promises-scan.jsonl) into one ranked list of
 * queued Aevon leads that have a checkable fact. Output: cadre/state/fact-leads.json and a
 * printed top N. Every fact still has to be confirmed by hand in a browser before copy is
 * written: static counts overstate (hidden wizard panels, a second form on the page).
 * Usage: node rank-facts.js [--top 30]
 */
const fs = require('fs');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const TOP = parseInt(arg('--top', '30'), 10);
const read = f => { const m = new Map(); for (const l of fs.readFileSync(f, 'utf8').trim().split('\n')) { try { const r = JSON.parse(l); m.set(r.id, r); } catch {} } return m; };
const F = read('cadre/state/forms-scan.jsonl'), P = read('cadre/state/promises-scan.jsonl');
const skip = new Set(JSON.parse(process.env.SKIP_IDS || '[]'));
const ids = new Set([...F.keys(), ...P.keys()].filter(id => !skip.has(id)));
const out = [];
for (const id of ids) {
  const f = F.get(id), p = P.get(id);
  const base = f || p;
  const facts = []; let score = 0;
  const b = f && !f.err && f.best;
  if (b && b.fields >= 25 && b.kind === 'intake') {
    const pages = Math.max(b.wizardPages || 0, b.panels ? b.panels + 1 : 0);
    facts.push({ kind: 'form', text: `${b.fields} fields${pages > 1 ? ` over ${pages} pages` : ''}${b.required ? `, ${b.required} required` : ''}`, url: b.url });
    score += Math.min(b.fields, 120) / 10 + (pages > 1 ? 2 : 0);
  }
  if (p && !p.err) {
    const dead = p.dead.filter(d => d.status === 404 || d.status >= 500).filter(d => /apply|application|quote|intake|get.?started|consult|request|form|book|onboard|new.?client/i.test(d.text + ' ' + d.url));
    if (dead.length) { facts.push({ kind: 'dead', text: `"${dead[0].text}" returns ${dead[0].status}`, url: dead[0].url }); score += 8; }
    const pdf = p.pdfs.filter(x => x.pages >= 2 && !/\bADV\b|brochure|disclosure|relationship summary|form crs|privacy|annual report|prospectus/i.test(x.text + ' ' + x.url)).sort((a, c) => c.pages - a.pages)[0];
    if (pdf) { facts.push({ kind: 'pdf', text: `${pdf.pages}-page PDF "${pdf.text || 'form'}"${pdf.instruction ? ` (${pdf.instruction})` : ''}`, url: pdf.url }); score += Math.min(pdf.pages, 12) / 2 + (pdf.instruction ? 2 : 0); }
    if (p.promise && /\b(we|our team|someone|a member)\b/i.test(p.promise.text)) { facts.push({ kind: 'promise', text: p.promise.text, url: p.promise.page }); score += 2; }
  }
  if (!facts.some(x => x.kind !== 'promise')) continue;   // a promise alone is not a fact worth an email
  out.push({ id, name: base.name, industry: base.industry, city: base.city, website: base.website, score: Math.round(score * 10) / 10, facts });
}
out.sort((a, b) => b.score - a.score);
fs.writeFileSync('cadre/state/fact-leads.json', JSON.stringify(out, null, 1));
const by = out.reduce((m, r) => { for (const x of r.facts) m[x.kind] = (m[x.kind] || 0) + 1; return m; }, {});
console.log(`${out.length} leads with a checkable fact. By kind:`, by);
const ind = out.reduce((m, r) => (m[r.industry] = (m[r.industry] || 0) + 1, m), {});
console.log('By industry:', Object.entries(ind).sort((a, b) => b[1] - a[1]).slice(0, 10));
for (const r of out.slice(0, TOP)) console.log(`${String(r.score).padStart(5)} ${r.industry.slice(0, 20).padEnd(20)} ${r.name.slice(0, 38).padEnd(38)} | ${r.facts.map(x => x.kind + ': ' + x.text).join(' ; ').slice(0, 150)}`);
