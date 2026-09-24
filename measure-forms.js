#!/usr/bin/env node
/**
 * measure-forms.js
 *
 * Finds and counts the forms on each lead's website in a real (headless) browser, so a cold
 * email can carry a fact the reader can check: "the application on your site is 68 fields
 * across four pages". Static HTML counts overstate (wizards keep every page in the DOM and
 * hidden conditional sections count too), which is why this walks the DOM with layout.
 *
 * For each lead: load the homepage, collect same-site links that look like an intake (apply,
 * quote, intake, consultation, evaluation, questionnaire, onboarding, new client, request,
 * contact), open up to MAX_PAGES of them, and on every page record:
 *   fields visible now, fields in hidden wizard panels grouped by panel, required count,
 *   form plugin, embedded third-party form iframes (opened and counted too), headings.
 *
 * Output: one JSON line per lead in cadre/state/forms-scan.jsonl (resumable; leads already in
 * the file are skipped). Nothing is typed into any form and nothing is submitted.
 *
 * Usage: node measure-forms.js [--limit N] [--concurrency 3] [--ids id1,id2] [--only-industry "law firm"]
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
const { isActiveSegment, isSendableAddress } = require('./lib/segments');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg('--limit', '100000'), 10);
const CONC = parseInt(arg('--concurrency', '3'), 10);
const IDS = arg('--ids', '') ? arg('--ids', '').split(',') : null;
const ONLY = arg('--only-industry', null);
const OUT = path.join(__dirname, 'cadre/state/forms-scan.jsonl');
const MAX_PAGES = 4;
const NAV_TIMEOUT = 25000;

const INTAKE_RE = /\b(apply|application|pre-?approv|get ?started|start (now|here|your)|quote|intake|consult|evaluation|questionnaire|onboard|new (client|patient|customer)|request|enquir|inquir|estimate|book|schedule|contact|refer|assessment|eligib|qualify|get in touch)/i;
const STRONG_RE = /\b(apply|application|pre-?approv|quote|intake|questionnaire|onboard|new (client|patient|customer)|evaluation|assessment|eligib|qualify)/i;
const SKIP_RE = /\b(login|log in|sign in|signin|portal|careers?|jobs?|privacy|terms|blog|news|facebook|linkedin|instagram|twitter|youtube|mailto:|tel:|\.pdf$|\.jpg$|\.png$)/i;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

// Runs inside the page. Counts fields the way an applicant meets them.
const COUNT_JS = `(() => {
  const vis = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const skipType = /^(hidden|submit|button|reset|image|search)$/i;
  const inChrome = e => !!e.closest('header, nav, footer, [role=search], .search, #search, .menu, .newsletter, .subscribe, .mc4wp-form, .wp-block-search');
  const all = [...document.querySelectorAll('input, select, textarea')].filter(e => !skipType.test(e.type || '') && !inChrome(e) && !/g-recaptcha|captcha|honeypot|_wpcf7|nonce/i.test(e.name + ' ' + e.id + ' ' + e.className));
  const panelOf = el => { let p = el; while (p && p !== document.body) { if (getComputedStyle(p).display === 'none') return p; p = p.parentElement; } return null; };
  const panels = new Map();
  let visible = 0;
  for (const e of all) { const p = panelOf(e); if (!p) { visible++; continue; } if (!panels.has(p)) panels.set(p, { n: 0, heading: (p.querySelector('h1,h2,h3,h4,legend,.title,strong,b')?.textContent || '').trim().slice(0, 40) }); panels.get(p).n++; }
  const hiddenPanels = [...panels.values()].filter(x => x.n >= 3);
  const wizardPages = Math.max(document.querySelectorAll('.gform_page').length, document.querySelectorAll('.wpforms-page').length, document.querySelectorAll('.ff-step-body, .fluentform-step').length, document.querySelectorAll('[data-step], .step, .form-step, .wizard-step').length);
  const required = all.filter(e => e.required || e.getAttribute('aria-required') === 'true').length;
  const radios = all.filter(e => e.type === 'radio').length, checks = all.filter(e => e.type === 'checkbox').length;
  const html = document.documentElement.innerHTML;
  const plugin = /gform_wrapper/.test(html) ? 'gravity' : /wpforms-form/.test(html) ? 'wpforms' : /wpcf7-form/.test(html) ? 'cf7' : /fluentform/.test(html) ? 'fluent' : /forminator/.test(html) ? 'forminator' : /hs-form|hsforms/.test(html) ? 'hubspot' : /elementor-form/.test(html) ? 'elementor' : /ninja-forms|nf-form/.test(html) ? 'ninja' : /formidable|frm_form/.test(html) ? 'formidable' : /__VIEWSTATE/.test(html) ? 'aspnet' : all.length ? 'other' : 'none';
  const iframes = [...document.querySelectorAll('iframe')].map(f => f.src).filter(s => /jotform|typeform|cognito|hubspot|formstack|123form|wufoo|zoho|paperform|tally\\.so|gravity|formsite|form\\.|forms?\\./i.test(s)).slice(0, 3);
  const headings = [...document.querySelectorAll('form h1, form h2, form h3, form h4, form legend, .gform_page_header, .wpforms-page-indicator-page-title')].map(h => h.textContent.trim()).filter(Boolean).slice(0, 12);
  const submitText = [...document.querySelectorAll('form button, form input[type=submit]')].filter(vis).map(b => (b.value || b.textContent || '').trim()).filter(Boolean).slice(0, 4);
  return { dom: all.length, visible, hiddenPanels, wizardPages, required, radios, checks, plugin, iframes, headings, submitText, title: document.title.slice(0, 80) };
})()`;

function scoreLink(text, href) {
  const s = text + ' ' + href;
  if (SKIP_RE.test(s)) return 0;
  if (STRONG_RE.test(s)) return 3;
  if (/consult|evaluation|get ?started|request|book|schedule|refer/i.test(s)) return 2;
  if (INTAKE_RE.test(s)) return 1;
  return 0;
}

async function withPage(browser, fn) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 900 });
    await page.setRequestInterception(true);
    page.on('request', r => (/image|media|font/.test(r.resourceType()) ? r.abort() : r.continue()));
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);
    return await fn(page);
  } finally { await page.close().catch(() => {}); }
}

async function measureUrl(browser, url) {
  return withPage(browser, async page => {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 2500));
    const m = await page.evaluate(COUNT_JS);
    const out = { url, final: page.url(), status: res ? res.status() : null, ...m };
    // Embedded third-party forms: open the iframe source and count there.
    out.embedded = [];
    for (const src of m.iframes) {
      try {
        const e = await withPage(browser, async p2 => { await p2.goto(src, { waitUntil: 'domcontentloaded' }); await new Promise(r => setTimeout(r, 3000)); return p2.evaluate(COUNT_JS); });
        out.embedded.push({ src: src.slice(0, 120), dom: e.dom, visible: e.visible, wizardPages: e.wizardPages, hiddenPanels: e.hiddenPanels, required: e.required, plugin: e.plugin });
      } catch (err) { out.embedded.push({ src: src.slice(0, 120), err: String(err.message).slice(0, 60) }); }
    }
    return out;
  });
}

async function scanLead(browser, lead) {
  const row = { id: lead.id, name: lead.business_name, industry: lead.industry, city: lead.city, website: lead.website, pages: [], err: null, at: new Date().toISOString() };
  let site = lead.website; if (!/^https?:/i.test(site)) site = 'https://' + site;
  try {
    const links = await withPage(browser, async page => {
      const res = await page.goto(site, { waitUntil: 'domcontentloaded' });
      await new Promise(r => setTimeout(r, 2000));
      row.home = { final: page.url(), status: res ? res.status() : null };
      const home = await page.evaluate(COUNT_JS);
      row.pages.push({ url: page.url(), kind: 'home', ...home });
      const host = new URL(page.url()).hostname.replace(/^www\./, '');
      const found = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => ({ text: (a.textContent || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80), href: a.href })));
      const seen = new Map();
      for (const a of found) {
        let h; try { h = new URL(a.href); } catch { continue; }
        if (h.hostname.replace(/^www\./, '') !== host) continue;
        const key = h.origin + h.pathname.replace(/\/$/, '') + h.search;
        const sc = scoreLink(a.text, h.pathname + h.search + '#' + h.hash);
        if (!sc) continue;
        if (!seen.has(key) || seen.get(key).sc < sc) seen.set(key, { url: key, text: a.text, sc });
      }
      return [...seen.values()].sort((a, b) => b.sc - a.sc).slice(0, MAX_PAGES);
    });
    for (const l of links) {
      try { const m = await measureUrl(browser, l.url); row.pages.push({ kind: 'intake', linkText: l.text, ...m }); }
      catch (e) { row.pages.push({ kind: 'intake', url: l.url, linkText: l.text, err: String(e.message).slice(0, 80) }); }
    }
  } catch (e) { row.err = String(e.message).slice(0, 120); }
  // Best page: most fields an applicant would meet (visible + hidden wizard panels + embedded).
  row.best = row.pages.filter(p => !p.err).map(p => {
    const panel = (p.hiddenPanels || []).reduce((n, x) => n + x.n, 0);
    const emb = (p.embedded || []).reduce((n, x) => Math.max(n, (x.visible || 0) + (x.hiddenPanels || []).reduce((s, y) => s + y.n, 0)), 0);
    return { url: p.final || p.url, kind: p.kind, fields: Math.max(p.visible + panel, emb), visible: p.visible, panels: (p.hiddenPanels || []).length, wizardPages: p.wizardPages, required: p.required, plugin: p.plugin, embedded: emb };
  }).sort((a, b) => b.fields - a.fields)[0] || null;
  return row;
}

(async () => {
  // A row that died from the laptop sleeping (browser connection closed, network gone) is not a
  // result; it gets scanned again on the next run.
  const LOST = /Connection closed|fetch failed|operation was aborted|Target closed|Session closed|detached/i;
  const done = new Set(fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map(l => { try { const r = JSON.parse(l); return LOST.test(r.err || '') ? null : r.id; } catch { return null; } }) : []);
  let all = [], from = 0;
  while (true) {
    let q = supabase.from('leads').select('id, business_name, industry, city, website, email_quality, status, personalization_basis').not('email', 'is', null).not('website', 'is', null).range(from, from + 999);
    q = IDS ? q.in('id', IDS) : q.eq('status', 'queued');
    const { data, error } = await q; if (error) throw new Error(error.message);
    all = all.concat(data); if (data.length < 1000) break; from += 1000;
  }
  let leads = all.filter(l => !done.has(l.id) && (IDS || (isActiveSegment(l.industry) && isSendableAddress(l.email_quality) && !/^campaign:/.test(l.personalization_basis || ''))));
  if (ONLY) leads = leads.filter(l => l.industry === ONLY);
  leads = leads.slice(0, LIMIT);
  console.log(`${leads.length} site(s) to scan (${done.size} already done). Concurrency ${CONC}.`);
  const launch = () => puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--js-flags=--max-old-space-size=256'] });
  let browser = await launch();
  const alive = async () => { if (browser.connected) return browser; console.log('browser gone, relaunching'); try { await browser.close(); } catch {} browser = await launch(); return browser; };
  let i = 0, n = 0; const t0 = Date.now();
  const worker = async () => {
    while (i < leads.length) {
      const lead = leads[i++];
      const row = await scanLead(await alive(), lead);
      if (/Connection closed|Target closed|Session closed/i.test(row.err || '')) { i--; await new Promise(r => setTimeout(r, 5000)); continue; }
      fs.appendFileSync(OUT, JSON.stringify(row) + '\n');
      n++;
      const b = row.best;
      console.log(`${String(n).padStart(4)}/${leads.length} ${b ? `${String(b.fields).padStart(3)}f ${b.wizardPages || 0}p ${b.plugin.padEnd(9)}` : row.err ? 'ERR       ' : '  0f      '} ${lead.industry.slice(0, 22).padEnd(22)} ${lead.business_name.slice(0, 40)}`);
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));
  await browser.close();
  console.log(`Done: ${n} in ${Math.round((Date.now() - t0) / 60000)} min. Output: ${OUT}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
