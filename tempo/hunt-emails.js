/**
 * tempo/hunt-emails.js
 * Deep email hunt for tempo_leads rows that have no email yet.
 *
 * Goes further than lib/contact-finder (which the enrich step already ran):
 *  - decodes Cloudflare email obfuscation (data-cfemail)
 *  - reads JSON-LD structured data (schema.org "email" is common on clinic sites)
 *  - scans raw HTML incl. scripts before stripping (emails hidden in JS/config blobs)
 *  - crawls a wider page set: contact/about/team/book/location/privacy/footer links
 *    plus common paths tried directly (/contact, /contact-us, /about-us, ...)
 *
 * Only emails actually published by the clinic are saved (no guessing), and
 * addresses on the clinic's own domain are preferred over third-party ones.
 *
 * Usage: node tempo/hunt-emails.js [--dry-run]
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const axios = require('axios');
const cheerio = require('cheerio');
const supabase = require('../lib/supabase');
const { classifyEmail } = require('../lib/contact-finder');

const TABLE = 'tempo_leads';
const DRY = process.argv.includes('--dry-run');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PAGE_CAP = 10;

const COMMON_PATHS = [
  '/contact', '/contact-us', '/contactus', '/contact.html',
  '/about', '/about-us', '/team', '/our-team', '/staff',
  '/locations', '/book', '/book-online', '/appointments', '/privacy-policy',
];

const LINK_WANTED = /contact|about|team|staff|meet|location|book|appointment|privacy|career|join/i;

// Filenames / vendor noise that regex-scans of raw HTML always pick up.
const JUNK_RE = /\.(png|jpe?g|gif|svg|webp|css|js|woff2?)$|sentry|wixpress|example\.com|sentry\.io|@2x|@3x|schema\.org|placeholder|yourdomain|youremail|email@|test@|user@|name@/i;

function decodeCfEmail(hex) {
  try {
    const r = parseInt(hex.slice(0, 2), 16);
    let out = '';
    for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ r);
    return out.toLowerCase();
  } catch { return null; }
}

function valid(e) {
  return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e) && !JUNK_RE.test(e) && e.length <= 60;
}

async function fetchRaw(url) {
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      maxRedirects: 4,
      maxContentLength: 3 * 1024 * 1024,
      responseType: 'text',
      validateStatus: s => s === 200,
    });
    return typeof res.data === 'string' ? res.data : null;
  } catch { return null; }
}

// Extract every plausible email from one page's raw HTML.
function extractEmails(html) {
  const found = new Set();
  const $ = cheerio.load(html);

  // 1) mailto links — authoritative
  $('a[href^="mailto:"]').each((_, el) => {
    const addr = ($(el).attr('href') || '').replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
    if (addr.includes('@')) found.add(addr);
  });

  // 2) Cloudflare obfuscation
  $('[data-cfemail]').each((_, el) => {
    const e = decodeCfEmail($(el).attr('data-cfemail') || '');
    if (e && e.includes('@')) found.add(e);
  });
  (html.match(/\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/gi) || []).forEach(m => {
    const e = decodeCfEmail(m.split('#')[1] || '');
    if (e && e.includes('@')) found.add(e);
  });

  // 3) JSON-LD structured data ("email": "...")
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).html() || '';
    (raw.match(/"email"\s*:\s*"([^"]+@[^"]+)"/gi) || []).forEach(m => {
      const e = m.replace(/^"email"\s*:\s*"/i, '').replace(/"$/, '').replace(/^mailto:/i, '').trim().toLowerCase();
      if (e.includes('@')) found.add(e);
    });
  });

  // 4) visible text with tags spaced out (no gluing)
  const textish = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    // "name [at] domain" / "name (at) domain" — delimiters REQUIRED so the "at"
    // inside a word (elev-AT-ionrehab.ca) is never rewritten into a fake address
    .replace(/\s+[\[(]\s*at\s*[\])]\s+/gi, '@')
    .replace(/\s+[\[(]\s*dot\s*[\])]\s+/gi, '.');
  (textish.match(EMAIL_RE) || []).forEach(m => found.add(m.toLowerCase()));

  // 5) raw HTML incl. scripts/config blobs (catches emails in JS settings)
  (html.match(EMAIL_RE) || []).forEach(m => found.add(m.toLowerCase()));

  return [...found].filter(valid);
}

function siteHost(url) {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; }
}

// Multi-location clinics publish per-branch inboxes (langley@, kitsilano@...).
// Those reach a front desk, not a person — rank them below a real name.
const LOCATION_WORDS = new Set([
  'vancouver', 'burnaby', 'surrey', 'richmond', 'langley', 'coquitlam', 'abbotsford',
  'delta', 'cloverdale', 'fleetwood', 'sullivan', 'nordel', 'newwestminster', 'whiterock',
  'mapleridge', 'portcoquitlam', 'northvancouver', 'westvancouver', 'kinggeorge',
  'centralcity', 'cedarhills', 'clayton', 'southsurrey', 'kitsilano', 'kits',
  'downtown', 'metrotown', 'eastvan', 'westside', 'eastside', 'mainstreet', 'broadway',
]);
function isLocationInbox(e) {
  const local = e.split('@')[0].replace(/[._-]/g, '').replace(/^info/, '');
  return LOCATION_WORDS.has(local);
}

// Inboxes that exist but are the WRONG place for a business pitch.
const LAST_RESORT = /^(careers?|jobs?|hr|recruit(ing|ment)?|volunteers?|privacy|legal|billing|accounting|payroll|noreply|no-reply|donotreply|webmaster)$/;
function effectiveQuality(e) {
  if (LAST_RESORT.test(e.split('@')[0])) return 'last-resort';
  if (isLocationInbox(e)) return 'generic';
  return classifyEmail(e);
}

function pickBest(emails, website) {
  if (!emails.length) return null;
  const host = siteHost(website);
  const rank = e => {
    const onDomain = e.split('@')[1] === host || e.split('@')[1] === 'www.' + host ? 2 : 0;
    const q = { personal: 3, role: 2, generic: 1 }[effectiveQuality(e)] || 0;
    return onDomain * 10 + q; // own-domain first, then quality
  };
  return emails.sort((a, b) => rank(b) - rank(a))[0];
}

async function huntSite(website) {
  const home = await fetchRaw(website);
  const emails = new Set();
  const pages = [];

  if (home) {
    extractEmails(home).forEach(e => emails.add(e));
    // gather internal links worth visiting
    const $ = cheerio.load(home);
    const links = new Set();
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href || !LINK_WANTED.test(href)) return;
      try {
        const u = new URL(href, website);
        if (u.host === new URL(website).host) links.add(u.href.split('#')[0]);
      } catch { /* ignore */ }
    });
    COMMON_PATHS.forEach(p => { try { links.add(new URL(p, website).href); } catch { /* ignore */ } });
    for (const url of [...links].slice(0, PAGE_CAP)) {
      pages.push(url);
      const html = await fetchRaw(url);
      if (html) extractEmails(html).forEach(e => emails.add(e));
      if ([...emails].some(e => classifyEmail(e) === 'personal')) break; // good enough
    }
  }
  return { emails: [...emails], pagesTried: pages.length + 1 };
}

async function run() {
  const { data: rows, error } = await supabase.from(TABLE)
    .select('id, business_name, website')
    .is('email', null)
    .not('website', 'is', null)
    .order('qualification_score', { ascending: false });
  if (error) throw new Error(error.message);
  console.log(`[Tempo] Hunting emails for ${rows.length} clinics without one...${DRY ? ' (dry run)' : ''}\n`);

  let updated = 0;
  for (const row of rows) {
    process.stdout.write(`[${row.business_name}] `);
    const { emails, pagesTried } = await huntSite(row.website);
    const best = pickBest(emails, row.website);
    if (!best) { console.log(`nothing found (${pagesTried} pages)`); continue; }

    const quality = effectiveQuality(best) === 'last-resort' ? 'generic' : effectiveQuality(best);
    const others = emails.filter(e => e !== best).slice(0, 8);
    const offDomain = best.split('@')[1] !== siteHost(row.website);
    console.log(`${best} (${quality}${offDomain ? ', OFF-DOMAIN' : ''}, ${pagesTried} pages)${others.length ? ' | also: ' + others.join(', ') : ''}`);

    if (!DRY) {
      const noteParts = [];
      if (offDomain) noteParts.push('email domain differs from website (verify it is the same clinic before sending)');
      if (others.length) noteParts.push('other emails found: ' + others.join(', '));
      const { error: upErr } = await supabase.from(TABLE)
        .update({ email: best, email_quality: quality, notes: noteParts.join(' | ') || null })
        .eq('id', row.id);
      if (upErr) { console.log(`  DB update failed: ${upErr.message}`); continue; }
      updated++;
    }
  }
  console.log(`\nDone. ${updated} of ${rows.length} clinics updated with an email.`);
  if (updated > 0) console.log('Next: node tempo/personalizer.js');
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
