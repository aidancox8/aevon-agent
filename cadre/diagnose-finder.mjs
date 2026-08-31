/**
 * Where does the finder actually lose results?
 *
 * The log line "51 hits +0" reads as "51 results, none of them new". It is not: most results
 * are never examined at all. This measures one query end to end and prints the real funnel, so
 * the ceiling is a number rather than an assumption.
 *
 *   node cadre/diagnose-finder.mjs "training matrix" ontario
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import axios from 'axios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const phrase = process.argv[2] || 'training matrix';
const place = process.argv[3] || 'ontario';
const host = 'https://www.simplyhired.ca';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9',
  'Accept-Language': 'en-CA,en;q=0.9',
};

const url = `${host}/search?q=${encodeURIComponent('"' + phrase + '"')}&l=${encodeURIComponent(place)}`;
const res = await axios.get(url, { headers: HEADERS, timeout: 30000 });
const m = res.data.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
if (!m) { console.log('no __NEXT_DATA__ found'); process.exit(1); }
const data = JSON.parse(m[1]);

// Walk the blob for the jobs array rather than guessing its path, which moves between releases.
let jobs = [];
(function walk(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    if (node.length && node[0] && (node[0].company || node[0].employer) && (node[0].title || node[0].jobTitle)) {
      if (node.length > jobs.length) jobs = node;
    }
    node.forEach(walk);
    return;
  }
  Object.values(node).forEach(walk);
})(data);

const norm = (s) => String(s || '').toLowerCase();
const withPhraseInSnippet = jobs.filter(j => norm(j.snippet || j.jobDescription || '').includes(phrase.toLowerCase()));

console.log(`query: "${phrase}" / ${place}`);
console.log(`  results returned on page 1      : ${jobs.length}`);
console.log(`  snippet already contains phrase : ${withPhraseInSnippet.length}`);
console.log(`  would need a deep fetch         : ${jobs.length - withPhraseInSnippet.length}`);
console.log(`  DEEP_PER_QUERY cap in the finder: 6`);
const needed = jobs.length - withPhraseInSnippet.length;
const skipped = Math.max(0, needed - 6);
console.log(`  => never examined at all        : ${skipped}  (${jobs.length ? Math.round((skipped / jobs.length) * 100) : 0}% of the page)`);
console.log();
const companies = [...new Set(jobs.map(j => (j.company || j.employer || '').trim()).filter(Boolean))];
console.log(`  distinct companies on this page : ${companies.length}`);
console.log(`  sample: ${companies.slice(0, 6).join(' | ')}`);
