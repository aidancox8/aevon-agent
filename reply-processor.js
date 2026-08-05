/**
 * reply-processor.js
 * Reads inbound replies from Gmail via the Gmail API (OAuth refresh token),
 * matches each message to a lead, classifies the reply intent with Gemini,
 * updates CRM state (status + queue), logs an email_event, and drafts a
 * suggested response into Gmail Drafts for review.
 *
 * Nothing is ever sent automatically — drafts wait in Gmail for you to approve.
 *
 * Required env:
 *   GMAIL_USER                  the mailbox address (aidan@aevon.ca)
 *   GMAIL_OAUTH_CLIENT_ID
 *   GMAIL_OAUTH_CLIENT_SECRET
 *   GMAIL_OAUTH_REFRESH_TOKEN   from get-gmail-token.js
 *
 * Usage: node reply-processor.js
 */

require('dotenv').config();
const { google } = require('googleapis');
const { simpleParser } = require('mailparser');
const MailComposer = require('nodemailer/lib/mail-composer');
const supabase = require('./lib/supabase');
const { createGenerate } = require('./lib/gemini');

const generate = createGenerate(process.env.GEMINI_API_KEY);

const GMAIL_USER = process.env.GMAIL_USER;
const LOOKBACK_DAYS = 14;

// ── Gmail client ──────────────────────────────────────────────────

function gmailClient() {
  const oauth2 = new google.auth.OAuth2(
    process.env.GMAIL_OAUTH_CLIENT_ID,
    process.env.GMAIL_OAUTH_CLIENT_SECRET
  );
  oauth2.setCredentials({ refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: oauth2 });
}

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
    // Only index a domain if it is unique to one lead — otherwise ambiguous.
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

/**
 * Autoresponder subjects, checked before the model sees anything.
 *
 * An out-of-office that names a colleague reads as genuine human content, and the classifier
 * fell for exactly that: a message titled "Automatic reply: bousfield & associates intake"
 * mentioned that Randy was away and to contact Neil, so it was scored as a referral and a
 * reply was drafted opening "Hi Neil" but addressed to Randy. Sending that would have been
 * embarrassing, and it wasted a draft on a robot.
 *
 * The subject line is unambiguous where the body is not, so this decides first and the model
 * never gets the chance to be clever about it.
 */
const AUTORESPONDER_SUBJECT = /^(re:\s*)?(automatic reply|auto[- ]?reply|out of office|ooo\b|autoresponse|automatic response|away from (the )?office|vacation reply|undeliverable|delivery status notification|mail delivery|returned mail|delivery has failed)/i;

/** Body phrasings that only appear in an autoresponder. */
const AUTORESPONDER_BODY = /\b(i am (currently )?out of the office|i'm (currently )?out of the office|thank you for your (email|message)[,.]? (i|we) (am|are) currently (away|out)|this is an automated (reply|response|message)|do not reply to this (email|message)|your message has been received and)/i;

function autoresponderReason(subject, body) {
  if (AUTORESPONDER_SUBJECT.test(String(subject || '').trim())) return 'subject is an autoresponder';
  if (AUTORESPONDER_BODY.test(String(body || ''))) return 'body is an autoresponder';
  return null;
}

async function classifyReply(lead, replyText, subject) {
  // Decide autoresponders here rather than asking the model. It costs nothing, it cannot be
  // talked out of it, and a wrong answer means drafting a reply to a robot.
  const auto = autoresponderReason(subject, replyText);
  if (auto) return { intent: 'auto_reply', reason: auto, suggested_reply: '' };
  return classifyReplyWithModel(lead, replyText);
}

async function classifyReplyWithModel(lead, replyText) {
  const prompt = `You are Aidan, founder of Aevon, replying to someone who responded to your cold outreach. Aevon builds custom software and AI agents for Lower Mainland BC businesses (1-99 staff) drowning in repetitive manual work. Clients pay once and own it. No subscriptions.

The reply came from this business:
- Name: ${lead.business_name}
- Industry: ${lead.industry || 'unknown'}
${lead.lead_insights ? `- What we believe about their workflow: ${lead.lead_insights}` : ''}
${lead.qualification_notes ? `- Qualification note: ${lead.qualification_notes}` : ''}

Their reply (most recent message only, ignore any quoted history):
"""
${replyText.slice(0, 1500)}
"""

STEP 1 - Classify intent into EXACTLY one of:
- "interested": they want to learn more, ask about pricing/process, want a call, or describe their problems
- "not_interested": they decline, say no thanks, ask to be removed, or unsubscribe
- "referral": they redirect you to another person or department
- "auto_reply": out-of-office, autoresponder, delivery notice, or no human content
- "question": a specific question that needs a human answer but intent is unclear
- "other": anything that does not fit above

STEP 2 - Write a suggested reply (only if intent is interested, question, or referral; otherwise empty string).
Follow this arc:
1. ACKNOWLEDGE their specific struggle. Reflect back the actual pain THEY described (or, if they only asked a question, the pain implied by their industry). Make them feel understood, not pitched.
2. DISCOVERY FIRST (important). If their reply is open-ended or does NOT name a specific problem (e.g. "sure", "tell me more", "let's talk", "what do you do"), DO NOT guess a solution or pitch a specific product. Instead ask ONE concrete question about where their team actually loses time, and offer to build a short demo tailored to whatever they name. Only if they HAVE described a specific pain should you name a concrete thing you'd build for it (realistic and deliverable by a solo builder: an agent that reads inbound inquiries and drafts replies, an intake-to-CRM pipeline, an auto-generated report, a routing/scheduling tool), framed as how it helps THEM.
3. THE OFFER, and it is the strongest thing you have: offer to BUILD THEM A FREE SKELETON. Ask them to name the one process their team does by hand, and say you will build a working skeleton of it, for their business, free, and it is theirs either way. A competitor selling off-the-shelf software cannot answer this, which is exactly why it works. Scope it to ONE process. Never offer to touch their live customer traffic for free.
   SCOPE, and hold this line: the free build must cost Aidan nothing but time. ONE process, sample or historical data they send over, no paid APIs, no paid infrastructure, no licences, no live integration into a system that bills per call, no connection to their production data. If what they describe needs any of that, say plainly that the paid version can and offer to scope it, rather than agreeing to build it free. Never commit to a multi-part product, a full system, or anything with ongoing running costs. If their ask is bigger than one process, narrow it to the single slice worth proving and say so.
4. End with one low-friction next step. Do not stack asks.

Hard rules:
- NEVER claim a prior conversation, relationship or history that is not in the reply above.
  Not "I have been speaking with", not "following up on our chat", not "as discussed", not
  "thanks for your time last week". This has already gone wrong: an out-of-office saying a
  colleague was away produced a draft opening "I have been speaking with Randy", when the
  only contact had been one unanswered cold email. That is a lie in writing to a stranger,
  and it destroys the trust the email exists to build. The ONLY shared history you may refer
  to is the cold email you sent and anything they actually wrote back.
- Write to the person whose address this is going to. If the reply mentions a colleague, do
  NOT address the colleague: you are replying to the sender, not to whoever they named.
- 3-6 sentences, warm and human, first person ("I"). Plain English.
- No buzzwords (leverage, streamline, synergy, unlock, supercharge), no em dashes, no exclamation overload.
- Do NOT overpromise, invent facts about their business, quote a price, or guarantee outcomes/timelines.
- Realistic and good for THEM. If their idea is bigger than is sensible, gently right-size it.
- No sign-off or signature (added separately).

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

// ── Message parsing ───────────────────────────────────────────────

function header(payload, name) {
  const h = (payload.headers || []).find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

function addressOf(headerValue) {
  if (!headerValue) return '';
  const m = headerValue.match(/<([^>]+)>/);
  return (m ? m[1] : headerValue).trim().toLowerCase();
}

// ── Draft creation ────────────────────────────────────────────────

const SIGNATURE = `\n\nAidan\nAevon\nBook a call: https://calendar.app.google/7R7srDKzWrvmLQg37`;

async function buildRawDraft({ to, subject, inReplyTo, references, body }) {
  const replySubject = /^re:/i.test(subject || '') ? subject : `Re: ${subject || ''}`;
  const mail = new MailComposer({
    from: GMAIL_USER,
    to,
    subject: replySubject,
    text: body + SIGNATURE,
    inReplyTo,
    references: [references, inReplyTo].filter(Boolean).join(' '),
  });
  const built = await new Promise((resolve, reject) => {
    mail.compile().build((err, msg) => (err ? reject(err) : resolve(msg)));
  });
  return built.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Main ──────────────────────────────────────────────────────────

async function run() {
  if (!process.env.GMAIL_OAUTH_REFRESH_TOKEN) {
    throw new Error('GMAIL_OAUTH_REFRESH_TOKEN missing. Run: node get-gmail-token.js');
  }

  const gmail = gmailClient();

  // Leads we have actually emailed (have a subject) — the only ones a reply can match.
  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, business_name, email, industry, status, sequence_step, last_sent_at, email_subject, followup_subject, lead_insights, qualification_notes')
    .not('email_subject', 'is', null);
  if (error) throw new Error(`Supabase fetch failed: ${error.message}`);
  const index = buildLeadIndex(leads || []);

  // Already-processed inbound messages, so we never double-handle one.
  const { data: priorEvents } = await supabase
    .from('email_events')
    .select('metadata')
    .eq('event_type', 'replied');
  const processed = new Set(
    (priorEvents || []).map(e => e.metadata?.inbound_message_id).filter(Boolean)
  );

  // List candidate inbound messages.
  const query = `in:inbox newer_than:${LOOKBACK_DAYS}d -from:${GMAIL_USER}`;
  const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 100 });
  const ids = (list.data.messages || []).map(m => m.id);
  console.log(`Found ${ids.length} candidate inbound message(s).\n`);

  let matched = 0, unmatched = 0, skipped = 0, drafted = 0;

  for (const id of ids) {
    const full = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const payload = full.data.payload || {};
    const rfcMessageId = header(payload, 'Message-ID');
    if (!rfcMessageId || processed.has(rfcMessageId)) { skipped++; continue; }

    const fromEmail = addressOf(header(payload, 'From'));
    if (fromEmail === GMAIL_USER.toLowerCase()) { skipped++; continue; }

    const subject = header(payload, 'Subject');
    const { lead, via } = matchLead(index, fromEmail, subject);
    if (!lead) {
      unmatched++;
      console.log(`  [no match] ${fromEmail} — "${subject || ''}"`);
      continue;
    }

    // Get plaintext body via mailparser on the raw message (robust to MIME nesting).
    const raw = await gmail.users.messages.get({ userId: 'me', id, format: 'raw' });
    const parsed = await simpleParser(Buffer.from(raw.data.raw, 'base64'));
    const replyText = parsed.text || (parsed.html ? parsed.html.replace(/<[^>]+>/g, ' ') : '') || full.data.snippet || '';

    const replySubject = header(full.data.payload, 'Subject') || '';
    const { intent, reason, suggested_reply } = await classifyReply(lead, replyText, replySubject);

    const newStatus = statusForIntent(intent);
    if (newStatus) {
      await supabase.from('leads')
        .update({ status: newStatus, scheduled_send_at: null })
        .eq('id', lead.id);
    }

    await supabase.from('email_events').insert({
      lead_id: lead.id,
      event_type: 'replied',
      metadata: {
        source: 'reply-processor',
        inbound_message_id: rfcMessageId,
        matched_via: via,
        intent,
        reason,
        from: fromEmail,
        subject: subject || null,
        suggested_reply: suggested_reply || null,
        days_to_reply: lead.last_sent_at
          ? Math.round((Date.now() - new Date(lead.last_sent_at)) / 86400000)
          : null,
      },
    });

    matched++;
    console.log(`  [${intent}] ${lead.business_name} (via ${via}) — ${reason}`);

    if (suggested_reply && ['interested', 'question', 'referral'].includes(intent)) {
      try {
        const rawDraft = await buildRawDraft({
          to: fromEmail,
          subject,
          inReplyTo: rfcMessageId,
          references: header(payload, 'References'),
          body: suggested_reply,
        });
        await gmail.users.drafts.create({
          userId: 'me',
          requestBody: { message: { raw: rawDraft, threadId: full.data.threadId } },
        });
        drafted++;
        console.log(`      draft saved to Gmail Drafts`);
      } catch (err) {
        console.log(`      (draft failed: ${err.message})`);
      }
    }

    processed.add(rfcMessageId);
  }

  console.log(`\nDone. Matched: ${matched} | Drafts: ${drafted} | Unmatched: ${unmatched} | Skipped: ${skipped}`);
}

module.exports = { autoresponderReason };

// Only run when invoked directly. Requiring this module used to execute a full inbox pass as
// a side effect, so simply importing the autoresponder guard kicked off a live run against 21
// real messages.
if (require.main === module) {
  run().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}
