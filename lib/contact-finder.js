/**
 * contact-finder.js
 * Scrapes a business website for the best reachable contact: prefers a named
 * decision-maker's personal email over a generic info@ inbox. Checks the
 * homepage plus common contact/about/team pages.
 *
 * Returns: { email, emailQuality, contactName, contactRole, text }
 *   emailQuality: 'personal' | 'role' | 'generic' | null
 *
 * No email guessing/permutation — only addresses actually published on the
 * site are returned, to protect domain deliverability.
 */

const axios = require('axios');
const cheerio = require('cheerio');

const UA = 'Mozilla/5.0 (compatible; AevonBot/1.0)';
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}(?=[^a-zA-Z]|$)/g;

// Generic mailbox prefixes — reach a shared inbox, not a person.
const GENERIC = new Set([
  'info', 'office', 'contact', 'hello', 'admin', 'reception', 'inquiries',
  'enquiries', 'mail', 'general', 'team', 'support', 'help', 'service',
  'frontdesk', 'front.desk', 'hi', 'connect', 'careers', 'jobs', 'hr',
  'accounts', 'accounting', 'billing', 'orders', 'dispatch', 'bookings',
  'appointments', 'noreply', 'no-reply', 'webmaster', 'privacy', 'legal',
]);

// Role inboxes that, while not a named person, still reach a relevant human.
const ROLE = new Set(['sales', 'newbusiness', 'bd', 'partnerships', 'operations', 'ops']);

// Decision-maker title keywords, strongest first.
const TITLE_PATTERNS = [
  /\b(founder|co-?founder)\b/i,
  /\b(owner|proprietor)\b/i,
  /\b(president)\b/i,
  /\b(ceo|chief executive)\b/i,
  /\b(managing director|managing partner|principal)\b/i,
  /\b(director of operations|operations manager|gm|general manager)\b/i,
  /\b(partner)\b/i,
  /\b(office manager|practice manager|practice administrator)\b/i,
  /\b(director)\b/i,
  /\b(manager)\b/i,
];

function classifyEmail(email) {
  if (!email) return null;
  const prefix = email.split('@')[0].toLowerCase().replace(/[0-9]+$/, '');
  if (GENERIC.has(prefix)) return 'generic';
  if (ROLE.has(prefix)) return 'role';
  // firstname, firstname.lastname, f.lastname, firstnamelastname -> personal
  if (/^[a-z]+([._-][a-z]+)?$/.test(prefix) && prefix.length <= 24) return 'personal';
  return 'generic';
}

const QUALITY_RANK = { personal: 3, role: 2, generic: 1 };

function betterEmail(a, b) {
  if (!a) return b;
  if (!b) return a;
  return QUALITY_RANK[classifyEmail(a)] >= QUALITY_RANK[classifyEmail(b)] ? a : b;
}

// Try to find the name + title of a decision-maker in page text.
function findDecisionMaker(text) {
  if (!text) return { contactName: null, contactRole: null };
  // Look for "Name, Title" or "Title: Name" near a title keyword.
  for (const re of TITLE_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const idx = m.index;
    const window = text.slice(Math.max(0, idx - 60), idx + 60);
    // Name pattern: two or three Capitalized words.
    const nameMatch = window.match(/\b([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+)\b/);
    if (nameMatch) {
      return { contactName: nameMatch[1].trim(), contactRole: m[0] };
    }
  }
  return { contactName: null, contactRole: null };
}

async function fetchPage(url) {
  try {
    const res = await axios.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': UA },
      maxRedirects: 3,
      maxContentLength: 3 * 1024 * 1024, // 3MB cap — avoid heap blowup on huge pages
      responseType: 'text',
    });
    if (typeof res.data !== 'string') return null;
    const $ = cheerio.load(res.data);
    res.data = null; // release the raw HTML promptly
    return $;
  } catch {
    return null;
  }
}

// Strip junk that gets glued to the front of an address in body text:
//  - label words: "emailrod@x" -> "rod@x", "e-mailjane@x" -> "jane@x"
//  - leading phone digits: "8011carol@x" -> "carol@x"
function cleanEmail(addr) {
  // Strip zero-width / invisible / non-breaking / whitespace junk from page text.
  let e = addr.replace(/[\u200B-\u200D\uFEFF\u00A0\u2060\s]/g, '').toLowerCase().replace(/^mailto:/, '');
  let domain = e.split('@').slice(1).join('@');
  let local = e.split('@')[0];
  // Strip label words glued to the FRONT of the local part: "addressinfo@" -> "info@".
  const labelM = local.match(/^(e-?mail|contact|sendto|mailto|address|phone|fax|tel|call)([a-z].*)$/);
  if (labelM) local = labelM[2];
  // Strip leading digits only if letters follow (a number ran into the address).
  const digitM = local.match(/^\d{2,}([a-z].*)$/);
  if (digitM) local = digitM[1];
  // Strip a word glued AFTER the TLD: "immigrationmedclinic.comhours" -> ".com".
  // TLDs listed longest-first so .com is never truncated to .co.
  domain = domain.replace(/\.(com|net|org|info|biz|ca|io|co|us|uk)([a-z]{2,})$/, '.$1');
  return local + '@' + domain;
}

function collectEmails($) {
  const found = [];
  $('a[href^="mailto:"]').each((_, el) => {
    const addr = ($(el).attr('href') || '').replace('mailto:', '').split('?')[0].trim().toLowerCase();
    if (addr.includes('@')) found.push(addr);
  });
  const bodyText = $('body').text();
  const matches = bodyText.match(EMAIL_RE) || [];
  matches.forEach(m => found.push(cleanEmail(m)));
  // Drop obvious non-contact addresses (asset filenames, sentry, etc.)
  return found.filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && !/\.(png|jpg|jpeg|gif|svg|webp)$/.test(e) && !/sentry|wixpress|example\.com/.test(e));
}

// Build candidate sub-page URLs from the homepage.
function contactPageUrls($, baseUrl) {
  const urls = new Set();
  const wanted = /contact|about|team|our-team|our-people|staff|meet|people|leadership/i;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || wanted.test(href) === false) return;
    try {
      const u = new URL(href, baseUrl);
      // same host only
      if (u.host === new URL(baseUrl).host) urls.add(u.href.split('#')[0]);
    } catch { /* ignore */ }
  });
  return [...urls].slice(0, 4); // cap to keep it fast
}

/**
 * Main entry. Scrapes homepage + up to 4 contact-ish pages, returns the best
 * contact found and the homepage text (for qualification).
 */
async function findContact(websiteUrl) {
  const blank = { email: null, emailQuality: null, contactName: null, contactRole: null, text: '' };
  if (!websiteUrl) return blank;

  const $home = await fetchPage(websiteUrl);
  if (!$home) return blank;
  $home('script, style, noscript').remove();
  const text = $home('body').text().replace(/\s+/g, ' ').slice(0, 3000);

  let bestEmail = null;
  let dm = { contactName: null, contactRole: null };

  // homepage emails + decision-maker
  collectEmails($home).forEach(e => { bestEmail = betterEmail(bestEmail, e); });
  dm = findDecisionMaker($home('body').text());

  // Only dig into sub-pages if we haven't found a personal email yet.
  if (classifyEmail(bestEmail) !== 'personal') {
    const subUrls = contactPageUrls($home, websiteUrl);
    for (const url of subUrls) {
      const $p = await fetchPage(url);
      if (!$p) continue;
      $p('script, style, noscript').remove();
      collectEmails($p).forEach(e => { bestEmail = betterEmail(bestEmail, e); });
      if (!dm.contactName) dm = findDecisionMaker($p('body').text());
      if (classifyEmail(bestEmail) === 'personal' && dm.contactName) break;
    }
  }

  return {
    email: bestEmail,
    emailQuality: classifyEmail(bestEmail),
    contactName: dm.contactName,
    contactRole: dm.contactRole,
    text,
  };
}

module.exports = { findContact, classifyEmail };
