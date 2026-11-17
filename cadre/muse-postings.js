#!/usr/bin/env node
/**
 * cadre/muse-postings.js, new companies found by Muse, checked before they can be emailed.
 *
 * WHY THIS EXISTS. Every new company used to come from a job-board sweep on Aidan's laptop, and
 * when that did not run the send pool went to zero (2026-11-06 to 11-16). Muse can browse the
 * boards that refuse our scripts, so the standing task M-002 in muse/inbox.md asks it for fresh
 * postings and it emails "[Muse postings] YYYY-MM-DD" with a JSON array.
 *
 * THE RULE THAT MATTERS. The email quotes the posting, so a quote Muse got slightly wrong is a
 * made-up fact sent to a stranger. Each posting URL is fetched here and the quote must appear on
 * the page. A row whose page cannot be fetched or does not contain the quote is still saved, but
 * with "parked by hand" in its notes, which posting-copy.js blockReason() refuses to send.
 * Clearing that note is a human (or in-session) decision after looking at the posting.
 *
 *   node cadre/muse-postings.js [--dry]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { google } = require('googleapis');

const DRY = process.argv.includes('--dry');
const today = () => new Date().toISOString().slice(0, 10);
const flat = s => String(s || '').toLowerCase().replace(/&[a-z#0-9]+;/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const INDUSTRIES = ['health', 'trades', 'transport', 'childcare', 'security', 'food', 'lab', 'education', 'manufacturing',
  'property', 'utilities', 'agriculture', 'recreation', 'hospitality', 'environmental', 'facilities', 'warehousing', 'other'];

/** Does the posting page really contain the quote? Returns 'yes', 'no' or 'unreachable (why)'. */
async function quoteOnPage(url, quote) {
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(25000), headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-CA,en;q=0.9' } });
    if (!r.ok) return `unreachable (${r.status})`;
    const page = flat((await r.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '));
    const q = flat(quote);
    if (page.includes(q)) return 'yes';
    // Tolerate a trimmed start or end: the middle 70% of the quote must still be there.
    const words = q.split(' ');
    const mid = words.slice(Math.floor(words.length * 0.15), Math.ceil(words.length * 0.85)).join(' ');
    return words.length >= 8 && page.includes(mid) ? 'yes' : 'no';
  } catch (e) { return `unreachable (${String(e.message).slice(0, 60)})`; }
}

(async () => {
  const o = new google.auth.OAuth2(process.env.GMAIL_OAUTH_CLIENT_ID, process.env.GMAIL_OAUTH_CLIENT_SECRET);
  o.setCredentials({ refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN });
  const g = google.gmail({ version: 'v1', auth: o });
  const body = p => { if (!p) return ''; if (p.body && p.body.data && /text\/plain/.test(p.mimeType)) return Buffer.from(p.body.data, 'base64').toString(); return (p.parts || []).map(body).join(''); };
  const labels = (await g.users.labels.list({ userId: 'me' })).data.labels || [];
  let done = labels.find(l => l.name === 'muse-ingested');
  if (!done && !DRY) done = (await g.users.labels.create({ userId: 'me', requestBody: { name: 'muse-ingested' } })).data;
  const r = await g.users.messages.list({ userId: 'me', q: 'subject:"[Muse postings]" -label:muse-ingested newer_than:14d', maxResults: 20 });
  const batch = [];
  let verified = 0, parked = 0, rejected = 0;
  for (const m of r.data.messages || []) {
    const d = (await g.users.messages.get({ userId: 'me', id: m.id, format: 'full' })).data;
    const text = body(d.payload) || d.snippet || '';
    let rows;
    try { rows = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)); } catch (e) { console.log(`message ${m.id}: no parseable JSON array, left unlabelled for a look`); continue; }
    for (const row of rows) {
      const quote = String((row && row.quote) || '').replace(/\s+/g, ' ').trim();
      if (!row || !row.company || !/^https?:\/\//.test(String(row.posting_url)) || quote.length < 30) { rejected++; continue; }
      const seen = await quoteOnPage(row.posting_url, quote);
      const name = String(row.contact_name || '').trim();
      const named = name && !/too large|null|unknown/i.test(name) && name.split(/\s+/).length >= 2;
      const check = seen === 'yes' ? 'quote confirmed on the posting page'
        : `parked by hand: quote not confirmed (${seen === 'no' ? 'page does not contain it' : seen}), look at the posting before sending`;
      seen === 'yes' ? verified++ : parked++;
      console.log(`${seen === 'yes' ? 'ok    ' : 'parked'} ${row.company}: ${seen}`);
      batch.push({
        business_name: String(row.company).trim(), website: row.website || null, city: row.city || null,
        industry: INDUSTRIES.includes(row.industry) ? row.industry : 'other', source: 'muse-postings',
        signal_type: 'hiring_compliance', signal_quote: quote, signal_url: row.posting_url,
        signal_date: /^\d{4}-\d{2}-\d{2}/.test(String(row.posted)) ? String(row.posted).slice(0, 10) : today(),
        staff_estimate: parseInt(row.staff, 10) || null,
        contact_name: named ? name : null, contact_role: named ? (row.contact_role || null) : null,
        // "muse 20.." is what format-guess.js looks for; "muse-queued" keeps the bridge from re-queueing a named row.
        notes: `muse postings ${today()}: ${check}${named ? ` | muse-queued ${today()} | muse ${today()}: ${name} (${row.contact_role || '?'}) ${row.linkedin_url || ''}${row.format_evidence ? ', format evidence ' + row.format_evidence : ''}` : ''}`,
      });
    }
    if (!DRY) await g.users.messages.modify({ userId: 'me', id: m.id, requestBody: { addLabelIds: [done.id], removeLabelIds: ['UNREAD'] } });
  }
  console.log(`Muse postings: ${verified} confirmed, ${parked} parked, ${rejected} rejected as incomplete.`);
  if (!batch.length) return;
  const file = path.join(__dirname, 'batches', `${today()}-muse-postings.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(batch, null, 2));
  const out = spawnSync(process.execPath, [path.join(__dirname, 'ingest.js'), file, ...(DRY ? ['--dry'] : [])], { encoding: 'utf8' });
  console.log(out.stdout || ''); if (out.stderr) console.error(out.stderr);
})().catch(e => { console.error(e.message); process.exit(1); });
