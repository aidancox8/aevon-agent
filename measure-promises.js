#!/usr/bin/env node
/**
 * measure-promises.js
 *
 * Second pass for per-lead checkable facts, plain HTTP (no browser). For each queued lead's
 * site it fetches the homepage and the contact / intake / forms pages it links to, and records:
 *
 *   promises   the response-time promise they published ("we reply within 24 hours", "1 to 2
 *              business days"), with the sentence it came from
 *   pdfs       intake-type PDFs (new client, application, questionnaire, intake, registration)
 *              with their page count, and whether the page says to print, fax, scan or email it
 *   dead       intake-type links that return 404 or 5xx
 *   booking    third-party booking widgets on the site (calendly, acuity, jane, setmore...)
 *   portal     third-party application portals the Apply button leaves the site for
 *   hours      the office hours line if published
 *
 * Output: cadre/state/promises-scan.jsonl, one line per lead, resumable.
 * Usage: node measure-promises.js [--limit N] [--concurrency 8]
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const { createClient } = require('@supabase/supabase-js');
const { isActiveSegment, isSendableAddress } = require('./lib/segments');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg('--limit', '100000'), 10);
const CONC = parseInt(arg('--concurrency', '8'), 10);
const OUT = path.join(__dirname, 'cadre/state/promises-scan.jsonl');
const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36', accept: 'text/html,application/pdf,*/*' };

const PAGE_RE = /\b(contact|apply|application|intake|forms?|new[- ](client|patient|customer)|get[- ]started|onboard|questionnaire|resources|downloads?|documents?|quote|consult|book|schedule|hours)\b/i;
const PDF_INTAKE_RE = /(intake|new[- _]?(client|patient|customer)|application|questionnaire|registration|onboard|checklist|consent|agreement|worksheet|information[- _]?(form|sheet)|form)/i;
const PROMISE_RE = /((respond|reply|get back|return|answer|contact|call|follow up|be in touch|hear from us)[^.!?\n]{0,80}?\b(within|in|inside)\s+(one|two|three|1|2|3|24|48|72)\s*(-|to)?\s*(one|two|three|1|2|3|24|48|72)?\s*(hours?|hrs?|business days?|working days?|days?))|(\b(within|in)\s+(one|two|three|1|2|3|24|48|72)\s*(-|to)?\s*(one|two|three|1|2|3|24|48|72)?\s*(hours?|hrs?|business days?|working days?|days?)[^.!?\n]{0,60}?\b(respond|reply|get back|return your|answer|contact you|call you|follow up|be in touch|hear from))/i;
const HOURS_RE = /\b(mon(day)?|tues?(day)?|wed(nesday)?|thurs?(day)?|fri(day)?)\b[^\n<]{0,40}?\b(\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?\s*(-|–|to)\s*\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.))/i;
const PRINT_RE = /\b(print(ed)?|fax|scan(ned)?|mail (it|the form|to)|bring (it|the form|this)|drop (it )?off|email (it|the (completed )?form) (back|to))\b[^.\n]{0,80}/i;
const BOOKING_RE = /calendly\.com|acuityscheduling|janeapp\.com|setmore|squareup\.com\/appointments|hubspot\.com\/meetings|meetings\.hubspot|zcal\.co|cal\.com\/|youcanbook\.me|appointlet|simplybook|vcita|schedulicity|bookedin|tidycal|oncehub|savvycal|booksy|mindbody|clinicsense|noterro|owlpractice|practicebetter|zocdoc|cliniko|nookal|pabau|timely/i;
const PORTAL_RE = /newton\.ca|velocity-|mtg-app\.com|dominionlending\.ca\/apply|secure\.dominionlending|finmo|lendesk|filogix|mortgageweb\.ca|getmy\.mortgage|apply\.[a-z0-9-]+\.(ca|com)|application\.[a-z0-9-]+\.(ca|com)|clio\.com|clientportal|lawpay|intakeq|cognitoforms|jotform|typeform|formstack|wufoo|123formbuilder|hubspot\.com\/forms|tally\.so|paperform|zoho\.com\/forms/i;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

async function get(url, asBuffer = false) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: UA, redirect: 'follow' });
    const type = r.headers.get('content-type') || '';
    if (asBuffer) { const len = Number(r.headers.get('content-length') || 0); if (len > 15e6) return { status: r.status, type, tooBig: true }; return { status: r.status, type, buf: Buffer.from(await r.arrayBuffer()), url: r.url }; }
    return { status: r.status, type, text: await r.text(), url: r.url };
  } catch (e) { return { err: String(e.message).slice(0, 60) }; } finally { clearTimeout(t); }
}

const strip = html => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>|<\/div>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n');
const links = (html, base) => { const out = []; const re = /<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi; let m; while ((m = re.exec(html))) { let abs; try { abs = new URL(m[1], base).href; } catch { continue; } out.push({ href: abs, text: m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) }); } return out; };

function scanText(text, page) {
  const facts = {};
  const p = text.match(PROMISE_RE); if (p) facts.promise = { text: p[0].replace(/\s+/g, ' ').trim().slice(0, 160), page };
  const h = text.match(HOURS_RE); if (h) facts.hours = { text: h[0].replace(/\s+/g, ' ').trim().slice(0, 80), page };
  return facts;
}

async function scanLead(lead) {
  const row = { id: lead.id, name: lead.business_name, industry: lead.industry, city: lead.city, website: lead.website, promise: null, hours: null, pdfs: [], dead: [], booking: [], portal: [], printInstruction: null, err: null, at: new Date().toISOString() };
  let site = lead.website; if (!/^https?:/i.test(site)) site = 'https://' + site;
  const home = await get(site);
  if (home.err || !home.text) { row.err = home.err || `status ${home.status}`; return row; }
  row.final = home.url;
  let host; try { host = new URL(home.url).hostname.replace(/^www\./, ''); } catch { host = ''; }
  const pages = [{ url: home.url, html: home.text }];
  const all = links(home.text, home.url);
  const same = all.filter(a => { try { return new URL(a.href).hostname.replace(/^www\./, '') === host; } catch { return false; } });
  const targets = [...new Map(same.filter(a => PAGE_RE.test(a.text + ' ' + new URL(a.href).pathname)).map(a => [a.href.replace(/\/$/, ''), a])).values()].slice(0, 6);
  for (const t of targets) {
    if (/\.pdf(\?|$)/i.test(t.href)) continue;
    const r = await get(t.href);
    if (r.err) continue;
    if (r.status >= 400 && /apply|application|intake|form|quote|get.?started|onboard|questionnaire|new.?client/i.test(t.text + ' ' + t.href)) row.dead.push({ text: t.text, url: t.href, status: r.status });
    if (r.text && /text\/html/.test(r.type)) pages.push({ url: r.url, html: r.text, linkText: t.text });
  }
  const seenPdf = new Set();
  for (const pg of pages) {
    const text = strip(pg.html);
    const f = scanText(text, pg.url);
    if (f.promise && !row.promise) row.promise = f.promise;
    if (f.hours && !row.hours) row.hours = f.hours;
    for (const m of pg.html.match(BOOKING_RE) ? [pg.html.match(BOOKING_RE)[0]] : []) if (!row.booking.includes(m)) row.booking.push(m);
    for (const a of links(pg.html, pg.url)) {
      if (PORTAL_RE.test(a.href) && !row.portal.some(x => x.url === a.href)) row.portal.push({ text: a.text, url: a.href.slice(0, 140) });
      if (/\.pdf(\?|$)/i.test(a.href) && PDF_INTAKE_RE.test(a.text + ' ' + decodeURIComponent(a.href.split('/').pop() || '')) && !seenPdf.has(a.href) && row.pdfs.length < 5) {
        seenPdf.add(a.href);
        const pdf = await get(a.href, true);
        let pagesN = null, fields = null;
        if (pdf.buf && /pdf/i.test(pdf.type + a.href)) { try { const d = await pdfParse(pdf.buf, { max: 0 }); pagesN = d.numpages; fields = (d.text.match(/_{4,}|\[\s?\]|☐|□/g) || []).length; } catch {} }
        const around = text.slice(Math.max(0, text.indexOf(a.text) - 300), text.indexOf(a.text) + 300);
        const pr = around.match(PRINT_RE);
        row.pdfs.push({ text: a.text, url: a.href.slice(0, 160), pages: pagesN, blanks: fields, status: pdf.status, instruction: pr ? pr[0].trim().slice(0, 100) : null, on: pg.url });
        if (pr && !row.printInstruction) row.printInstruction = { text: pr[0].trim().slice(0, 120), page: pg.url };
      }
    }
  }
  return row;
}

(async () => {
  // A row that died from the laptop sleeping (network gone) is not a result; it is scanned again.
  const LOST = /fetch failed|operation was aborted/i;
  const done = new Set(fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map(l => { try { const r = JSON.parse(l); return LOST.test(r.err || '') ? null : r.id; } catch { return null; } }) : []);
  let all = [], from = 0;
  while (true) {
    const { data, error } = await supabase.from('leads').select('id, business_name, industry, city, website, email_quality, status, personalization_basis').eq('status', 'queued').not('email', 'is', null).not('website', 'is', null).range(from, from + 999);
    if (error) throw new Error(error.message); all = all.concat(data); if (data.length < 1000) break; from += 1000;
  }
  const leads = all.filter(l => !done.has(l.id) && isActiveSegment(l.industry) && isSendableAddress(l.email_quality) && !/^campaign:/.test(l.personalization_basis || '')).slice(0, LIMIT);
  console.log(`${leads.length} site(s) (${done.size} done). Concurrency ${CONC}.`);
  let i = 0, n = 0; const t0 = Date.now();
  const worker = async () => { while (i < leads.length) { const lead = leads[i++]; const row = await scanLead(lead); fs.appendFileSync(OUT, JSON.stringify(row) + '\n'); n++;
    const tag = [row.promise ? 'PROMISE' : '', row.pdfs.length ? `PDF${row.pdfs.map(p => p.pages || '?').join('/')}` : '', row.dead.length ? 'DEAD' : '', row.booking.length ? 'book' : '', row.portal.length ? 'portal' : '', row.err ? 'ERR' : ''].filter(Boolean).join(' ');
    console.log(`${String(n).padStart(4)}/${leads.length} ${tag.padEnd(22)} ${lead.industry.slice(0, 22).padEnd(22)} ${lead.business_name.slice(0, 40)}`); } };
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log(`Done: ${n} in ${Math.round((Date.now() - t0) / 60000)} min.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
