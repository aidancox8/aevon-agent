/**
 * tempo/reply-processor.js
 * Tempo-campaign duplicate of the Aevon reply processor. Reads inbound Gmail
 * replies, matches them against `tempo_leads`, classifies intent with Gemini,
 * updates CRM state, logs to `tempo_email_events`, and drafts a suggested
 * response into Gmail Drafts for review.
 *
 * NOTHING IS EVER SENT AUTOMATICALLY — drafts wait in Gmail for approval.
 *
 * Usage: node tempo/reply-processor.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { google } = require('googleapis');
const { simpleParser } = require('mailparser');
const MailComposer = require('nodemailer/lib/mail-composer');
const supabase = require('../lib/supabase');
const { createGenerate } = require('../lib/gemini');
const { dncReason } = require('./dnc');

const generate = createGenerate(process.env.GEMINI_API_KEY);
const GMAIL_USER = process.env.GMAIL_USER;
const LOOKBACK_DAYS = 14;
const TABLE = 'tempo_leads';
const EVENTS = 'tempo_email_events';

function gmailClient() {
  const oauth2 = new google.auth.OAuth2(
    process.env.GMAIL_OAUTH_CLIENT_ID,
    process.env.GMAIL_OAUTH_CLIENT_SECRET
  );
  oauth2.setCredentials({ refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: oauth2 });
}

function normalizeSubject(s) {
  return (s || '').replace(/^(\s*(re|fwd|fw)\s*:\s*)+/i, '').trim().toLowerCase();
}
function domainOf(email) {
  const m = (email || '').toLowerCase().match(/@([^@\s>]+)/);
  return m ? m[1] : null;
}

function buildLeadIndex(leads) {
  const byEmail = new Map();
  const byDomain = new Map();
  const bySubject = new Map();
  for (const l of leads) {
    if (l.email) byEmail.set(l.email.toLowerCase(), l);
    const d = domainOf(l.email);
    if (d) {
      if (byDomain.has(d)) byDomain.set(d, null); // ambiguous
      else byDomain.set(d, l);
    }
    for (const subj of [l.email_subject, l.followup_subject, l.followup2_subject]) {
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

async function classifyReply(lead, replyText) {
  const allied = /physio|rehab|sport|kinesio|occupational|chiro|massage|multidiscip|integrated|wellness|naturopath|concussion/i.test(lead.industry || '');
  const contract = allied
    ? 'Tempo schedules the TEAM at allied clinics: weekly practitioner + room schedule, front desk and support staff scheduling (which Jane does not cover), SMS shift reminders + one-tap sick-call cover, payroll-synced time off + hours export, and room utilization analytics. It runs ALONGSIDE Jane, never replacing it. It is NOT patient booking, NOT an EMR, and there is NO Jane integration.'
    : 'Tempo schedules STAFF and ROOMS for medical groups: weekly staff + room schedule, SMS/email shift and on-call reminders, shift and on-call cover, payroll-synced time off, and utilization analytics. It is NOT patient booking, an EMR, or billing.';

  const prompt = `You are Aidan, founder of Aevon, replying to a clinic that responded to your cold outreach about Tempo, Aevon's custom staff and room scheduling app for multi-provider clinics.

CAPABILITY CONTRACT (never claim anything beyond this): ${contract}

The reply came from this clinic:
- Name: ${lead.business_name}
- Type: ${lead.industry || 'unknown'}
${lead.lead_insights ? `- What we believe about them: ${lead.lead_insights}` : ''}
${lead.qualification_notes ? `- Qualification note: ${lead.qualification_notes}` : ''}

Their reply (most recent message only, ignore quoted history):
"""
${replyText.slice(0, 1500)}
"""

STEP 1 - Classify intent into EXACTLY one of:
- "interested": they want to learn more, ask about pricing/process, want a call, or describe their scheduling headaches
- "not_interested": they decline, say no thanks, ask to be removed, or unsubscribe
- "referral": they redirect you to another person (e.g. the clinic manager or owner)
- "auto_reply": out-of-office, autoresponder, delivery notice, or no human content
- "question": a specific question that needs a human answer but intent is unclear
- "other": anything that does not fit above

STEP 2 - Write a suggested reply (only if intent is interested, question, or referral; otherwise empty string).
1. Acknowledge what THEY said about how their clinic runs. Reflect their actual words, don't pitch.
2. If they named a specific pain (sick calls, front desk coverage, spreadsheets, multiple locations), say concretely how Tempo handles that ONE thing per the contract. If their reply is open-ended, ask ONE concrete question about how they build their staff schedule today, and offer the live demo (allied clinics: allied-scheduler-demo.web.app; medical groups: clinic-scheduler-demo.web.app) as a zero-commitment look.
3. End with one low-friction next step. Never stack asks. Never quote a price.

Hard rules:
- 3-6 sentences, warm and human, first person. Plain English, no buzzwords, no em dashes.
- Never invent facts about their clinic, never promise timelines, never claim a Jane integration.
- No sign-off (added separately).

Respond with JSON only:
{ "intent": "...", "reason": "<one short sentence>", "suggested_reply": "..." }`;

  try {
    const raw = await generate(prompt);
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { intent: 'other', reason: 'Could not parse classification', suggested_reply: '' };
    return JSON.parse(m[0]);
  } catch (err) {
    return { intent: 'other', reason: `Classifier error: ${err.message}`, suggested_reply: '' };
  }
}

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

function header(payload, name) {
  const h = (payload.headers || []).find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}
function addressOf(headerValue) {
  if (!headerValue) return '';
  const m = headerValue.match(/<([^>]+)>/);
  return (m ? m[1] : headerValue).trim().toLowerCase();
}

const SIGNATURE = `\n\nAidan Cox\nAevon · aevon.ca/tempo\nBook a call: https://calendar.app.google/7R7srDKzWrvmLQg37`;

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

async function run() {
  if (!process.env.GMAIL_OAUTH_REFRESH_TOKEN) {
    throw new Error('GMAIL_OAUTH_REFRESH_TOKEN missing. Run: node get-gmail-token.js');
  }
  const gmail = gmailClient();

  const { data: leads, error } = await supabase
    .from(TABLE)
    .select('id, business_name, email, industry, status, sequence_step, last_sent_at, email_subject, followup_subject, followup2_subject, lead_insights, qualification_notes')
    .not('email_subject', 'is', null);
  if (error) throw new Error(`Supabase fetch failed: ${error.message}`);
  const index = buildLeadIndex(leads || []);

  const { data: priorEvents } = await supabase
    .from(EVENTS)
    .select('metadata')
    .eq('event_type', 'replied');
  const processed = new Set((priorEvents || []).map(e => e.metadata?.inbound_message_id).filter(Boolean));

  const query = `in:inbox newer_than:${LOOKBACK_DAYS}d -from:${GMAIL_USER}`;
  const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 100 });
  const ids = (list.data.messages || []).map(m => m.id);
  console.log(`[Tempo] Found ${ids.length} candidate inbound message(s).\n`);

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
    if (!lead) { unmatched++; continue; } // Aevon replies are handled by the Aevon processor

    const raw = await gmail.users.messages.get({ userId: 'me', id, format: 'raw' });
    const parsed = await simpleParser(Buffer.from(raw.data.raw, 'base64'));
    const replyText = parsed.text || (parsed.html ? parsed.html.replace(/<[^>]+>/g, ' ') : '') || full.data.snippet || '';

    const { intent, reason, suggested_reply } = await classifyReply(lead, replyText);

    const newStatus = statusForIntent(intent);
    if (newStatus) {
      await supabase.from(TABLE).update({ status: newStatus, scheduled_send_at: null }).eq('id', lead.id);
    }

    // If the human replying is a Changepain person, flag it loudly in the log.
    const dncFlag = dncReason(parsed.from?.value?.[0]?.name || null, fromEmail);

    await supabase.from(EVENTS).insert({
      lead_id: lead.id,
      event_type: 'replied',
      metadata: {
        source: 'tempo-reply-processor',
        inbound_message_id: rfcMessageId,
        matched_via: via,
        intent,
        reason,
        from: fromEmail,
        subject: subject || null,
        suggested_reply: suggested_reply || null,
        dnc_flag: dncFlag || null,
        days_to_reply: lead.last_sent_at ? Math.round((Date.now() - new Date(lead.last_sent_at)) / 86400000) : null,
      },
    });

    matched++;
    console.log(`  [${intent}] ${lead.business_name} (via ${via}) — ${reason}${dncFlag ? ' | ⚠ ' + dncFlag : ''}`);

    // Never auto-draft a reply to a do-not-contact person — surface it for Aidan instead.
    if (!dncFlag && suggested_reply && ['interested', 'question', 'referral'].includes(intent)) {
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

  console.log(`\nDone. Matched: ${matched} | Drafts: ${drafted} | Unmatched (left to Aevon processor): ${unmatched} | Skipped: ${skipped}`);
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
