#!/usr/bin/env node
/**
 * cadre/posting-contacts.js, re-read a lead's own stored job posting and harvest any email
 * address the posting itself publishes.
 *
 * WHY THIS EXISTS. site-contacts.js reads the company's own website, but a chunk of queued
 * leads carry no website at all, only the signal_url the finder recorded when it found the
 * posting (mostly SimplyHired, some Indeed and LinkedIn). Some of those postings publish an
 * apply address directly on the page even though jobbank-finder.js's click-to-reveal trick does
 * not exist on these boards. Re-opening the stored URL and reading it once, the same way a
 * person would, is free and needs no new discovery.
 *
 * SimplyHired 403s or bot-checks a fraction of requests even from a real browser (documented in
 * reference_cadre_pipeline_traps.md). That is logged as blocked and skipped, not retried; a
 * retry loop against a rate limiter just spends more requests on the same wall.
 *
 * Every lead visited gets a note starting "posting-contacts:" whether or not an address was
 * found, so a second run never re-opens the same page. status, staff_estimate and
 * scheduled_send_at are never touched here; this script only ever sets email and email_quality.
 *
 *   node cadre/posting-contacts.js --dry --limit 15
 *   node cadre/posting-contacts.js --limit 250
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const supabase = require('../lib/supabase');

const DRY = process.argv.includes('--dry');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > -1 ? parseInt(process.argv[i + 1], 10) : 250; })();
const GAP_MS = 1500;
const TIMEOUT_MS = 30000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/gi;
const IGNORE_DOMAIN = /(simplyhired|indeed|jobbank|canada\.ca|example\.com)/i;
const IGNORE_LOCAL = /^(test|noreply|no-reply|privacy|support)$/i;
const IMAGE_LIKE = /\.(png|jpe?g)$/i;
const FREEMAIL = /@(gmail|yahoo|hotmail|outlook|icloud|live|shaw|telus|aol|protonmail)\./i;
const ROLE = /^(hr|humanresources|human\.resources|careers|jobs|recruiting|recruitment|hiring|resumes|resume|talent|people|apply|applications|employment)$/i;
const ROLE_PREFIX = /^hr/i;
const PERSONAL_DOTTED = /^[a-z]+\.[a-z]+$/i;
const PERSONAL_LETTERS = /^[a-z]{3,15}$/i;
// Signs the page never rendered the real posting: a Cloudflare/bot-check interstitial or an
// outright 403. Checked on both the HTTP status and the visible text, since some blocks return
// 200 with a challenge page instead of an error code.
const BLOCK_TEXT = /access denied|are you a human|verify you are a human|unusual traffic|captcha|attention required|just a moment|request blocked/i;

function domainOf(email) {
  const at = email.lastIndexOf('@');
  return at > -1 ? email.slice(at + 1).toLowerCase() : '';
}

/** Drop anything that is not a real, on-posting contact address. */
function survivors(emails) {
  return [...new Set(emails.map((e) => e.toLowerCase()))].filter((e) => {
    if (IMAGE_LIKE.test(e)) return false;
    if (IGNORE_DOMAIN.test(domainOf(e))) return false;
    const local = e.split('@')[0];
    if (IGNORE_LOCAL.test(local)) return false;
    return true;
  });
}

function classifyLocal(local) {
  if (ROLE.test(local) || ROLE_PREFIX.test(local)) return 'role';
  if (PERSONAL_DOTTED.test(local) || PERSONAL_LETTERS.test(local)) return 'personal';
  return 'generic';
}

/**
 * Split survivors into freemail and everything else, then pick role, then personal, then
 * generic. Freemail is never picked, even if it is the only thing on the page; it is recorded
 * in the note but the lead is left without an email.
 */
function pick(addrs) {
  const freemail = addrs.filter((e) => FREEMAIL.test(e));
  const candidates = addrs.filter((e) => !FREEMAIL.test(e));
  const byClass = { role: [], personal: [], generic: [] };
  for (const e of candidates) byClass[classifyLocal(e.split('@')[0])].push(e);
  for (const cls of ['role', 'personal', 'generic']) {
    if (byClass[cls].length) return { email: byClass[cls][0], quality: cls, freemail };
  }
  return { email: null, quality: null, freemail };
}

async function readPosting(browser, url) {
  const ctx = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-CA' });
  await ctx.route('**/*', (r) => (['image', 'media', 'font', 'stylesheet'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
  const page = await ctx.newPage();
  try {
    let res;
    try {
      res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    } catch (e) {
      return { blocked: true, reason: e.message };
    }
    const text = await page.innerText('body').catch(() => '');
    if ((res && res.status() === 403) || BLOCK_TEXT.test(text)) return { blocked: true, reason: res ? `status ${res.status()}` : 'bot check text' };
    const html = await page.content().catch(() => '');
    const mailtos = [...html.matchAll(/mailto:([^"'?\s>]+)/gi)].map((m) => { try { return decodeURIComponent(m[1]); } catch (e2) { return m[1]; } });
    const emails = [...text.matchAll(EMAIL_RE)].map((m) => m[0]).concat(mailtos);
    return { blocked: false, emails };
  } finally {
    await ctx.close();
  }
}

(async () => {
  let chromium;
  try { ({ chromium } = require('C:/Users/Aidan/projects/cadre-app-src/node_modules/playwright')); }
  catch (e) { console.error('Playwright not found at C:/Users/Aidan/projects/cadre-app-src/node_modules/playwright'); process.exit(1); }

  const { data, error } = await supabase.from('cadre_leads')
    .select('id, business_name, email, signal_url, notes, qualification_score')
    .eq('status', 'queued')
    .or('email.is.null,email.eq.')
    .not('signal_url', 'is', null)
    .or('notes.is.null,notes.not.ilike.%posting-contacts:%')
    .order('qualification_score', { ascending: false, nullsFirst: false })
    .limit(LIMIT);
  if (error) throw new Error(error.message);
  console.log(`${DRY ? 'DRY RUN: ' : ''}${data.length} posting(s) to read.\n`);

  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });

  const tally = { role: 0, personal: 0, generic: 0, freemailOnly: 0, none: 0, blocked: 0 };
  for (const lead of data) {
    const tag = String(lead.business_name).slice(0, 34).padEnd(34);
    let result;
    try { result = await readPosting(browser, lead.signal_url); }
    catch (e) { result = { blocked: true, reason: e.message }; }
    await sleep(GAP_MS);

    if (result.blocked) {
      tally.blocked++;
      console.log(`  !!   ${lead.business_name}  blocked`);
      if (!DRY) {
        const note = `${lead.notes ? lead.notes + ' ' : ''}| posting-contacts: page blocked`;
        const { error: e } = await supabase.from('cadre_leads').update({ notes: note }).eq('id', lead.id);
        if (e) console.log(`       write failed: ${e.message}`);
      }
      continue;
    }

    const found = survivors(result.emails);
    const { email, quality, freemail } = pick(found);

    if (email) {
      tally[quality]++;
      console.log(`  ok   ${tag} ${email}  (${quality})`);
      if (!DRY) {
        const note = `${lead.notes ? lead.notes + ' ' : ''}| posting-contacts: ${email} published on the posting (${quality})`;
        const { error: e } = await supabase.from('cadre_leads')
          .update({ email, email_quality: quality, notes: note })
          .eq('id', lead.id);
        if (e) console.log(`       write failed: ${e.message}`);
      }
      continue;
    }

    if (freemail.length) {
      tally.freemailOnly++;
      console.log(`  --   ${lead.business_name}  freemail only ${freemail[0]}`);
      if (!DRY) {
        const note = `${lead.notes ? lead.notes + ' ' : ''}| posting-contacts: only freemail on the posting: ${freemail[0]}`;
        const { error: e } = await supabase.from('cadre_leads').update({ notes: note }).eq('id', lead.id);
        if (e) console.log(`       write failed: ${e.message}`);
      }
      continue;
    }

    tally.none++;
    console.log(`  --   ${lead.business_name}  none`);
    if (!DRY) {
      const note = `${lead.notes ? lead.notes + ' ' : ''}| posting-contacts: no address on the posting`;
      const { error: e } = await supabase.from('cadre_leads').update({ notes: note }).eq('id', lead.id);
      if (e) console.log(`       write failed: ${e.message}`);
    }
  }

  await browser.close();
  console.log(`\nfound ${tally.role + tally.personal + tally.generic} (role ${tally.role}, personal ${tally.personal}, generic ${tally.generic}) | freemail only ${tally.freemailOnly} | none ${tally.none} | blocked ${tally.blocked}`);
})().catch((e) => { console.error('posting-contacts failed:', e.message); process.exit(1); });
