#!/usr/bin/env node
/**
 * keyword-mine.js
 *
 * Free keyword research for niche finding. There is no free search-volume source, so this
 * mines what people actually type: Google (gl=ca) and Bing autocomplete, expanded with
 * a-z suffixes. A phrase that returns many distinct, specific suggestions is searched in many
 * forms (a depth signal, not a volume number).
 *
 * Seeds are pain-signalling patterns crossed with industries. Output:
 *   cadre/state/keywords.json   every suggestion, with the seed and source that produced it
 *   cadre/state/keywords.md     per-industry ranking by depth, plus the pain-word hits
 *
 * Usage: node keyword-mine.js [--industries "trucking,electrical contractor"] [--quick]
 */
const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const QUICK = process.argv.includes('--quick');

const INDUSTRIES = (arg('--industries', '') || [
  'construction', 'electrical contractor', 'plumbing', 'hvac', 'trucking', 'fleet', 'manufacturing',
  'warehouse', 'security guard', 'home care', 'long term care', 'daycare', 'restaurant', 'property management',
  'strata', 'landscaping', 'cleaning company', 'roofing', 'excavation', 'mining', 'forestry', 'oil and gas',
  'insurance broker', 'mortgage broker', 'accounting firm', 'law firm', 'dental clinic', 'physiotherapy',
  'veterinary clinic', 'auto repair', 'towing', 'event staffing', 'staffing agency', 'non profit',
].join(',')).split(',').map(s => s.trim()).filter(Boolean);

// {i} = industry. Patterns chosen because they signal a business looking for a fix.
const PATTERNS = [
  '{i} software', '{i} compliance', '{i} template', '{i} checklist', '{i} requirements bc',
  'how to track {i}', '{i} certification tracking', '{i} audit', '{i} renewal', '{i} scheduling',
  '{i} forms', '{i} management software canada',
];
const PAIN = /\b(template|checklist|tracking|tracker|software|requirements|audit|compliance|renewal|expir|log|spreadsheet|excel|form|app|system|portal|api|integration|automation|schedule|scheduling|reminder|record|report)\b/i;
const SUFFIXES = QUICK ? [''] : ['', ...'abcdefghijklmnoprstuvw'.split('')];

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function google(q) {
  try {
    const r = await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&gl=ca&hl=en&q=${encodeURIComponent(q)}`, { headers: { 'user-agent': 'Mozilla/5.0' } });
    const j = JSON.parse(await r.text()); return Array.isArray(j[1]) ? j[1] : [];
  } catch { return []; }
}
async function bing(q) {
  try {
    const r = await fetch(`https://api.bing.com/osjson.aspx?query=${encodeURIComponent(q)}&market=en-CA`, { headers: { 'user-agent': 'Mozilla/5.0' } });
    const j = await r.json(); return Array.isArray(j[1]) ? j[1] : [];
  } catch { return []; }
}

(async () => {
  const rows = [];
  const seen = new Set();
  let calls = 0;
  for (const ind of INDUSTRIES) {
    for (const p of PATTERNS) {
      const seed = p.replace('{i}', ind);
      for (const suf of SUFFIXES) {
        const q = suf ? `${seed} ${suf}` : seed;
        const [g, b] = await Promise.all([google(q), bing(q)]);
        calls += 2;
        for (const [src, list] of [['google', g], ['bing', b]]) {
          for (const s of list) {
            const k = s.toLowerCase().trim();
            if (seen.has(k)) continue;
            seen.add(k);
            rows.push({ industry: ind, seed, source: src, suggestion: k, pain: PAIN.test(k) });
          }
        }
        await sleep(120);
      }
    }
    const n = rows.filter(r => r.industry === ind).length;
    console.log(`${ind.padEnd(24)} ${String(n).padStart(4)} suggestions (${rows.filter(r => r.industry === ind && r.pain).length} pain)`);
  }
  const outDir = path.join(__dirname, 'cadre/state');
  fs.writeFileSync(path.join(outDir, 'keywords.json'), JSON.stringify(rows, null, 1));

  const byInd = INDUSTRIES.map(ind => {
    const r = rows.filter(x => x.industry === ind);
    const pain = r.filter(x => x.pain);
    const bySeed = {};
    for (const x of r) bySeed[x.seed] = (bySeed[x.seed] || 0) + 1;
    return { ind, total: r.length, pain: pain.length, bySeed, sample: pain.slice(0, 25).map(x => x.suggestion) };
  }).sort((a, b) => b.pain - a.pain);
  let md = `# Keyword mining (${new Date().toISOString().slice(0, 10)})\n\nGoogle (gl=ca) + Bing (en-CA) autocomplete, ${calls} calls. Depth = distinct suggestions; "pain" = suggestions containing a tool/compliance word. Not search volume.\n\n| Industry | Suggestions | Pain-word suggestions |\n|---|---|---|\n`;
  for (const x of byInd) md += `| ${x.ind} | ${x.total} | ${x.pain} |\n`;
  for (const x of byInd) {
    md += `\n## ${x.ind}\n\nDepth by seed: ${Object.entries(x.bySeed).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} (${n})`).join(', ')}\n\n`;
    md += x.sample.map(s => `- ${s}`).join('\n') + '\n';
  }
  fs.writeFileSync(path.join(outDir, 'keywords.md'), md);
  console.log(`\n${rows.length} unique suggestions, ${calls} calls. Wrote cadre/state/keywords.md`);
})();
