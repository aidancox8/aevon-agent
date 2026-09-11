#!/usr/bin/env node
/**
 * cadre/size-from-site.js, read a company's own website for a stated employee count.
 *
 * staff_estimate drives qualification_score and the 1-99 staff filter, but most queued and
 * needs_review leads have no estimate at all. treg (paid enrichment) is metered and SimplyHired
 * job pages 403 every job. A company's own about/careers page is free and sometimes states its
 * headcount directly ("a team of 40 technicians"). That is a fact the company printed about
 * itself, not a guess, so it is worth taking at face value when the sentence is clearly about
 * staff and not customers, locations, or years in business.
 *
 * Never falls back to guessing: a lead with nothing stated gets 'nothing stated' recorded in
 * notes so it is not re-opened every run, and staff_estimate stays null.
 *
 *   node cadre/size-from-site.js --dry --limit 20
 *   node cadre/size-from-site.js --limit 60
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const axios = require('axios');
const supabase = require('../lib/supabase');

const DRY = process.argv.includes('--dry');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > -1 ? parseInt(process.argv[i + 1], 10) : 60; })();
const MAX_PAGES = 5;
const NAV_TIMEOUT_MS = 15000;
const LINK_RE = /about|company|who-we-are|our-story|careers|join/i;
const NOT_STAFF = /clients|customers|patients|members|students|locations|projects|years|sq|square|vehicles|units|beds|children|families/i;
// Number then a staff noun, with an optional hedge word in front ("over", "approximately", ...).
const STAFF_COUNT_RE = /\b(?:over|more than|nearly|approximately|about|around|roughly)?\s*([0-9][0-9,]{1,5})\+?\s*(?:employees|staff|team members|people|professionals|associates|colleagues|workers|technicians|nurses|drivers)\b/gi;
// "team of 40", "staff of over 200", "workforce of approximately 30".
const OF_COUNT_RE = /\b(?:team|staff|workforce) of\s*(?:over|more than|nearly|approximately|about|around)?\s*([0-9][0-9,]{1,5})\+?/gi;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-CA,en;q=0.9',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function baseOf(website) { return (/^https?:\/\//i.test(website) ? website : `https://${website}`).replace(/\/+$/, ''); }
function hostOf(url) { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return null; } }

/** Sentence around a match, capped at 160 chars, so the write shows the actual claim, not a stray number. */
function sentenceAround(text, start, end) {
  const left = text.lastIndexOf('.', start);
  const right = text.indexOf('.', end);
  const from = left === -1 ? Math.max(0, start - 80) : left + 1;
  const to = right === -1 ? Math.min(text.length, end + 80) : right + 1;
  let s = text.slice(from, to).replace(/\s+/g, ' ').trim();
  if (s.length > 160) s = text.slice(Math.max(0, start - 80), start + 80).replace(/\s+/g, ' ').trim();
  return s.slice(0, 160);
}

/** Every surviving (number, sentence) hit in one page's text, largest number first. */
function findCounts(text) {
  const hits = [];
  for (const re of [STAFF_COUNT_RE, OF_COUNT_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const num = parseInt(m[1].replace(/,/g, ''), 10);
      if (Number.isNaN(num) || num < 5 || num > 100000) continue;
      const sentence = sentenceAround(text, m.index, m.index + m[0].length);
      if (NOT_STAFF.test(sentence)) continue;
      hits.push({ num, sentence });
    }
  }
  hits.sort((a, b) => b.num - a.num);
  return hits;
}

/**
 * Headless system Chrome via playwright, same reasoning as site-contacts.js: some sites answer
 * 403 or serve a JS shell to a plain Node request and 200 to a real browser. Playwright lives in
 * the cadre-app-src checkout, not here.
 */
let browser = null, chromium = null;
try { ({ chromium } = require('C:/Users/Aidan/projects/cadre-app-src/node_modules/playwright')); } catch (e) { chromium = null; }

async function textViaHttp(url) {
  try {
    const res = await axios.get(url, { headers: HEADERS, timeout: NAV_TIMEOUT_MS, maxRedirects: 4, validateStatus: () => true, responseType: 'text', maxContentLength: 2_000_000 });
    if (res.status !== 200 || !/html/i.test(res.headers['content-type'] || '')) return null;
    return String(res.data).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ');
  } catch (e) { return null; }
}

/** Loads a page, returns { text, links } where links are same-host anchors matching LINK_RE. Null on failure. */
async function loadPage(page, url, host) {
  if (page) {
    try {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      if (!res || res.status() >= 400) return null;
      const text = await page.evaluate(() => document.body ? document.body.innerText : '');
      const links = await page.$$eval('a', (els) => els.map((a) => ({ href: a.href, text: a.textContent || '' })));
      const found = [];
      const seen = new Set();
      for (const l of links) {
        if (!l.href || !LINK_RE.test(l.href) && !LINK_RE.test(l.text)) continue;
        let h; try { h = new URL(l.href).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { continue; }
        if (h !== host || seen.has(l.href)) continue;
        seen.add(l.href);
        found.push(l.href);
      }
      return { text, links: found };
    } catch (e) { return null; }
  }
  const text = await textViaHttp(url);
  if (text === null) return null;
  return { text, links: [] }; // no DOM to read hrefs from over plain HTTP, homepage-only fallback
}

(async () => {
  const { data, error } = await supabase.from('cadre_leads')
    .select('id, business_name, website, staff_estimate, qualification_score, status, notes')
    .in('status', ['queued', 'needs_review']).is('staff_estimate', null).not('website', 'is', null)
    .order('qualification_score', { ascending: false, nullsFirst: false })
    .limit(LIMIT);
  if (error) throw new Error(error.message);

  const leads = data.filter((l) => !String(l.notes || '').includes('size-from-site:'));
  console.log(`${DRY ? 'DRY RUN: ' : ''}${leads.length} site(s) to read (${data.length - leads.length} already tried, skipped).\n`);

  if (chromium && !browser) browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });

  const tally = { found: 0, none: 0, dead: 0 };
  for (const lead of leads) {
    const tag = String(lead.business_name).slice(0, 30).padEnd(32);
    const home = baseOf(lead.website);
    const host = hostOf(home);
    if (!host) { tally.dead++; console.log(`  --   ${tag}unreachable`); continue; }

    let ctx = null, page = null;
    if (browser) { ctx = await browser.newContext({ userAgent: HEADERS['User-Agent'], ignoreHTTPSErrors: true, locale: 'en-CA' }); await ctx.route('**/*', (r) => (['image', 'media', 'font'].includes(r.request().resourceType()) ? r.abort() : r.continue())); page = await ctx.newPage(); }

    const pages = [home];
    let alive = false;
    const allHits = [];
    for (let i = 0; i < pages.length && i < MAX_PAGES; i++) {
      const loaded = await loadPage(page, pages[i], host);
      await sleep(300);
      if (!loaded) continue;
      alive = true;
      for (const h of findCounts(loaded.text)) allHits.push({ ...h, url: pages[i] });
      if (i === 0) for (const l of loaded.links) { if (!pages.includes(l) && pages.length < MAX_PAGES) pages.push(l); }
    }
    if (ctx) await ctx.close();

    if (!alive) { tally.dead++; console.log(`  --   ${tag}unreachable`); continue; }

    allHits.sort((a, b) => b.num - a.num);
    const best = allHits[0];
    const existingNotes = lead.notes || '';
    if (!best) {
      tally.none++;
      console.log(`  --   ${tag}nothing stated`);
      if (!DRY) {
        const { error: e } = await supabase.from('cadre_leads').update({ notes: `${existingNotes}${existingNotes ? ' | ' : ''}size-from-site: nothing stated` }).eq('id', lead.id);
        if (e) console.log(`       write failed: ${e.message}`);
      }
      continue;
    }
    tally.found++;
    const snippet = best.sentence.slice(0, 80);
    console.log(`  ok   ${tag}${String(best.num).padEnd(6)} ${best.url}  "${snippet}"`);
    if (!DRY) {
      const noteLine = `size-from-site: ${best.url} says "${best.sentence}"`;
      const { error: e } = await supabase.from('cadre_leads').update({ staff_estimate: best.num, notes: `${existingNotes}${existingNotes ? ' | ' : ''}${noteLine}` }).eq('id', lead.id);
      if (e) console.log(`       write failed: ${e.message}`);
    }
  }

  console.log(`\nfound ${tally.found} | nothing ${tally.none} | unreachable ${tally.dead}`);
  if (browser) await browser.close();
  console.log('SIZE_FROM_SITE_DONE');
})().catch((e) => { console.error('size-from-site failed:', e.message); process.exit(1); });
