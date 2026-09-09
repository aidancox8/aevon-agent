#!/usr/bin/env node
/**
 * cadre/site-contacts.js, find a published address on the company's own website.
 *
 * 195 queued leads have a website and no email (2026-09-08). The paid route (treg) is out of
 * balance and SimplyHired now 403s the job pages ad-contacts.js read. A company's own site is
 * the one source nobody blocks: contact, careers and about pages carry the addresses they want
 * mail sent to. An address the company printed is a different thing from a guessed one; the
 * guessed hr@ batch bounced 3 of 4.
 *
 * Preference order on what it finds: a hiring inbox (hr@, careers@, jobs@, recruiting@), then a
 * named person (first.last@), then the generic front door (info@, office@). Anything on another
 * domain is ignored. Writes at status queued with email_quality role / personal / generic, which
 * is the same tiering the scheduler already ranks by.
 *
 *   node cadre/site-contacts.js --dry --limit 20
 *   node cadre/site-contacts.js --limit 200
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const axios = require('axios');
const supabase = require('../lib/supabase');

const DRY = process.argv.includes('--dry');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > -1 ? parseInt(process.argv[i + 1], 10) : 50; })();
const PAGES = ['', '/contact', '/contact-us', '/careers', '/jobs', '/about', '/about-us', '/team', '/join-us', '/employment'];
const GAP_MS = 900;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-CA,en;q=0.9',
};
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// Anywhere in the local part, not just at the start: residential.sales@ is still sales.
const NOT_A_PERSON = /^(noreply|no-reply|donotreply|webmaster|postmaster|abuse|ar|ap|dpo|admin)@|(privacy|legal|press|media|marketing|sales|support|billing|account|order|service|newsletter|unsubscribe|example|test|security|gdpr|compliance|invoice|payable|receivable|quote|estimat|dispatch|parts|rental|leasing|donat|volunteer|tender|bid|procure|purchas|vendor|supplier)/i;
const HIRING = /^(hr|humanresources|human\.resources|careers?|jobs?|recruit(ing|ment)?|hiring|resumes?|talent|people|employment|apply|work)@/i;
const GENERIC = /^(info|office|hello|contact|enquiries|inquiries|reception|general|mail|admin)@/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|css|js)$/i;

function apexOf(website) {
  try {
    const h = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.toLowerCase().replace(/^www\./, '');
    const p = h.split('.');
    return p.length > 2 && p[p.length - 2].length <= 3 ? p.slice(-3).join('.') : p.slice(-2).join('.');
  } catch (e) { return null; }
}
function baseOf(website) { return (/^https?:\/\//i.test(website) ? website : `https://${website}`).replace(/\/+$/, ''); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** mailto: links first (they are deliberate), then anything in the text, then "name at domain dot com". */
function extract(html, apex) {
  const found = new Set();
  const h = String(html);
  for (const m of h.matchAll(/mailto:([^"'?\s>]+)/gi)) { try { found.add(decodeURIComponent(m[1]).toLowerCase()); } catch (e) { /* malformed */ } }
  for (const m of h.matchAll(/data-cfemail="([0-9a-f]+)"/gi)) found.add(cfDecode(m[1]).toLowerCase());
  const text = h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&#64;|&commat;/g, '@');
  for (const m of text.matchAll(EMAIL_RE)) found.add(m[0].toLowerCase());
  for (const m of text.matchAll(/([a-z0-9._-]+)\s*(?:\[at\]|\(at\)|\s+at\s+)\s*([a-z0-9.-]+)\s*(?:\[dot\]|\(dot\)|\s+dot\s+)\s*([a-z]{2,})/gi)) found.add(`${m[1]}@${m[2]}.${m[3]}`.toLowerCase());
  // Same brand on another TLD counts (rfnow.com publishes @rfnow.net); anything else is a vendor.
  const brand = apex.split('.')[0];
  const sameBrand = (e) => e.endsWith('@' + apex) || e.split('@')[1].split('.')[0] === brand;
  return [...found].filter((e) => !IMAGE_EXT.test(e) && !NOT_A_PERSON.test(e) && sameBrand(e));
}

function classify(emails) {
  const hiring = emails.find((e) => HIRING.test(e));
  if (hiring) return { email: hiring, quality: 'role' };
  // Two-part local parts only. A single token (custexp@) is a function mailbox more often than a
  // person, and a wrong name on a cold email is worse than "Hi there".
  const person = emails.find((e) => /^[a-z]{2,}[._-][a-z]{2,}@/.test(e) && !/^(business|customer|client|general|human|first|last|front|head)[._-]/.test(e));
  if (person) return { email: person, quality: 'personal' };
  const generic = emails.find((e) => GENERIC.test(e));
  if (generic) return { email: generic, quality: 'generic' };
  return null;
}

/**
 * Fetch with a real browser when one is available. proslide.com answers 403 to every Node TLS
 * handshake and 200 to Chrome and curl; that is fingerprinting, not a header we can set. Chrome
 * also runs the page, so addresses injected by script or hidden behind Cloudflare's email
 * obfuscation come out as text. Playwright lives in the cadre-app-src checkout, not here.
 */
let browser = null, chromium = null;
try { ({ chromium } = require('C:/Users/Aidan/projects/cadre-app-src/node_modules/playwright')); } catch (e) { chromium = null; }
async function fetchPage(url) {
  if (chromium) {
    try {
      if (!browser) browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
      const ctx = await browser.newContext({ userAgent: HEADERS['User-Agent'], ignoreHTTPSErrors: true, locale: 'en-CA' });
      await ctx.route('**/*', (r) => (['image', 'media', 'font', 'stylesheet'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
      const page = await ctx.newPage();
      let html = null;
      try {
        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        if (res && res.status() === 200) { await page.waitForTimeout(800); html = await page.content(); }
      } catch (e) { html = null; }
      await ctx.close();
      return html;
    } catch (e) { /* fall through to plain HTTP */ }
  }
  try {
    const res = await axios.get(url, { headers: HEADERS, timeout: 15000, maxRedirects: 4, validateStatus: () => true, responseType: 'text', maxContentLength: 2_000_000 });
    return res.status === 200 && /html/i.test(res.headers['content-type'] || '') ? String(res.data) : null;
  } catch (e) { return null; }
}

/** Cloudflare's obfuscation: data-cfemail="hex", first byte is the key. */
function cfDecode(hex) {
  const k = parseInt(hex.slice(0, 2), 16); let out = '';
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ k);
  return out;
}

(async () => {
  const { data, error } = await supabase.from('cadre_leads')
    .select('id, business_name, website, staff_estimate, qualification_score')
    .eq('status', 'queued').is('email', null).not('website', 'is', null)
    .order('qualification_score', { ascending: false, nullsFirst: false })
    .limit(LIMIT);
  if (error) throw new Error(error.message);
  console.log(`${DRY ? 'DRY RUN: ' : ''}${data.length} site(s) to read.\n`);

  const tally = { role: 0, personal: 0, generic: 0, none: 0, dead: 0 };
  for (const lead of data) {
    const apex = apexOf(lead.website);
    const tag = String(lead.business_name).slice(0, 30).padEnd(32);
    if (!apex) { tally.dead++; console.log(`  --   ${tag}bad website`); continue; }
    const base = baseOf(lead.website);
    const all = new Set(); let alive = false;
    for (const p of PAGES) {
      const html = await fetchPage(base + p);
      await sleep(GAP_MS);
      if (!html) continue;
      alive = true;
      for (const e of extract(html, apex)) all.add(e);
      // A hiring inbox on the contact page ends the search; nothing on a deeper page beats it.
      if ([...all].some((e) => HIRING.test(e))) break;
    }
    if (!alive) { tally.dead++; console.log(`  --   ${tag}unreachable`); continue; }
    const pick = classify([...all]);
    if (!pick) { tally.none++; console.log(`  --   ${tag}no address on ${apex}`); continue; }
    tally[pick.quality]++;
    console.log(`  ok   ${tag}${pick.email.padEnd(36)}${pick.quality}${all.size > 1 ? `   (+${all.size - 1} more)` : ''}`);
    if (DRY) continue;
    const { error: e } = await supabase.from('cadre_leads')
      .update({ email: pick.email, email_quality: pick.quality, email_hunt_attempted_at: new Date().toISOString(), notes: `site-contacts: published on ${apex}${all.size > 1 ? '; also ' + [...all].filter((x) => x !== pick.email).slice(0, 3).join(', ') : ''}` })
      .eq('id', lead.id).is('email', null);
    if (e) console.log(`       write failed: ${e.message}`);
  }
  console.log(`\nrole ${tally.role} | personal ${tally.personal} | generic ${tally.generic} | none ${tally.none} | dead ${tally.dead}`);
  if (!DRY && (tally.role + tally.personal + tally.generic)) console.log('Next: node cadre/personalizer.js --limit 200, then node cadre/schedule.js');
  if (browser) await browser.close();
  console.log('SITE_CONTACTS_DONE');
})().catch((e) => { console.error('site-contacts failed:', e.message); process.exit(1); });
