#!/usr/bin/env node
/**
 * cadre/signal-check.js — take companies we already know and find out whether they have
 * published the signal.
 *
 * WHY THIS EXISTS. There are 688 clinics in tempo_leads with verified addresses. Every one is
 * healthcare with credentialed staff, so every one has the problem. The temptation is to import
 * them straight into Cadre and instantly have 688 sendable leads.
 *
 * That would be a mistake, and an expensive one. Those rows arrive with no published signal,
 * and the signal is the only thing separating this campaign from the two that produced 3,808
 * sends and zero meetings between them. Worse, that list has already had cold email from this
 * domain about scheduling, 292 sends for 0 replies. Emailing them again from the same sender
 * with a different pitch is not a new experiment.
 *
 * So this does the opposite: it takes a company we already know and goes looking for whether
 * THEY have written the problem down. A hit turns a scraped row into a qualified one, at the
 * same bar as anything the finder produces. A miss leaves them where they are.
 *
 * The search is by company name rather than by region, so it reaches companies the phrase sweep
 * would never surface: a clinic in a town the region sweep does not cover still gets checked.
 *
 *   node cadre/signal-check.js --from tempo_leads --dry --limit 20
 *   node cadre/signal-check.js --from leads --limit 200
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const axios = require('axios');
const fs = require('fs');
const supabase = require('../lib/supabase');
const { excludedOrgReason } = require('../tempo/dnc');

const TABLE = 'cadre_leads';
const DRY = process.argv.includes('--dry');
const argOf = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const FROM = argOf('from', 'tempo_leads');
const LIMIT = parseInt(argOf('limit', '100'), 10);
if (!['leads', 'tempo_leads'].includes(FROM)) throw new Error('--from must be leads or tempo_leads');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9',
  'Accept-Language': 'en-CA,en;q=0.9',
};
const GAP_MS = 4000;
const DNS_ERRORS = /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|socket hang up|fetch failed/i;

/** Same phrases the finder uses, checked against everything a company has posted. */
const PHRASES = [
  'training matrix', 'certification tracking', 'certification expiry', 'maintain training records',
  'employee certifications', 'certification records', 'competency matrix', 'track certifications',
  'driver qualification files', 'certifications are up to date', 'licence renewals',
  'license renewals', 'recertification',
];

const APPLICANT_FACING = [
  /\b(is an asset|are an asset|would be an asset|is preferred|are preferred|is required|are required)\b/i,
  /\b(must (have|hold|possess)|should (have|hold|possess))\b/i,
  /\bvalid .{0,30}(licen[cs]e|ticket|certificat)/i,
  /\b(candidates?|applicants?|the ideal candidate|you will (have|bring))\b/i,
  /\b(ability to (provide|obtain)|willing to obtain)\b/i,
  /\b(recertification (support|assistance|can|will|may)|reimburse)\b/i,
];
const INTERNAL_WORK = /\b(maintain(s|ing)?|track(s|ing)?|monitor(s|ing)?|updat(e|es|ing)|coordinat(e|es|ing)|manag(e|es|ing)|administer|schedul(e|es|ing)|audit(s|ing)?|filing|record ?keeping|keep(s|ing)?|ensur(e|es|ing)|oversee|overseeing|own(s|ing)?|review(s|ing)?|verif(y|ies|ying)|log(s|ging)?)\b/i;

const norm = n => String(n).toLowerCase().replace(/[.,]/g, ' ')
  .replace(/\b(inc|ltd|limited|corp|corporation|co|company|society|group|holdings|llc|lp)\b/g, ' ')
  .replace(/\s+/g, ' ').trim();

let dnsFails = 0;
async function fetchJson(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await axios.get(url, { headers: HEADERS, timeout: 25000 });
      dnsFails = 0;
      const m = String(res.data).match(/id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      return m ? JSON.parse(m[1]).props.pageProps : null;
    } catch (e) {
      if (!DNS_ERRORS.test(e.code || e.message || '')) return null;
      dnsFails++;
      await new Promise(r => setTimeout(r, Math.min(30000, 2000 * 2 ** attempt + dnsFails * 1000)));
    }
  }
  return null;
}

function quoteFrom(text, phrase) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  const sentences = clean.match(/[^.!?]+[.!?]?/g) || [clean];
  const hit = sentences.find(x => x.toLowerCase().includes(phrase.toLowerCase()));
  return (hit || '').trim().replace(/^[^A-Za-z0-9]+/, '');
}

/** Does this company have a posting that states the problem as internal work? */
async function checkCompany(company, city) {
  const host = /\b[A-Z]{2}\b/.test(String(city)) && !/\b(BC|AB|SK|MB|ON|QC|NS|NB|NL|PE)\b/.test(String(city))
    ? 'https://www.simplyhired.com' : 'https://www.simplyhired.ca';
  const pp = await fetchJson(`${host}/search?q=${encodeURIComponent(`"${company}"`)}`);
  if (!pp || !pp.jobs || !pp.jobs.length) return null;

  const theirs = pp.jobs.filter(j => norm(j.company || '') === norm(company));
  for (const job of theirs) {
    const text = String(job.snippet || '');
    for (const phrase of PHRASES) {
      if (!text.toLowerCase().includes(phrase.toLowerCase())) continue;
      const quote = quoteFrom(text, phrase);
      if (quote.length < 25) continue;
      if (APPLICANT_FACING.some(re => re.test(quote))) continue;
      if (!INTERNAL_WORK.test(quote)) continue;
      return {
        quote, phrase, title: job.title,
        url: job.botUrl ? `${host}${job.botUrl}` : `${host}/search?q=${encodeURIComponent(`"${company}"`)}`,
      };
    }
  }
  return null;
}

(async () => {
  const { data: existing } = await supabase.from(TABLE).select('business_name');
  const already = new Set((existing || []).map(r => norm(r.business_name)));

  const { data: source, error } = await supabase.from(FROM)
    .select('business_name, city, email, email_quality, contact_name, contact_role, website, industry, phone')
    .not('email', 'is', null)
    .neq('status', 'dont_contact')
    .limit(LIMIT * 3);
  if (error) throw new Error(error.message);

  const candidates = (source || [])
    .filter(l => l.business_name && !already.has(norm(l.business_name)))
    .filter(l => !excludedOrgReason(l.business_name, l.email))
    .slice(0, LIMIT);

  console.log(`${DRY ? 'DRY RUN. ' : ''}Checking ${candidates.length} companies from ${FROM} for a published signal.\n`);

  const found = [];
  for (const [i, lead] of candidates.entries()) {
    process.stdout.write(`[${i + 1}/${candidates.length}] ${String(lead.business_name).slice(0, 38).padEnd(40)}`);
    const hit = await checkCompany(lead.business_name, lead.city);
    await new Promise(r => setTimeout(r, GAP_MS));
    if (!hit) { console.log('no signal'); continue; }

    console.log(`SIGNAL  "${hit.quote.slice(0, 60)}"`);
    found.push({
      business_name: lead.business_name.trim(),
      website: lead.website || null,
      city: lead.city || null,
      email: lead.email,
      email_quality: lead.email_quality || null,
      contact_name: lead.contact_name || null,
      contact_role: lead.contact_role || null,
      phone: lead.phone || null,
      industry: 'health',
      source: 'signal-check',
      signal_type: /matrix|spreadsheet|binder|by hand|manual/i.test(hit.quote) ? 'manual_tracking' : 'hiring_credentialing',
      signal_quote: hit.quote,
      signal_url: hit.url,
      signal_date: new Date().toISOString().slice(0, 10),
      qualification_score: 8,
      personalization_basis: `published signal: ${hit.phrase}`,
      notes: `Promoted from ${FROM} after finding a published signal. Job title: ${hit.title}. ` +
             `NOTE: this company has had cold email from this domain before, so acknowledge that rather than open as a stranger.`,
    });
  }

  console.log(`\n${found.length} of ${candidates.length} had a published signal.`);
  if (!found.length) return;

  const stamp = new Date().toISOString().slice(0, 10);
  const batchPath = `cadre/batches/${stamp}-signal-check-${FROM}.json`;
  try {
    fs.mkdirSync('cadre/batches', { recursive: true });
    fs.writeFileSync(batchPath, JSON.stringify(found, null, 1));
    console.log(`Saved to ${batchPath}`);
  } catch (e) { console.error(`could not save: ${e.message}`); }

  if (DRY) { console.log('Dry run, nothing written to the database.'); return; }
  let ok = 0;
  for (const f of found) {
    const { error: e } = await supabase.from(TABLE).insert(f);
    if (e) { console.error(`  insert failed ${f.business_name}: ${e.message}`); continue; }
    ok++;
  }
  console.log(`Inserted ${ok}. These arrive WITH an address already, so they skip the email hunter.`);
})().catch(e => { console.error('signal check failed:', e.message); process.exit(1); });
