#!/usr/bin/env node
/**
 * cadre/ad-contacts.js, pull the contact out of the job ad itself.
 *
 * The finder keeps a quote and the ad URL and nothing about who posted it. But the ad often
 * says: "send your resume to hr@company.com", "contact Jane Smith, HR Manager", or carries an
 * apply address in the footer. A PUBLISHED address is a different thing from a guessed one:
 * the guessed hr@ batch bounced 3 of 4 on 2026-09-03; an address the company printed in its own
 * ad is one it reads.
 *
 * Runs from a residential IP only (SimplyHired 403s datacenter ranges), paced so it never
 * competes with the finder. Never run it while the finder is running.
 *
 *   node cadre/ad-contacts.js --dry --limit 30     fetch, extract, print. No writes.
 *   node cadre/ad-contacts.js --limit 100          write what it finds, at needs_review
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const axios = require('axios');
const supabase = require('../lib/supabase');

const DRY = process.argv.includes('--dry');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > -1 ? parseInt(process.argv[i + 1], 10) : 30; })();
const GAP_MS = 2500;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-CA,en;q=0.9',
};

/** Addresses that are the job board's, a mail scanner's, or a person's private mailbox. */
const NOT_A_LEAD = /@(simplyhired|indeed|glassdoor|linkedin|ziprecruiter|workopolis|jobbank|talent|gmail|yahoo|hotmail|outlook|icloud|example|sentry|wixpress|googlemail)\./i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/**
 * "contact Jane Smith, HR Manager" / "Hiring Manager: Jane Smith" / "please email Jane Smith at".
 * Deliberately narrow. A false name on a cold email is worse than "Hi there".
 */
const NAME_RE = [
  /(?:contact|reach out to|email|e-mail|send (?:your )?(?:resume|cv|application) to|attention|attn:?)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+){1,2})(?:,|\s(?:at|-|–|—|\(|HR|Human))/,
  /(?:hiring manager|hr manager|human resources manager|hr contact|recruiter)\s*[:\-–]\s*([A-Z][a-z]+(?:\s[A-Z][a-z]+){1,2})/i,
];

function strip(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;|&rsquo;/g, "'")
    .replace(/\s+/g, ' ');
}

function extract(text, apex) {
  const emails = [...new Set((text.match(EMAIL_RE) || []).map((e) => e.toLowerCase()))]
    .filter((e) => !NOT_A_LEAD.test(e));
  // prefer an address on the company's own domain, then an obvious hiring inbox anywhere
  const own = emails.filter((e) => apex && e.endsWith('@' + apex));
  const hiring = emails.filter((e) => /^(hr|careers?|jobs?|recruit|recruiting|hiring|resumes?|talent|people)@/i.test(e));
  const email = own[0] || hiring[0] || null;
  let name = null;
  for (const re of NAME_RE) { const m = text.match(re); if (m) { name = m[1].trim(); break; } }
  return { email, name, allEmails: emails.slice(0, 4) };
}

function apexOf(website) {
  try {
    const h = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.toLowerCase().replace(/^www\./, '');
    const p = h.split('.');
    return p.length > 2 && p[p.length - 2].length <= 3 ? p.slice(-3).join('.') : p.slice(-2).join('.');
  } catch (e) { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // Leads that most need a door: generic inbox, guessed, or no address at all. Personal ones are
  // fine already.
  const { data, error } = await supabase.from('cadre_leads')
    .select('id, business_name, website, email, email_quality, contact_name, signal_url, status')
    .not('signal_url', 'is', null)
    .not('status', 'in', '("dont_contact","unsubscribed","bounced")')
    .or('email.is.null,email_quality.in.(generic,guessed)')
    .order('qualification_score', { ascending: false, nullsFirst: false })
    .limit(LIMIT);
  if (error) throw new Error(error.message);
  console.log(`${DRY ? 'DRY RUN: ' : ''}${data.length} ad(s) to read, ${GAP_MS}ms apart.\n`);

  let fetched = 0, blocked = 0, gotEmail = 0, gotName = 0;
  const writes = [];
  for (const lead of data) {
    const tag = String(lead.business_name).slice(0, 30).padEnd(32);
    let html;
    try {
      const res = await axios.get(lead.signal_url, { headers: HEADERS, timeout: 25000, validateStatus: () => true });
      if (res.status === 403 || res.status === 429) { blocked++; console.log(`  !    ${tag}HTTP ${res.status}, stopping so the IP is not burned`); break; }
      if (res.status !== 200) { console.log(`  !    ${tag}HTTP ${res.status}`); await sleep(GAP_MS); continue; }
      html = res.data; fetched++;
    } catch (e) { console.log(`  !    ${tag}${e.message}`); await sleep(GAP_MS); continue; }

    const { email, name, allEmails } = extract(strip(html), apexOf(lead.website));
    if (email) gotEmail++;
    if (name) gotName++;
    const upgrade = email && (!lead.email || ['generic', 'guessed'].includes(lead.email_quality));
    console.log(`  ${email || name ? 'ok' : '--'}   ${tag}${(email || '').padEnd(34)}${name || ''}${!email && allEmails.length ? '   (only: ' + allEmails.join(', ') + ')' : ''}`);
    if (!DRY && (upgrade || (name && !lead.contact_name))) {
      const u = {};
      if (upgrade) { u.email = email; u.email_quality = 'role'; u.status = 'needs_review'; }
      if (name && !lead.contact_name) u.contact_name = name;
      u.notes = `ad-contacts: from ${lead.signal_url}`;
      writes.push({ id: lead.id, u });
    }
    await sleep(GAP_MS);
  }

  console.log(`\nFetched ${fetched}, blocked ${blocked}. Emails found ${gotEmail}, names found ${gotName}.`);
  if (DRY || !writes.length) return;
  let ok = 0;
  for (const w of writes) {
    const { error: e } = await supabase.from('cadre_leads').update(w.u).eq('id', w.id);
    if (e) console.log(`  write failed ${w.id}: ${e.message}`); else ok++;
  }
  console.log(`Wrote ${ok}. Upgraded addresses sit at needs_review; release with cadre/hr-contacts.js --release <n>.`);
})().catch((e) => { console.error('ad-contacts failed:', e.message); process.exit(1); });
