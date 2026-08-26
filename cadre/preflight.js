#!/usr/bin/env node
/**
 * cadre/preflight.js — everything worth knowing before a batch goes out.
 *
 * Run this the evening before a send. It changes nothing; it only reports. The point is that
 * every problem it looks for has actually happened on one of the three campaigns, and each one
 * is cheap to find now and expensive to find afterwards.
 *
 *   node cadre/preflight.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const dns = require('dns').promises;
// Pin clean resolvers. An ISP that hijacks NXDOMAIN makes dead domains look alive, which would
// turn this check into a rubber stamp.
try { dns.setServers(['8.8.8.8', '1.1.1.1']); } catch (e) { /* keep system resolvers */ }
const supabase = require('../lib/supabase');
const { excludedOrgReason } = require('../tempo/dnc');
const { zoneFor, localLabel } = require('./timezone');
const { signature } = require('../lib/signature');

const TABLE = 'cadre_leads';

/** Does this domain have a mail server? No MX means a guaranteed hard bounce. */
const mxCache = new Map();
async function acceptsMail(email) {
  const domain = (String(email).split('@')[1] || '').toLowerCase().trim();
  if (!domain) return { ok: false, why: 'no domain' };
  if (mxCache.has(domain)) return mxCache.get(domain);
  let result;
  try {
    const mx = await dns.resolveMx(domain);
    result = (Array.isArray(mx) && mx.some(r => r && r.exchange && r.exchange.trim()))
      ? { ok: true, why: mx.sort((a, b) => a.priority - b.priority)[0].exchange }
      : { ok: false, why: 'no MX records' };
  } catch (e) {
    // ENOTFOUND / ENODATA means the domain cannot receive mail. Anything else (timeout,
    // SERVFAIL) is transient and must not condemn a good address.
    result = (e.code === 'ENOTFOUND' || e.code === 'ENODATA')
      ? { ok: false, why: e.code }
      : { ok: true, why: `${e.code}, transient, allowed` };
  }
  mxCache.set(domain, result);
  return result;
}

const problems = [];
const flag = (lead, why) => problems.push(`${String(lead.business_name).slice(0, 34).padEnd(36)}${why}`);

(async () => {
  const { data: due, error } = await supabase.from(TABLE)
    .select('id, business_name, email, website, city, address, contact_name, status, sequence_step, '
          + 'email_subject, email_body, followup_subject, followup2_subject, signal_quote, '
          + 'scheduled_send_at, copy_locked')
    .not('scheduled_send_at', 'is', null)
    .in('status', ['queued', 'sent'])
    .order('scheduled_send_at');
  if (error) throw new Error(error.message);

  console.log(`PRE-FLIGHT: ${due.length} send(s) scheduled\n`);

  // 1. Deliverability. The one that costs the sending domain rather than one lead.
  console.log('MX CHECK');
  let dead = 0;
  for (const l of due) {
    const mx = await acceptsMail(l.email);
    if (!mx.ok) { dead++; flag(l, `will hard-bounce: ${mx.why}`); }
    console.log(`  ${mx.ok ? 'ok  ' : 'DEAD'} ${String(l.email).padEnd(38)}${mx.why}`);
  }
  const rate = due.length ? dead / due.length : 0;
  console.log(`  ${dead} of ${due.length} undeliverable (${(rate * 100).toFixed(1)}%), breaker trips at 5%\n`);

  // 2. Everything the sender will refuse at send time. Better to know now than to watch a batch
  //    shrink silently tomorrow morning.
  console.log('SEND-TIME GATES');
  for (const l of due) {
    const org = excludedOrgReason(l.business_name, l.email);
    if (org) flag(l, org);
    const step = l.sequence_step || 0;
    const need = [['email_subject', 'email_body'], ['followup_subject', 'followup_body'],
                  ['followup2_subject', 'followup2_body']][step];
    if (!need) { flag(l, 'sequence already complete but still scheduled'); continue; }
    if (!l[need[0]]) flag(l, `step ${step + 1} copy missing (${need[0]})`);
    if (l.email_body && !/\n\s*\n/.test(l.email_body)) flag(l, 'body is one wall of text');
    // A body needs a closing ask, but the {{ASK}} token is only one way to have one. Copy that
    // ends in its own question is deliberate, and cadre/offer.js applyAsk() leaves it alone
    // rather than stapling a second ask on. Flagging the token's absence alone was a false
    // positive on Surespan, whose hand-written close is a question.
    if (step === 0 && l.email_body
        && !l.email_body.includes('{{ASK}}')
        && !/\?["')\]]?\s*$/.test(l.email_body.trim())) {
      flag(l, 'no closing ask: neither an {{ASK}} token nor a question');
    }
  }
  console.log(problems.length ? '' : '  nothing blocked\n');

  // 3. Timing, in the recipient's own clock. The whole point of the timezone work.
  console.log('WHEN THEY WILL SEE IT');
  const byDay = {};
  for (const l of due) {
    const z = zoneFor(l.city || l.address, l.address);
    const when = new Date(l.scheduled_send_at);
    const label = localLabel(z, when);
    const hour = parseInt(new Intl.DateTimeFormat('en-US',
      { timeZone: z, hour12: false, hour: '2-digit' }).format(when), 10);
    if (hour < 9 || hour >= 11) flag(l, `lands at ${label} local, outside 09:00-11:00`);
    (byDay[l.scheduled_send_at.slice(0, 10)] ||= []).push(
      `    ${label.padEnd(22)} t${(l.sequence_step || 0) + 1}  ${String(l.business_name).slice(0, 32)}`);
  }
  for (const [day, rows] of Object.entries(byDay).sort()) {
    console.log(`  ${day}  (${rows.length})`);
    rows.forEach(r => console.log(r));
  }

  // 4. One full message, rendered exactly as it will arrive. Reading it is the check.
  const sample = due.find(l => (l.sequence_step || 0) === 0);
  if (sample) {
    console.log(`\nSAMPLE, as ${sample.business_name} will receive it`);
    console.log('-'.repeat(74));
    console.log(`Subject: ${sample.email_subject}\n`);
    console.log(sample.email_body.replace('{{ASK}}', '<ASK substituted at send time>')
      + signature({ optOut: 'Not relevant? Reply with a no and I will not email again.',
                    tagline: 'Staff records, training and credentials in one system.' }));
    console.log('-'.repeat(74));
  }

  console.log(`\n${problems.length ? 'PROBLEMS:' : 'No problems found.'}`);
  problems.forEach(p => console.log(`  ! ${p}`));
  process.exit(problems.length ? 1 : 0);
})().catch(e => { console.error('preflight failed:', e.message); process.exit(1); });
