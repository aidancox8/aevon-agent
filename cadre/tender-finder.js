#!/usr/bin/env node
/**
 * cadre/tender-finder.js — find organisations that are ALREADY BUYING what Cadre is.
 *
 * The job-ad finder finds companies doing the work by hand. This finds companies who have
 * written a budget, a specification and a deadline for exactly this software. That is a warmer
 * signal than any job ad, and it comes with something the job boards never give us: a published
 * procurement contact address, in the notice, because they are legally obliged to publish one.
 *
 * SOURCE. UK Find a Tender, OCDS release packages. Free, no key, Open Government Licence,
 * cursor-paginated:
 *   https://www.find-tender.service.gov.uk/Developer/Documentation
 *
 * WHAT A ROW LOOKS LIKE. buyer.name is the organisation, parties[].contactPoint.email is a real
 * published address, and tender.title + tender.description carry the signal quote. So a tender
 * lead arrives complete, where a job-ad lead needs a website lookup and an email hunt before it
 * is usable at all.
 *
 * THE CAVEAT, STATED PLAINLY. These skew public sector: councils, NHS trusts, police, transport
 * authorities. That is a different sales motion from a 60-person fabrication shop, and a
 * published procurement inbox is a formal channel, not a warm one. They are qualified by intent
 * rather than by size, so they are scored and tagged separately and are worth reading before
 * sending.
 *
 *   node cadre/tender-finder.js --dry
 *   node cadre/tender-finder.js --days 180 --pages 20
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const https = require('https');
const supabase = require('../lib/supabase');
const { excludedOrgReason } = require('../tempo/dnc');

const TABLE = 'cadre_leads';
const DRY = process.argv.includes('--dry');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? parseInt(process.argv[i + 1], 10) : fallback;
};
const DAYS = arg('days', 365);
const MAX_PAGES = arg('pages', 40);
const PAGE_SIZE = 100;

/**
 * What we are looking for in a notice.
 *
 * Deliberately narrower than the job-ad phrase list. A tender saying "training" is a training
 * PROVIDER contract, which is somebody selling the course, not somebody tracking who holds it.
 * These all name the SYSTEM or the RECORD.
 */
const WANTED = [
  'competency management system',
  'competence management system',
  'training management system',
  'training matrix',
  'competency matrix',
  'skills matrix',
  'certification tracking',
  'certificate tracking',
  'training records management',
  'competency assessment system',
  'workforce compliance',
  'training compliance system',
  'e-permit',
  'credential management',
];

/** Tenders that use the words but are buying something else entirely. */
const NOT_WANTED = [
  /\btraining (provider|courses?|delivery|programme deliver)/i,
  /\bapprenticeship (training|provider)/i,
  /\bdriving (lessons|instruction)/i,
  /\brecruitment (agency|services)\b/i,
  /\btemporary staff/i,
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Find a Tender rate-limits: an unpaced scan got HTTP 429 on page 9. */
const PAGE_GAP_MS = 1500;

const rawGet = (url) => new Promise((resolve, reject) => {
  https.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'aevon-cadre/1.0' } }, (res) => {
    let d = '';
    res.on('data', (c) => (d += c));
    res.on('end', () => {
      if (res.statusCode !== 200) return reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
      try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad JSON')); }
    });
  }).on('error', reject);
});

/** Back off and retry on 429 rather than abandoning the sweep at the first throttle. */
async function get(url, attempt = 0) {
  try {
    return await rawGet(url);
  } catch (e) {
    if (e.status === 429 && attempt < 4) {
      const wait = 5000 * (attempt + 1);
      console.log(`  .. throttled, waiting ${wait / 1000}s`);
      await sleep(wait);
      return get(url, attempt + 1);
    }
    throw e;
  }
}

/** The sentence that actually contains the phrase, so the quote is theirs and not a summary. */
function extractQuote(text, phrase) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  const i = clean.toLowerCase().indexOf(phrase.toLowerCase());
  if (i === -1) return '';
  const start = Math.max(0, clean.lastIndexOf('.', i) + 1);
  let end = clean.indexOf('.', i + phrase.length);
  if (end === -1) end = Math.min(clean.length, i + 240);
  return clean.slice(start, end + 1).trim().slice(0, 400);
}

/** An address we can actually write to, preferring a named contact over a generic inbox. */
function contactFrom(parties) {
  const withEmail = (parties || []).filter((p) => p.contactPoint && p.contactPoint.email);
  if (!withEmail.length) return null;
  const buyer = withEmail.find((p) => (p.roles || []).includes('buyer')) || withEmail[0];
  return {
    email: String(buyer.contactPoint.email).trim().toLowerCase(),
    name: buyer.contactPoint.name || null,
    org: buyer.name || null,
    town: (buyer.address && (buyer.address.locality || buyer.address.region)) || null,
  };
}

(async () => {
  const { data: existing } = await supabase.from(TABLE).select('business_name, email');
  const seenName = new Set((existing || []).map((r) => String(r.business_name || '').toLowerCase().trim()));
  const seenEmail = new Set((existing || []).map((r) => String(r.email || '').toLowerCase().trim()).filter(Boolean));

  const since = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 19);
  let url = `https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?limit=${PAGE_SIZE}&updatedFrom=${since}`;
  console.log(`${DRY ? 'DRY RUN. ' : ''}Scanning Find a Tender back ${DAYS} days, up to ${MAX_PAGES} pages.\n`);

  const found = [];
  let scanned = 0;
  for (let page = 0; page < MAX_PAGES && url; page += 1) {
    let pkg;
    try { pkg = await get(url); }
    catch (e) { console.log(`  ! page ${page + 1}: ${e.message}`); break; }

    for (const rel of pkg.releases || []) {
      scanned += 1;
      const t = rel.tender || {};
      const haystack = `${t.title || ''} ${t.description || ''}`;
      if (NOT_WANTED.some((re) => re.test(haystack))) continue;

      const phrase = WANTED.find((w) => haystack.toLowerCase().includes(w));
      if (!phrase) continue;

      const org = (rel.buyer && rel.buyer.name) || '';
      const key = org.toLowerCase().trim();
      if (!org || seenName.has(key)) continue;
      const dnc = excludedOrgReason(org, null);
      if (dnc) { console.log(`  ! excluded org: ${org}`); continue; }

      const contact = contactFrom(rel.parties);
      if (!contact || !contact.email || seenEmail.has(contact.email)) continue;

      const quote = extractQuote(haystack, phrase);
      if (quote.length < 30) continue;

      seenName.add(key);
      seenEmail.add(contact.email);
      found.push({
        business_name: org,
        email: contact.email,
        email_quality: 'role',
        contact_name: contact.name,
        city: contact.town,
        source: 'find-a-tender',
        signal_type: 'tender',
        signal_quote: quote,
        signal_url: (rel.links && rel.links.self) || `https://www.find-tender.service.gov.uk/Notice/${rel.id}`,
        signal_date: rel.date ? rel.date.slice(0, 10) : null,
        // Intent beats inference: they wrote a specification for this. Scored above a job ad,
        // but parked for review rather than queued, because public-sector procurement is a
        // different motion and deserves a human read before anything goes out.
        qualification_score: 9,
        qualification_notes: `Published a procurement notice mentioning "${phrase}".`,
        status: 'needs_review',
      });
      console.log(`  ok   ${org.slice(0, 40).padEnd(42)}${contact.email}`);
      console.log(`       "${quote.slice(0, 110)}"`);
    }

    url = (pkg.links && pkg.links.next) || null;
    if (url) await sleep(PAGE_GAP_MS);
  }

  console.log(`\nScanned ${scanned} notices. ${found.length} organisation(s) actively procuring this.`);
  if (!found.length || DRY) {
    if (DRY && found.length) console.log('Dry run, nothing written.');
    return;
  }
  const { error } = await supabase.from(TABLE).insert(found);
  if (error) throw new Error(error.message);
  console.log(`Written at status='needs_review'. Read them before releasing:`);
  console.log(`  node cadre/hr-contacts.js --release <n>   (same release path)`);
})().catch((e) => { console.error('tender-finder failed:', e.message); process.exit(1); });
