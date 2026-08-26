#!/usr/bin/env node
/**
 * cadre/sender.js — the Cadre (HR / credentials) sender.
 *
 * Third campaign, same shape as sender.js (Aevon) and tempo/sender.js (Tempo), so the three
 * can be compared honestly in the daily review. Everything learned on the other two is carried
 * over rather than rediscovered:
 *
 *  - PLAIN TEXT ONLY, no html part. Proven by seed test 2026-08-18: the identical message
 *    reached the inbox as plain text and was spam-foldered by Gmail and QUARANTINED AS PHISHING
 *    by Microsoft as HTML, because the signature stacked anchor text that disagreed with its
 *    href plus a remote image. Guarded permanently by check-email-shape.js.
 *  - Bounce breaker. Halts above 5%, because a bad list damages the sending domain for every
 *    campaign, not just this one.
 *  - Excluded-org gate on every send, not just at intake. Changepain sat queued in tempo_leads
 *    and received two emails before anyone noticed.
 *  - Off-domain and freemail address guard. The email hunter has picked up Google Fonts author
 *    addresses out of a stylesheet and a US telecom's address for a BC lab.
 *  - Retired-copy guard. Stored copy has outlived three offer decisions on the Aevon side.
 *
 * Two things are deliberately different here.
 *
 * DAILY CAP IS TINY. Aevon ran at 85/day into a scraped list and produced zero meetings across
 * 3,506 sends. This list is signal-qualified and hand-checked, so the constraint is not volume,
 * it is whether the argument works. 5 a day makes every reply legible.
 *
 * A SIGNAL QUOTE IS MANDATORY. The premise of the campaign is quoting the prospect's own
 * published words back to them. A lead whose quote is missing, or whose copy does not actually
 * contain the quote, is not sendable. That is checked here, not assumed.
 *
 *   node cadre/sender.js                        dry run
 *   node cadre/sender.js --send                 send for real (Gmail by default)
 *   node cadre/sender.js --send --via resend    send through Resend instead
 *   node cadre/sender.js --limit 3              cap this run
 *
 * Timing, sequence and opt-out live in three sibling files, not here:
 *   cadre/timezone.js    what time it is where the recipient is
 *   cadre/schedule.js    books each touch at 09:00-11:00 their time, Tue-Thu
 *   cadre/reply-scan.js  reads the mailbox and stops the sequence when somebody answers
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Resend } = require('resend');
const supabase = require('../lib/supabase');
const { excludedOrgReason } = require('../tempo/dnc');
const { google } = require('googleapis');
const { signature } = require('../lib/signature');
const dns = require('dns').promises;
// Pin clean resolvers. An ISP that hijacks NXDOMAIN injects A records for dead domains and would
// turn the check below into a rubber stamp.
try { dns.setServers(['8.8.8.8', '1.1.1.1']); } catch (e) { /* keep system resolvers */ }

/**
 * Does this domain have a mail server? A domain with no MX hard-bounces every time, and a hard
 * bounce costs the sending domain's reputation for all three campaigns, not just this one.
 *
 * sender.js (Aevon) has had this since June. This file never did, which meant the only thing
 * standing between a dead domain and a bounce was that the addresses happened to be hand-checked.
 * Cached per run, so repeated domains cost one lookup.
 */
const mxCache = new Map();
async function domainAcceptsMail(email) {
  const domain = (String(email).split('@')[1] || '').toLowerCase().trim();
  if (!domain) return false;
  if (mxCache.has(domain)) return mxCache.get(domain);
  let ok;
  try {
    const mx = await dns.resolveMx(domain);
    ok = Array.isArray(mx) && mx.some(r => r && r.exchange && r.exchange.trim());
  } catch (e) {
    // ENOTFOUND / ENODATA means it genuinely cannot receive mail. Everything else (timeout,
    // SERVFAIL) is transient and must not condemn a good address.
    ok = !(e.code === 'ENOTFOUND' || e.code === 'ENODATA');
  }
  mxCache.set(domain, ok);
  return ok;
}

const TABLE = 'cadre_leads';
const EVENTS = 'cadre_email_events';
const resend = new Resend(process.env.RESEND_API_KEY);
const { zoneFor, nextSendSlot } = require('./timezone');

/**
 * THE SEQUENCE. One touch throws away most of the campaign: across published cold-email data
 * follow-ups roughly double total replies, and the last one, the short note that says you will
 * stop, reliably outperforms the middle of the sequence.
 *
 * Gaps are in SEND SLOTS, not calendar days, because a slot is already Tue-Thu 09:00-11:00 in
 * their zone. Two slots is about a week, four is about a fortnight.
 *
 * Nothing here can reach someone who answered: cadre/reply-scan.js moves a reply to `replied`
 * or `unsubscribed`, and the due query below only ever looks at `queued` and `sent`.
 */
const SEQUENCE = [
  { step: 0, subject: 'email_subject',     body: 'email_body',     gapSlots: 2 },
  { step: 1, subject: 'followup_subject',  body: 'followup_body',  gapSlots: 3 },
  { step: 2, subject: 'followup2_subject', body: 'followup2_body', gapSlots: 0 },
];

const FROM = process.env.FROM_EMAIL || 'aidan@aevon.ca';
const FROM_NAME = 'Aidan Cox';
const REPLY_TO = 'aidan@aevon.ca';

/**
 * WHICH PIPE THE MAIL GOES DOWN. Gmail, as of 2026-08-25. Aidan's call, and he is right.
 *
 * The argument for Resend was that it reports bounces by webhook, and the 5% breaker above
 * depends on knowing the bounce rate. That is real, but it is not decisive here:
 * cadre/reply-scan.js now attributes Gmail bounces (a bounce comes from mailer-daemon, not the
 * prospect, so it is matched on the recipient named inside the report) and writes them to the
 * same events table bounceRate() reads. It runs immediately before this sender on every hourly
 * cycle, so the breaker is at most an hour behind a webhook. At a 12/day cap that is one or two
 * extra sends before it trips.
 *
 * The argument for Gmail turned out to be the stronger one, and it is not about deliverability,
 * since both send from aevon.ca under the same SPF, DKIM and DMARC. It is that Resend sends
 * leave no trace in the mailbox: 3,824 Aevon emails have gone out through it and the Sent folder
 * holds 46 messages. None of that outreach is searchable, quotable, or visible next to the reply
 * it produced. Gmail sends thread properly and land in Sent.
 *
 * Keep Resend reachable rather than deleting it. Set the CADRE_VIA repository variable to
 * 'resend' to switch back, for instance if the daily cap ever rises near Workspace's 2,000
 * external recipients a day, or if bounce latency starts to matter.
 */
const VIA = (() => {
  const i = process.argv.indexOf('--via');
  const v = i > -1 ? String(process.argv[i + 1] || '').toLowerCase()
                   : (process.env.CADRE_VIA || 'gmail').toLowerCase();
  if (!['resend', 'gmail'].includes(v)) throw new Error(`--via must be resend or gmail, got "${v}"`);
  if (v === 'gmail' && !process.env.GMAIL_OAUTH_REFRESH_TOKEN) {
    throw new Error('--via gmail needs GMAIL_OAUTH_REFRESH_TOKEN. Run: node get-gmail-token.js');
  }
  if (v === 'resend' && !process.env.RESEND_API_KEY) {
    throw new Error('--via resend needs RESEND_API_KEY');
  }
  return v;
})();

/** Hand the raw RFC822 message to Gmail. Plain text only, same as the Resend path. */
async function sendViaGmail({ from, fromName, replyTo, to, subject, text }) {
  const oauth2 = new google.auth.OAuth2(
    process.env.GMAIL_OAUTH_CLIENT_ID, process.env.GMAIL_OAUTH_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN });
  const gmail = google.gmail({ version: 'v1', auth: oauth2 });

  // RFC 2047 encode the display name so a non-ASCII character cannot corrupt the header.
  const raw = [
    `From: =?UTF-8?B?${Buffer.from(fromName).toString('base64')}?= <${from}>`,
    `To: ${to}`,
    `Reply-To: ${replyTo}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text).toString('base64'),
  ].join('\r\n');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: Buffer.from(raw).toString('base64url') },
  });
  return { id: res.data.id };
}

const IS_CI = !!process.env.GITHUB_ACTIONS;
const LIVE = IS_CI || process.argv.includes('--send');
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  return i > -1 ? parseInt(process.argv[i + 1], 10) : null;
})();

/** Deliberately small. See the header: the constraint is the argument, not the volume. */
const DAILY_CAP = parseInt(process.env.CADRE_DAILY_CAP || '5', 10);
const BOUNCE_LIMIT = 0.05;
const BOUNCE_WINDOW = 100;

const FREEMAIL = /@(gmail|hotmail|outlook|yahoo|icloud|live|aol|proton|gmx)\./i;

/**
 * Inboxes that will not route a pitch about staff records, whatever the domain says.
 *
 * Nine scheduled leads pointed at one of these, including the two highest-scoring in the whole
 * campaign. They passed the domain guard because sales@atstraffic.ca genuinely is their domain.
 * That is the point: the domain check answers "is this the right company", not "is this the
 * right person", and an HR pitch landing in a sales queue is a wasted send and a slightly worse
 * sender reputation.
 */
const WRONG_DESK = /^(sales|sales-[a-z]+|service|servicedesk|support|techsupport|billing|accounts|accountspayable|accountsreceivable|invoices|orders|parts|shipping|dispatch|marketing|media|press|webmaster|noreply|no-reply|donations|volunteer|urethane|craneservice|fire|security|reception|bookings|quotes|estimating)@/i;
const PLACEHOLDER = /^(your|email|name|test|example|info@example)/i;

/**
 * THE LEGAL FOOTER. This is not decoration.
 *
 * CASL s.6(2) requires every commercial electronic message to identify the sender and give a
 * MAILING ADDRESS valid for at least 60 days, plus an unsubscribe mechanism that actually works.
 * CAN-SPAM requires the same physical postal address for the US half of the list. The footer used
 * to read "Aevon, Vancouver BC", which is a city, not an address, and satisfies neither.
 *
 * Raised with Aidan on 2026-08-25 and declined: he does not want an address in the footer and
 * accepts the risk. So CADRE_MAILING_ADDRESS is read from the environment, the sender WARNS on
 * every run while it is empty, and setting that one variable closes the gap whenever he wants.
 * The line is dropped from the footer entirely when unset rather than left blank.
 *
 * The opt-out line is honoured by cadre/reply-scan.js, which reads the mailbox and moves anyone
 * who says no to `unsubscribed`. Without that scanner this sentence would be a lie.
 */
const MAILING_ADDRESS = (process.env.CADRE_MAILING_ADDRESS || '').trim();

// Built by lib/signature.js so all three campaigns share one sign-off and cannot drift apart
// again. They already had: Aevon's went missing entirely on 2026-08-18 and nobody noticed for a
// week, because the only copy of it lived in a function that had stopped being called.
const FOOTER = signature({
  optOut: 'Not relevant? Reply with a no and I will not email again.',
  address: MAILING_ADDRESS,
  tagline: 'Staff records, training and credentials in one system.',
});

/** Longest run of consecutive words from the quote that appears in the body. */
function longestVerbatimRun(quote, body) {
  const q = String(quote).toLowerCase().replace(/\s+/g, ' ').split(' ');
  const b = ' ' + String(body).toLowerCase().replace(/\s+/g, ' ') + ' ';
  let best = 0;
  for (let i = 0; i < q.length; i++) {
    for (let j = q.length; j > i + best; j--) {
      const run = q.slice(i, j).join(' ');
      if (run.length > 3 && b.includes(run)) { best = Math.max(best, j - i); break; }
    }
  }
  return best;
}

const rootDomain = h => String(h || '').replace(/^https?:\/\//, '').replace(/^www\./, '')
  .split('/')[0].toLowerCase().split('.').slice(-2).join('.');

/**
 * Every reason a lead must not be sent to, checked at send time rather than trusted from
 * intake. Each of these corresponds to something that actually went wrong on another campaign.
 */
function blockReason(lead, stepNo) {
  if (!lead.email) return 'no address';
  if (PLACEHOLDER.test(lead.email)) return 'placeholder address';
  if (FREEMAIL.test(lead.email)) return 'freemail address, likely a scraping artifact';
  if (WRONG_DESK.test(lead.email)) return `${lead.email.split('@')[0]}@ will not route an HR pitch`;
  if (lead.website && rootDomain(lead.email.split('@')[1]) !== rootDomain(lead.website)) {
    return `address domain does not match ${rootDomain(lead.website)}`;
  }
  const org = excludedOrgReason(lead.business_name, lead.email);
  if (org) return org;

  if (!lead.signal_quote || lead.signal_quote.trim().length < 20) return 'no signal quote';
  if (!lead.email_subject || !lead.email_body) return 'no copy written';

  // The campaign's whole premise. If the body does not carry their own words, this is just
  // another cold email and should not go out under this campaign's name.
  //
  // This originally compared only the FIRST few words of the quote, which blocked the strongest
  // lead in the campaign: MJ Roofing's quote runs "Deliver safety orientations, ongoing
  // training, toolbox talks, and maintain employee training records and certifications", and the
  // email quotes the END of it. Measure the longest run of their words that survives ANYWHERE in
  // the body, the same way the personalizer does.
  // Follow-ups are exempt. They are a reply to a thread that already quoted them, and restating
  // the quote a second time would read as a mail merge, which is the thing this check exists to
  // prevent. Blocking a follow-up on it is the check firing at the wrong target.
  if (stepNo > 0) return null;

  const run = longestVerbatimRun(lead.signal_quote, lead.email_body);
  const quoteWords = lead.signal_quote.trim().split(/\s+/).length;
  const need = Math.min(5, Math.max(3, quoteWords - 2));
  if (run < need) return `only ${run} consecutive words of their quote survived, need ${need}`;
  return null;
}

async function log(leadId, type, metadata) {
  const { error } = await supabase.from(EVENTS).insert({ lead_id: leadId, event_type: type, metadata });
  if (error) console.error(`  (event log failed: ${error.message})`);
}

async function bounceRate() {
  const { data } = await supabase.from(EVENTS)
    .select('event_type').in('event_type', ['sent', 'bounced'])
    .order('created_at', { ascending: false }).limit(BOUNCE_WINDOW * 2);
  const rows = data || [];
  const sent = rows.filter(r => r.event_type === 'sent').length;
  const bounced = rows.filter(r => r.event_type === 'bounced').length;
  return { rate: sent ? bounced / sent : 0, sent, bounced };
}

(async () => {
  if (!LIVE) console.log('DRY RUN: no email will be sent. Pass --send to send for real.\n');

  const { rate, sent: sentN, bounced } = await bounceRate();
  if (sentN >= 20 && rate > BOUNCE_LIMIT && !process.env.ALLOW_HIGH_BOUNCE) {
    console.error(`HALTED: bounce rate ${(rate * 100).toFixed(1)}% (${bounced}/${sentN}) is above ${BOUNCE_LIMIT * 100}%.`);
    console.error('A bad list damages the sending domain for all three campaigns. Clean it first.');
    process.exit(1);
  }
  // Raised with Aidan on 2026-08-25 and declined: he does not want a mailing address in the
  // footer. It stays a warning rather than a block, so the risk is visible on every run and one
  // env var closes it if he changes his mind. Not my call to make for him.
  if (!MAILING_ADDRESS) {
    console.warn('  ! No CADRE_MAILING_ADDRESS. CASL s.6(2) and CAN-SPAM both require a physical');
    console.warn('    mailing address in commercial email. Sending anyway, as agreed.\n');
  }

  if (sentN) console.log(`Bounce rate ${(rate * 100).toFixed(1)}% over last ${sentN} sends (limit ${BOUNCE_LIMIT * 100}%).`);

  const today = new Date().toISOString().slice(0, 10);
  const { data: todaySent } = await supabase.from(EVENTS)
    .select('id').eq('event_type', 'sent').gte('created_at', today + 'T00:00:00Z');
  const already = (todaySent || []).length;
  const room = Math.max(0, DAILY_CAP - already);
  if (!room) { console.log(`Daily cap reached (${already}/${DAILY_CAP}).`); return; }

  const now = new Date().toISOString();
  const { data: due, error } = await supabase.from(TABLE)
    .select('id, business_name, email, website, contact_name, contact_role, city, address, signal_quote, signal_url, ' +
            'email_subject, email_body, followup_subject, followup_body, followup2_subject, followup2_body, ' +
            'sequence_step, last_sent_at, qualification_score, scheduled_send_at')
    // 'sent' is included because a lead stays `sent` between sequence steps. 'replied',
    // 'unsubscribed', 'bounced' and 'dont_contact' are absent on purpose: those are the four
    // ways a lead earns the right never to hear from us again.
    .in('status', ['queued', 'sent'])
    .not('email_subject', 'is', null)
    .not('email', 'is', null)
    .lte('scheduled_send_at', now)
    .order('qualification_score', { ascending: false, nullsFirst: false })
    .order('scheduled_send_at', { ascending: true })
    .limit(200);
  if (error) throw new Error(error.message);

  const batch = (due || []).slice(0, LIMIT ? Math.min(LIMIT, room) : room);
  if (!batch.length) { console.log('Nothing scheduled and due.'); return; }

  console.log(`${LIVE ? 'Sending' : 'Would send'} ${batch.length} via ${VIA} ` +
    `(${already}/${DAILY_CAP} sent today)\n`);

  let sent = 0, blocked = 0, failed = 0;
  for (const lead of batch) {
    // Which touch is this? A lead sits at sequence_step 0 until the first email goes out.
    const stepNo = lead.sequence_step || 0;
    const stage = SEQUENCE[stepNo];
    if (!stage) {
      console.log(`  [done]  ${lead.business_name} - sequence complete`);
      if (LIVE) await supabase.from(TABLE).update({ scheduled_send_at: null }).eq('id', lead.id);
      continue;
    }

    let block = blockReason(lead, stepNo);
    // Checked here rather than inside blockReason because it needs a DNS round trip and
    // blockReason is synchronous everywhere else it is used.
    if (!block && !(await domainAcceptsMail(lead.email))) {
      block = `${String(lead.email).split('@')[1]} has no mail server, would hard-bounce`;
    }
    if (block) {
      console.log(`  [block] ${lead.business_name} - ${block}`);
      blocked++;
      if (LIVE) {
        await log(lead.id, 'held', { reason: block, email: lead.email });
        await supabase.from(TABLE).update({ notes: `HELD BY SENDER: ${block}` }).eq('id', lead.id);
      }
      continue;
    }

    const rawSubject = lead[stage.subject];
    const rawBody = lead[stage.body];
    if (!rawSubject || !rawBody) {
      console.log(`  [block] ${lead.business_name} - step ${stepNo + 1} copy not written`);
      blocked++;
      continue;
    }

    // A follow-up must never land the same week as the message before it. The scheduler already
    // spaces them, but a manual reschedule or a re-run could collapse the gap, and a follow-up
    // arriving a day after the first email reads as a machine, not a person.
    if (stepNo > 0 && lead.last_sent_at) {
      const daysSince = (Date.now() - new Date(lead.last_sent_at)) / 86400000;
      if (daysSince < 4) {
        console.log(`  [block] ${lead.business_name} - only ${daysSince.toFixed(1)}d since the last email`);
        blocked++;
        continue;
      }
    }

    // Follow-ups carry the original subject so they thread in the recipient's client rather than
    // arriving as a second unrelated cold email.
    const subject = stepNo === 0 ? rawSubject
      : (/^re:/i.test(rawSubject) ? rawSubject : `Re: ${lead.email_subject}`);
    const body = rawBody.trim() + FOOTER;
    process.stdout.write(`  ${String(stepNo + 1)}/3 ${lead.business_name.slice(0, 30).padEnd(32)}${lead.email.padEnd(34)}`);

    if (!LIVE) { console.log(`[dry] "${subject}"`); sent++; continue; }

    let data, sendErr;
    if (VIA === 'gmail') {
      try {
        data = await sendViaGmail({
          from: FROM, fromName: FROM_NAME, replyTo: REPLY_TO,
          to: lead.email, subject, text: body,
        });
      } catch (e) { sendErr = e; }
    } else {
      ({ data, error: sendErr } = await resend.emails.send({
        from: `${FROM_NAME} <${FROM}>`,
        reply_to: REPLY_TO,
        to: lead.email,
        subject,
        // PLAIN TEXT ONLY. No html key, ever. See the header.
        text: body,
      }));
    }

    if (sendErr) {
      console.log(`FAILED: ${sendErr.message}`);
      await log(lead.id, 'error', { error: sendErr.message, email: lead.email, via: VIA });
      failed++;
      continue;
    }
    console.log('sent');
    await log(lead.id, 'sent', {
      email: lead.email, subject, step: stepNo + 1, via: VIA, resend_id: data && data.id,
      contact: lead.contact_name || null, signal_url: lead.signal_url || null,
    });

    // Book the next touch now, in their zone, or close the sequence out. Doing it here rather
    // than in a nightly job means a lead can never sit half-advanced: the row that records the
    // send is the same row that records what happens next.
    const nextStep = stepNo + 1;
    const hasNext = SEQUENCE[nextStep] &&
      lead[SEQUENCE[nextStep].subject] && lead[SEQUENCE[nextStep].body];
    const nextAt = (stage.gapSlots && hasNext)
      ? nextSendSlot(zoneFor(lead.city || lead.address, lead.address), stage.gapSlots, 20).toISOString()
      : null;

    await supabase.from(TABLE).update({
      status: 'sent', last_sent_at: new Date().toISOString(),
      sequence_step: nextStep, resend_email_id: data && data.id,
      scheduled_send_at: nextAt,
    }).eq('id', lead.id);
    sent++;
  }

  console.log(`\nDone. Sent: ${sent} | Blocked: ${blocked} | Failed: ${failed}`);
})().catch(e => { console.error('cadre sender failed:', e.message); process.exit(1); });
