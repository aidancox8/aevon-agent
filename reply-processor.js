/**
 * reply-processor.js
 * Reads inbound replies from Gmail over IMAP, matches each message to a lead,
 * classifies the reply intent with Gemini, updates CRM state (status + queue),
 * logs an email_event, and drafts a suggested response into Gmail Drafts for review.
 *
 * Nothing is ever sent automatically — drafts wait in your Gmail for you to approve.
 *
 * Required env:
 *   GMAIL_USER           your full Google Workspace address (aidan@aevon.ca)
 *   GMAIL_APP_PASSWORD   a Google app password (Account > Security > App passwords)
 *
 * Usage: node reply-processor.js
 */

require('dotenv').config();
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const MailComposer = require('nodemailer/lib/mail-composer');
const supabase = require('./lib/supabase');
const { createGenerate } = require('./lib/gemini');

const generate = createGenerate(process.env.GEMINI_API_KEY);

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const LOOKBACK_DAYS = 14;

// ── Matching helpers ──────────────────────────────────────────────

function normalizeSubject(s) {
  return (s || '')
    .replace(/^(\s*(re|fwd|fw)\s*:\s*)+/i, '')
    .trim()
    .toLowerCase();
}

function domainOf(email) {
  const m = (email || '').toLowerCase().match(/@([^@\s>]+)/);
  return m ? m[1] : null;
}

// Build lookup maps from every lead we've actually emailed.
function buildLeadIndex(leads) {
  const byEmail = new Map();
  const byDomain = new Map();
  const bySubject = new Map();
  for (const l of leads) {
    if (l.email) byEmail.set(l.email.toLowerCase(), l);
    const d = domainOf(l.email);
    // Only index a domain if it is unique to one lead — otherwise it is ambiguous.
    if (d) {
      if (byDomain.has(d)) byDomain.set(d, null);
      else byDomain.set(d, l);
    }
    for (const subj of [l.email_subject, l.followup_subject]) {
      const key = normalizeSubject(subj);
      if (key) bySubject.set(key, l);
    }
  }
  return { byEmail, byDomain, bySubject };
}

function matchLead(index, fromEmail, subject) {
  const email = (fromEmail || '').toLowerCase();
  if (index.byEmail.has(email)) return { lead: index.byEmail.get(email), via: 'email' };

  const subjKey = normalizeSubject(subject);
  if (subjKey && index.bySubject.has(subjKey)) return { lead: index.bySubject.get(subjKey), via: 'subject' };

  const d = domainOf(email);
  if (d && index.byDomain.get(d)) return { lead: index.byDomain.get(d), via: 'domain' };

  return { lead: null, via: null };
}

// ── Classification ────────────────────────────────────────────────

async function classifyReply(lead, replyText) {
  const prompt = `You are triaging a reply to a cold outreach email sent by Aevon, a custom software and AI agent company in the Lower Mainland, BC.

The reply came from this business:
- Name: ${lead.business_name}
- Industry: ${lead.industry || 'unknown'}

Their reply (most recent message only, ignore quoted history below the first separator):
"""
${replyText.slice(0, 1500)}
"""

Classify the intent into EXACTLY one of:
- "interested": they want to learn more, ask about pricing/process, want a call, or describe their problems
- "not_interested": they decline, say no thanks, ask to be removed, or unsubscribe
- "referral": they redirect you to another person or department
- "auto_reply": out-of-office, autoresponder, delivery notice, or no human content
- "question": a specific question that needs a human answer but intent is unclear
- "other": anything that does not fit above

Then write a short, human suggested reply (only if intent is interested, question, or referral — otherwise return an empty string). The reply should:
- Be 2-4 sentences, plain and direct, no buzzwords, no em dashes
- Move toward understanding their workflow or booking a short call
- Not over-promise or invent specifics about their business
- Not include a sign-off or signature (that is added separately)

Respond with JSON only:
{
  "intent": "...",
  "reason": "<one short sentence>",
  "suggested_reply": "..."
}`;

  try {
    const raw = await generate(prompt);
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { intent: 'other', reason: 'Could not parse classification', suggested_reply: '' };
    return JSON.parse(m[0]);
  } catch (err) {
    return { intent: 'other', reason: `Classifier error: ${err.message}`, suggested_reply: '' };
  }
}

// Map intent -> CRM status change. null means "leave status as-is".
function statusForIntent(intent) {
  switch (intent) {
    case 'not_interested': return 'dont_contact';
    case 'interested':
    case 'question':
    case 'referral':
    case 'other':           return 'replied';
    case 'auto_reply':      return null;
    default:                return null;
  }
}

// ── Gmail draft creation ──────────────────────────────────────────

const SIGNATURE = `\n\nAidan Cox\naidan@aevon.ca\nhttps://calendar.app.google/7R7srDKzWrvmLQg37`;

async function buildDraftMime(original, suggestedReply) {
  const to = original.from.value[0].address;
  const subject = /^re:/i.test(original.subject || '') ? original.subject : `Re: ${original.subject || ''}`;
  const inReplyTo = original.messageId;
  const references = [original.references, original.messageId].flat().filter(Boolean).join(' ');

  const mail = new MailComposer({
    from: GMAIL_USER,
    to,
    subject,
    text: suggestedReply + SIGNATURE,
    inReplyTo,
    references,
  });

  return new Promise((resolve, reject) => {
    mail.compile().build((err, msg) => (err ? reject(err) : resolve(msg)));
  });
}

// ── Main ──────────────────────────────────────────────────────────

async function run() {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    throw new Error('GMAIL_USER and GMAIL_APP_PASSWORD must be set in the environment.');
  }

  // Leads we have actually emailed (have a subject) — the only ones a reply can match.
  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, business_name, email, industry, status, sequence_step, last_sent_at, email_subject, followup_subject')
    .not('email_subject', 'is', null);
  if (error) throw new Error(`Supabase fetch failed: ${error.message}`);
  const index = buildLeadIndex(leads || []);

  // Already-processed inbound messages, so we never double-handle one.
  const { data: priorEvents } = await supabase
    .from('email_events')
    .select('metadata')
    .eq('event_type', 'replied');
  const processed = new Set(
    (priorEvents || [])
      .map(e => e.metadata?.inbound_message_id)
      .filter(Boolean)
  );

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    logger: false,
  });

  await client.connect();
  console.log('Connected to Gmail.\n');

  let matched = 0, unmatched = 0, skipped = 0, drafted = 0;

  const lock = await client.getMailboxLock('INBOX');
  try {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const uids = await client.search({ since }, { uid: true });

    for (const uid of uids) {
      const msg = await client.fetchOne(uid, { source: true }, { uid: true });
      if (!msg || !msg.source) continue;

      const parsed = await simpleParser(msg.source);
      const messageId = parsed.messageId;
      if (!messageId || processed.has(messageId)) { skipped++; continue; }

      const fromEmail = parsed.from?.value?.[0]?.address || '';
      // Skip anything we sent ourselves.
      if (fromEmail.toLowerCase() === GMAIL_USER.toLowerCase()) { skipped++; continue; }

      const { lead, via } = matchLead(index, fromEmail, parsed.subject);
      if (!lead) {
        unmatched++;
        console.log(`  [no match] ${fromEmail} — "${parsed.subject || ''}"`);
        continue;
      }

      const replyText = parsed.text || parsed.html?.replace(/<[^>]+>/g, ' ') || '';
      const { intent, reason, suggested_reply } = await classifyReply(lead, replyText);

      const newStatus = statusForIntent(intent);
      const update = {};
      if (newStatus) {
        update.status = newStatus;
        update.scheduled_send_at = null; // pull out of the send queue
      }
      if (Object.keys(update).length) {
        await supabase.from('leads').update(update).eq('id', lead.id);
      }

      await supabase.from('email_events').insert({
        lead_id: lead.id,
        event_type: 'replied',
        metadata: {
          source: 'reply-processor',
          inbound_message_id: messageId,
          matched_via: via,
          intent,
          reason,
          from: fromEmail,
          subject: parsed.subject || null,
          suggested_reply: suggested_reply || null,
          days_to_reply: lead.last_sent_at
            ? Math.round((Date.now() - new Date(lead.last_sent_at)) / 86400000)
            : null,
        },
      });

      matched++;
      console.log(`  [${intent}] ${lead.business_name} (via ${via}) — ${reason}`);

      // Draft a reply into Gmail for the intents worth answering.
      if (suggested_reply && ['interested', 'question', 'referral'].includes(intent)) {
        try {
          const mime = await buildDraftMime(parsed, suggested_reply);
          await client.append('[Gmail]/Drafts', mime, ['\\Draft']);
          drafted++;
          console.log(`      draft saved to Gmail Drafts`);
        } catch (err) {
          console.log(`      (draft failed: ${err.message})`);
        }
      }

      processed.add(messageId);
    }
  } finally {
    lock.release();
  }

  await client.logout();
  console.log(`\nDone. Matched: ${matched} | Drafts: ${drafted} | Unmatched: ${unmatched} | Skipped: ${skipped}`);
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
