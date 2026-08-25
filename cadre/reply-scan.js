#!/usr/bin/env node
/**
 * cadre/reply-scan.js — read the mailbox and act on what came back.
 *
 * WHY THIS HAD TO BE BUILT. Every Cadre email ends with "Reply with a no and I will not email
 * again." Nothing in this campaign read replies, so that sentence was a promise the system could
 * not keep. Under CASL an unsubscribe mechanism has to actually work and be honoured within ten
 * business days, and reply-processor.js only ever looked at the `leads` table, never this one.
 *
 * The second reason is the follow-up sequence. A follow-up that lands on someone who already
 * replied is the worst email in the whole campaign: it proves nobody read their answer. Nothing
 * may send a follow-up until this exists.
 *
 * WHAT IT DOES NOT DO. It does not reply, and it does not draft a reply. Classification here is
 * deterministic rather than model-driven, deliberately: the decision that matters is "did this
 * person ask to be left alone", and a regex that is slightly over-eager costs one lead, while a
 * model that is slightly under-eager costs a CASL breach. It errs toward stopping.
 *
 *   node cadre/reply-scan.js --dry
 *   node cadre/reply-scan.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { google } = require('googleapis');
const { simpleParser } = require('mailparser');
const supabase = require('../lib/supabase');

const TABLE = 'cadre_leads';
const EVENTS = 'cadre_email_events';
const DRY = process.argv.includes('--dry');
const LOOKBACK_DAYS = parseInt(process.env.CADRE_REPLY_LOOKBACK || '21', 10);
const GMAIL_USER = (process.env.GMAIL_USER || '').toLowerCase();

function gmailClient() {
  const oauth2 = new google.auth.OAuth2(
    process.env.GMAIL_OAUTH_CLIENT_ID, process.env.GMAIL_OAUTH_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: oauth2 });
}

const header = (payload, name) =>
  ((payload.headers || []).find(h => h.name.toLowerCase() === name.toLowerCase()) || {}).value || '';
const addressOf = v => {
  const m = String(v).match(/<([^>]+)>/) || String(v).match(/([^\s<>,]+@[^\s<>,]+)/);
  return m ? m[1].toLowerCase() : '';
};
const domainOf = e => (String(e).toLowerCase().match(/@([^@\s>]+)/) || [])[1] || '';
const normSubject = s => String(s || '').replace(/^(\s*(re|fwd|fw|automatic reply)\s*:\s*)+/i, '').trim().toLowerCase();

/**
 * A bounce is not a reply. Mail servers announce themselves consistently enough that this can be
 * decided on headers alone, which matters because a bounce marked "replied" would look like the
 * campaign working when it is the opposite.
 */
function isBounce(payload, fromEmail) {
  if (/mailer-daemon|postmaster/i.test(fromEmail)) return true;
  if (header(payload, 'X-Failed-Recipients')) return true;
  return /report-type=delivery-status/i.test(header(payload, 'Content-Type'));
}

/** Out-of-office and other robots. Not a human answer, so it must not stop or advance anything. */
function isAutoReply(payload, subject) {
  const auto = header(payload, 'Auto-Submitted');
  if (auto && !/^no$/i.test(auto)) return true;
  if (header(payload, 'X-Autoreply') || header(payload, 'X-Autorespond')) return true;
  if (/auto_reply|bulk|junk/i.test(header(payload, 'Precedence'))) return true;
  return /\b(out of (the )?office|automatic reply|auto[- ]?reply|on (annual )?leave|away from|vacation reply|no longer with)\b/i.test(subject || '');
}

/**
 * Did they ask to be left alone? Deliberately broad. The cost of a false positive is one lead
 * dropped; the cost of a false negative is emailing someone who said stop.
 */
const OPT_OUT = new RegExp([
  'unsubscrib',
  'opt[- ]?out',
  'remove me',
  'take me off',
  'stop (emailing|contacting|sending)',
  'do not (contact|email)',
  'not interested',
  'no thank',
  'please stop',
  'we are (all set|good)',
].join('|'), 'i');

/** A short bare "no" is the exact answer the footer invites, so it has to count. */
function isOptOut(text) {
  const t = String(text || '').replace(/^>.*$/gm, '').trim();   // drop the quoted original
  if (/^\s*no[.!]?\s*$/i.test((t.split('\n')[0] || ''))) return true;
  return OPT_OUT.test(t.slice(0, 400));
}

const POSITIVE = /\b(interested|tell me more|sounds good|happy to|let'?s (talk|chat|set)|book a|call me|send (it|them|that|me)? ?(over|through|more|info|details)|what does it cost|pricing|demo|how much|keen|worth a look)\b/i;
const REFERRAL = /\b(speak to|reach out to|forward(ed|ing)? (this )?to|copying|cc'?ing|is the right person|handles this)\b/i;

function classify(text) {
  if (isOptOut(text)) return 'opt_out';
  if (POSITIVE.test(text)) return 'interested';
  if (REFERRAL.test(text)) return 'referral';
  return 'reply';
}

const STATUS_FOR = { opt_out: 'unsubscribed', interested: 'replied', referral: 'replied', reply: 'replied' };

/** Exported so check-cadre-replies.js tests the real classifier, not a copy of it. */
module.exports = { classify, isOptOut, isBounce, isAutoReply };

// Only scan the mailbox when run directly. Required as a module, this file just exposes the
// classifier, so a test cannot accidentally reach into the inbox.
if (require.main !== module) return;

(async () => {
  if (!process.env.GMAIL_OAUTH_REFRESH_TOKEN) {
    throw new Error('GMAIL_OAUTH_REFRESH_TOKEN missing. Run: node get-gmail-token.js');
  }
  const gmail = gmailClient();

  // Only leads we have actually emailed can have replied.
  const { data: leads, error } = await supabase.from(TABLE)
    .select('id, business_name, email, status, contact_name, last_sent_at, email_subject')
    .not('email_subject', 'is', null);
  if (error) throw new Error(error.message);

  const byEmail = new Map(), byDomain = new Map(), bySubject = new Map();
  for (const l of (leads || [])) {
    if (l.email) {
      byEmail.set(l.email.toLowerCase(), l);
      const d = domainOf(l.email);
      // A domain hit is only trustworthy when one lead owns that domain; otherwise it guesses.
      if (d) byDomain.set(d, byDomain.has(d) ? null : l);
    }
    if (l.email_subject) bySubject.set(normSubject(l.email_subject), l);
  }

  // Never handle the same inbound message twice.
  const { data: prior } = await supabase.from(EVENTS).select('metadata').eq('event_type', 'replied');
  const seen = new Set((prior || []).map(e => e.metadata && e.metadata.inbound_message_id).filter(Boolean));

  const list = await gmail.users.messages.list({
    userId: 'me', maxResults: 200,
    q: `newer_than:${LOOKBACK_DAYS}d -from:${GMAIL_USER}`,
  });
  const ids = (list.data.messages || []).map(m => m.id);
  console.log(`${DRY ? 'DRY RUN: ' : ''}scanning ${ids.length} inbound message(s) from the last ${LOOKBACK_DAYS} days\n`);

  let matched = 0, optOuts = 0, bounces = 0, autos = 0, already = 0;

  for (const id of ids) {
    const full = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const payload = full.data.payload || {};
    const msgId = header(payload, 'Message-ID');
    if (!msgId || seen.has(msgId)) { already++; continue; }

    const from = addressOf(header(payload, 'From'));
    if (!from || from === GMAIL_USER) continue;
    const subject = header(payload, 'Subject');

    // Match: exact address, then a domain only one lead owns, then our own subject coming back.
    const lead = byEmail.get(from) || byDomain.get(domainOf(from)) || bySubject.get(normSubject(subject));
    if (!lead) continue;

    if (isBounce(payload, from)) {
      bounces++;
      console.log(`  [bounce]    ${lead.business_name} <${from}>`);
      if (!DRY) {
        await supabase.from(TABLE).update({ status: 'bounced', scheduled_send_at: null }).eq('id', lead.id);
        await supabase.from(EVENTS).insert({ lead_id: lead.id, event_type: 'bounced',
          metadata: { source: 'reply-scan', inbound_message_id: msgId, from } });
      }
      continue;
    }

    if (isAutoReply(payload, subject)) {
      autos++;
      console.log(`  [auto]      ${lead.business_name} <${from}> "${String(subject).slice(0, 50)}"`);
      if (!DRY) {
        await supabase.from(EVENTS).insert({ lead_id: lead.id, event_type: 'held',
          metadata: { source: 'reply-scan', reason: 'auto-reply', inbound_message_id: msgId, from, subject } });
      }
      continue;
    }

    const raw = await gmail.users.messages.get({ userId: 'me', id, format: 'raw' });
    const parsed = await simpleParser(Buffer.from(raw.data.raw, 'base64'));
    const text = parsed.text || (parsed.html || '').replace(/<[^>]+>/g, ' ') || full.data.snippet || '';

    const intent = classify(text);
    if (intent === 'opt_out') optOuts++;
    matched++;

    console.log(`  [${intent.padEnd(10)}] ${String(lead.business_name).slice(0, 30).padEnd(32)} <${from}>`);
    console.log(`               "${text.replace(/\s+/g, ' ').slice(0, 110)}"`);

    if (!DRY) {
      // scheduled_send_at is cleared on every path. A reply of any kind stops the sequence;
      // whether it was a yes or a no is a question for a human, not for the sender.
      await supabase.from(TABLE).update({ status: STATUS_FOR[intent], scheduled_send_at: null }).eq('id', lead.id);
      await supabase.from(EVENTS).insert({
        lead_id: lead.id, event_type: 'replied',
        metadata: {
          source: 'reply-scan', inbound_message_id: msgId, from, subject: subject || null, intent,
          excerpt: text.replace(/\s+/g, ' ').slice(0, 400),
          days_to_reply: lead.last_sent_at ? Math.round((Date.now() - new Date(lead.last_sent_at)) / 86400000) : null,
        },
      });
    }
  }

  console.log(`\nDone. Replies: ${matched} (opt-outs: ${optOuts}) | Bounces: ${bounces} | ` +
    `Auto-replies ignored: ${autos} | Already handled: ${already}`);
  if (matched) console.log('Nothing was answered. Replies are yours to read and respond to.');
})().catch(e => { console.error('cadre reply-scan failed:', e.message); process.exit(1); });
