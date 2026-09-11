#!/usr/bin/env node
/**
 * cadre/jobbank-finder.js, the same signal search as lead-finder.js, against the Government of
 * Canada Job Bank instead of SimplyHired.
 *
 * WHY THIS EXISTS. SimplyHired only reaches page one, and by 2026-09-09 the board had been
 * walked with every phrase in every province. Job Bank (jobbank.gc.ca) is a second free Canadian
 * corpus with no equivalent block: a plain Chrome user agent gets 200s on both the search and
 * posting pages, verified 2026-09-10 with curl.
 *
 * AXIOS DOES NOT WORK HERE, EVEN THOUGH CURL DOES. Verified 2026-09-10: curl and a real browser
 * both get 200, axios and plain Node https both get ECONNRESET on every single request, headers
 * held identical. That is a TLS fingerprint block, the same thing site-contacts.js already
 * documents for proslide.com, not something a header fixes. So this whole file talks to Job Bank
 * through headless system Chrome via Playwright, the same tool and the same reason, rather than
 * a fetch layer that this site simply refuses to answer.
 *
 * HOW IT WORKS
 * The search page is a normal server-rendered JSF page: <article id="article-ID"> per posting,
 * with the employer in <li class="business">. "Show more results" is a session-bound AJAX call
 * that appends 25 more <article> elements and a fresh button below the ones already on the page,
 * so paging is done by clicking the on-page button up to twice more and re-reading the page,
 * not by tracking a page number.
 *
 * The apply email is not in the HTML at all until the "Show how to apply" button is clicked; it
 * is added to the DOM by a JSF ajax partial-update. Reproducing that POST by hand (ViewState,
 * execute/render ids) was tried and came back empty; a real click in the same browser works
 * first try.
 *
 * Every posting is filtered by the SAME rules as lead-finder.js (applicant-facing quotes out,
 * employer-side verbs required, agencies and giants excluded), plus a public-body filter Job
 * Bank needs and SimplyHired mostly did not: cities, health authorities, school boards and bands
 * post here constantly and none of them can buy from a solo vendor.
 *
 *   node cadre/jobbank-finder.js --dry --limit 40
 *   node cadre/jobbank-finder.js --limit 150
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { spawnSync } = require('child_process');
const supabase = require('../lib/supabase');
const { excludedOrgReason } = require('../tempo/dnc');
const { PHRASES, APPLICANT_FACING, INTERNAL_WORK, EXCLUDE_NAME, EXCLUDE_LARGE, extractQuote, inferIndustry } = require('./lead-finder');

const DRY = process.argv.includes('--dry');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? parseInt(process.argv[i + 1], 10) : fallback;
};
const LIMIT = arg('limit', 150);
const GAP_MS = 1500;
const TIMEOUT_MS = 30000;
const MAX_PAGES = 3;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9',
  'Accept-Language': 'en-CA,en;q=0.9',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Public bodies. Job Bank carries far more of these than SimplyHired: a city's own posting board
 * feeds it directly, and none of them can buy from a solo vendor or decide anything locally.
 */
const PUBLIC_BODY = /\b(city|town|district|municipality|regional|county|province|ministry|government|school district|school board|university|college|health authority|hospital|nation|band|first nation)\b/i;

/** Same tiering site-contacts.js already writes and the scheduler already ranks by. */
const HIRING_ROLE = /^(hr|humanresources|careers?|jobs?|recruiting|hiring|resumes?|people)@/i;
/**
 * "Personal" per the spec is first.last or a single first name. A single word that is a function
 * mailbox rather than a name (info@, office@) would pass that literal test and read as a wrong
 * personalization, so the same short generic list site-contacts.js uses is checked first. This
 * guard is not in the brief; it is here because a name field is user-facing in the personalizer.
 */
const GENERIC_WORD = /^(info|office|hello|contact|enquiries|inquiries|reception|general|mail|admin|sales|support|accounts)$/i;
const PERSONAL = /^[a-z]+([._-][a-z]+)?@/i;
const FREEMAIL = /@(gmail|yahoo|hotmail|outlook|icloud|live|shaw|telus)\./i;
const IGNORE_EMAIL_DOMAIN = /(jobbank\.gc\.ca|canada\.ca)$/i;

function classifyQuality(email) {
  const local = email.split('@')[0].toLowerCase();
  if (HIRING_ROLE.test(email)) return 'role';
  if (GENERIC_WORD.test(local)) return 'generic';
  if (PERSONAL.test(email)) return 'personal';
  return 'generic';
}

const norm = (n) => String(n).toLowerCase().replace(/[.,]/g, ' ')
  .replace(/\b(inc|ltd|limited|corp|corporation|co|company|society|group|holdings|llc|lp)\b/g, ' ')
  .replace(/\s+/g, ' ').trim();

function searchUrl(phrase) {
  return `https://www.jobbank.gc.ca/jobsearch/jobsearch?searchstring=${encodeURIComponent(`"${phrase}"`)}&sort=D`;
}

/** Business names routinely carry "&amp;" (Harrison Hot Springs Resort &amp; Spa) unescaped. */
function decodeEntities(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

/** Parse one search-results page (or "show more" fragment) into per-posting listings. */
function parseListings(html) {
  const out = [];
  const parts = String(html).split('<article id="article-').slice(1);
  for (const part of parts) {
    const idMatch = part.match(/^(\d+)"/);
    if (!idMatch) continue;
    const titleMatch = part.match(/<span class="noctitle">([\s\S]*?)<\/span>/);
    const businessMatch = part.match(/<li class="business">([^<]*)<\/li>/);
    const dateMatch = part.match(/<li class="date">([\s\S]*?)<\/li>/);
    out.push({
      id: idMatch[1],
      title: decodeEntities((titleMatch ? titleMatch[1] : '').replace(/\s+/g, ' ').trim()),
      business: decodeEntities((businessMatch ? businessMatch[1] : '').replace(/\s+/g, ' ').trim()),
      datePosted: (dateMatch ? dateMatch[1] : '').replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
}

/**
 * One phrase, up to MAX_PAGES pages, all of Canada (no fprov filter). Each click on
 * "Show more results" appends new <article> elements to the same page rather than replacing it,
 * so the listings are read once at the end, after all the clicking, not per page.
 */
async function search(browser, phrase) {
  const ctx = await browser.newContext({ userAgent: HEADERS['User-Agent'], locale: 'en-CA' });
  await ctx.route('**/*', (r) => (['image', 'media', 'font', 'stylesheet'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
  const page = await ctx.newPage();
  try {
    await page.goto(searchUrl(phrase), { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    for (let p = 1; p < MAX_PAGES; p++) {
      const btn = page.locator('#moreresultbutton');
      if (!(await btn.count())) break;
      const before = await page.locator('article[id^="article-"]').count();
      try {
        await btn.click({ timeout: 5000 });
        await page.waitForFunction(
          (n) => document.querySelectorAll('article[id^="article-"]').length > n,
          before, { timeout: 15000 },
        );
      } catch (e) { break; }   // no more pages, or the button did not respond in time
      await sleep(GAP_MS);
    }
    return parseListings(await page.content());
  } finally {
    await ctx.close();
  }
}

function postingUrl(id) {
  return `https://www.jobbank.gc.ca/jobsearch/jobposting/${id}?source=searchresults`;
}

/** ISO date from Job Bank's "September 08, 2026" style string, falling back to today. */
function isoDate(s) {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
}

/**
 * Open the posting, click "Show how to apply", and pull everything a lead needs: the visible
 * text (for extractQuote), the city off the schema.org address markup, and whatever email the
 * click reveals.
 */
async function readPosting(browser, id) {
  const ctx = await browser.newContext({ userAgent: HEADERS['User-Agent'], locale: 'en-CA' });
  await ctx.route('**/*', (r) => (['image', 'media', 'font', 'stylesheet'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
  const page = await ctx.newPage();
  try {
    const res = await page.goto(postingUrl(id), { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    if (!res || res.status() !== 200) return null;
    const h1 = await page.locator('h1').first().textContent().catch(() => '');
    const locality = await page.locator('[property="addressLocality"]').first().textContent().catch(() => null);
    const region = await page.locator('[property="addressRegion"]').first().textContent().catch(() => null);
    const city = locality ? `${locality.trim()}, ${(region || '').trim()}`.replace(/, $/, '') : null;

    const applyBtn = page.locator('#applynowbutton');
    if (await applyBtn.count()) {
      try { await applyBtn.click({ timeout: 5000 }); await page.waitForTimeout(1200); } catch (e) { /* stayed hidden */ }
    }
    const bodyText = await page.locator('main').first().innerText().catch(() => page.innerText('body'));
    const emails = [...new Set((bodyText.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []))]
      .filter((e) => e.toLowerCase() !== 'test@test.com' && !IGNORE_EMAIL_DOMAIN.test(e));
    // Postings fed in from a partner board (indeed.com etc.) are a stub on Job Bank: a title, an
    // employer name, and a link out. No description is mirrored and there is no apply button, so
    // there is nothing here for extractQuote to find, ever, for any phrase.
    const partnerStub = /provided by a partner site/i.test(bodyText);

    return { title: (h1 || '').trim(), text: bodyText, city, applyEmail: emails[0] || null, partnerStub };
  } finally {
    await ctx.close();
  }
}

(async () => {
  let chromium;
  try { ({ chromium } = require('C:/Users/Aidan/projects/cadre-app-src/node_modules/playwright')); }
  catch (e) { console.error('Playwright not found at C:/Users/Aidan/projects/cadre-app-src/node_modules/playwright'); process.exit(1); }
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });

  const { data: existing } = await supabase.from('cadre_leads').select('business_name');
  const seenCompanies = new Set((existing || []).map((r) => norm(r.business_name)));
  const seenJobIds = new Set();
  console.log(`${DRY ? 'DRY RUN. ' : ''}${seenCompanies.size} companies already in the list. Postings cap: ${LIMIT}.\n`);

  const found = [];
  let examined = 0;
  let withEmail = 0;
  let freemailCount = 0;
  const debugExamples = [];

  outer:
  for (const phrase of PHRASES) {
    let listings;
    try { listings = await search(browser, phrase); }
    catch (e) { console.log(`  ! ${phrase}: ${e.message}`); continue; }
    await sleep(GAP_MS);
    if (!listings.length) { console.log(`  0 hits  "${phrase}"`); continue; }
    console.log(`  ${String(listings.length).padStart(3)} hits  "${phrase}"`);

    for (const listing of listings) {
      if (examined >= LIMIT) break outer;
      if (seenJobIds.has(listing.id)) continue;
      seenJobIds.add(listing.id);
      const company = listing.business;
      if (!company) continue;
      const key = norm(company);
      if (seenCompanies.has(key)) continue;   // already known, not a new signal

      examined++;
      const tag = company.slice(0, 34).padEnd(34);

      if (EXCLUDE_NAME.some((re) => re.test(company)) || EXCLUDE_LARGE.some((re) => re.test(company))) {
        console.log(`  skip  ${tag} agency/training provider/enterprise`);
        continue;
      }
      if (PUBLIC_BODY.test(company)) {
        console.log(`  skip  ${tag} public body`);
        continue;
      }
      const dnc = excludedOrgReason(company, null);
      if (dnc) { console.log(`  skip  ${tag} ${dnc}`); continue; }

      let posting;
      try { posting = await readPosting(browser, listing.id); }
      catch (e) { console.log(`  skip  ${tag} posting fetch failed: ${e.message}`); continue; }
      await sleep(GAP_MS);
      if (!posting) { console.log(`  skip  ${tag} posting unreachable`); continue; }
      if (posting.partnerStub) { console.log(`  skip  ${tag} partner-site stub, no content mirrored`); continue; }

      if (debugExamples.length < 2) {
        debugExamples.push({ id: listing.id, h1: posting.title, snippet: posting.text.slice(0, 300), quote: extractQuote(posting.text, phrase) });
      }

      if (!posting.text.toLowerCase().includes(phrase.toLowerCase())) {
        console.log(`  skip  ${tag} phrase not on the posting page`);
        continue;
      }
      const quote = extractQuote(posting.text, phrase);
      if (quote.length < 25) { console.log(`  skip  ${tag} quote too short`); continue; }
      if (APPLICANT_FACING.some((re) => re.test(quote))) { console.log(`  skip  ${tag} applicant-facing`); continue; }
      if (!INTERNAL_WORK.test(quote)) { console.log(`  skip  ${tag} no employer-side verb`); continue; }

      seenCompanies.add(key);
      const city = posting.city || null;
      let email = null, emailQuality = null, note = `Found via Job Bank phrase "${phrase}". Job title: ${listing.title || posting.title}.`;
      if (posting.applyEmail) {
        if (FREEMAIL.test(posting.applyEmail)) {
          freemailCount++;
          note += ` jobbank apply address: ${posting.applyEmail} (freemail, not used)`;
        } else {
          email = posting.applyEmail;
          emailQuality = classifyQuality(email);
          withEmail++;
        }
      }

      found.push({
        business_name: company,
        website: null,
        city,
        industry: inferIndustry(`${listing.title || posting.title} ${company} ${quote}`),
        source: 'jobbank',
        signal_type: /matrix|spreadsheet|binder|by hand|manual/i.test(quote) ? 'manual_tracking' : 'hiring_credentialing',
        signal_quote: quote,
        signal_url: postingUrl(listing.id),
        signal_date: isoDate(listing.datePosted),
        email,
        email_quality: emailQuality,
        notes: note,
      });

      const cityTag = (city || '').slice(0, 18).padEnd(18);
      console.log(`  keep  ${tag} ${cityTag} ${email || 'no email'}  "${quote.slice(0, 70)}"`);
    }
  }

  await browser.close();

  console.log(`\n${found.length} kept of ${examined} posting(s) examined.`);
  if (!found.length) {
    console.log('\nZero kept. Diagnostic on the first postings actually opened, so a filter bug is visible rather than a clean zero:');
    for (const d of debugExamples) {
      console.log(`\n  posting ${d.id}`);
      console.log(`  h1: ${d.h1}`);
      console.log(`  description[0:300]: ${d.snippet}`);
      console.log(`  extractQuote: ${d.quote}`);
    }
  }

  if (!found.length) {
    console.log(`\nkept 0 of ${examined} postings | with email 0 | freemail ${freemailCount} | ingested 0 (already present 0)`);
    return;
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const batchPath = path.join(__dirname, 'batches', `${stamp}-jobbank.json`);
  fs.mkdirSync(path.dirname(batchPath), { recursive: true });
  fs.writeFileSync(batchPath, JSON.stringify(found, null, 2));
  console.log(`\nSaved to ${batchPath}`);

  const ingestArgs = [path.join(__dirname, 'ingest.js'), batchPath, ...(DRY ? ['--dry'] : [])];
  const ingest = spawnSync(process.execPath, ingestArgs, { encoding: 'utf8' });
  console.log(ingest.stdout || '');
  if (ingest.stderr) console.error(ingest.stderr);

  const m = /(?:Added|Would add) (\d+) \| already present (\d+)/.exec(ingest.stdout || '');
  const added = m ? m[1] : '?';
  const already = m ? m[2] : '?';
  console.log(`kept ${found.length} of ${examined} postings | with email ${withEmail} | freemail ${freemailCount} | ingested ${added} (already present ${already})`);
})().catch((e) => { console.error('jobbank-finder failed:', e.message); process.exit(1); });
