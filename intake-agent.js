/**
 * intake-agent.js  —  THE ACTUAL PRODUCT (inbound Front Desk agent, MVP)
 *
 * This is the deliverable we sell, not the demo reel. Point it at a business's
 * inbox and it does the real Front Desk job on their INBOUND customer inquiries:
 *   1. reads new inbound messages
 *   2. decides if each is a genuine customer inquiry (vs spam/newsletter/existing thread)
 *   3. qualifies it against the owner's criteria
 *   4. drafts a reply in the owner's voice, offering a booking link when a
 *      call/appointment is warranted
 *   5. leaves the draft in Gmail Drafts for the owner to approve  (NEVER sends)
 *   6. records what it did to a local log (per-client, no shared DB needed)
 *
 * It is config-driven: everything client-specific lives in CONFIG, so deploying
 * for a new client is "swap the config + their Gmail OAuth creds." That is the
 * whole point — it proves "$1,500, live in a week" is real and repeatable.
 *
 * Reuses the proven Gmail-OAuth + Gemini plumbing from reply-processor.js.
 *
 * Required env (the target mailbox's OAuth, from get-gmail-token.js):
 *   GMAIL_USER, GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET, GMAIL_OAUTH_REFRESH_TOKEN
 *   GEMINI_API_KEY
 *
 * Usage:
 *   node intake-agent.js               process new inbound, draft replies
 *   node intake-agent.js --dry         classify + print, but do not touch Gmail Drafts
 *   node intake-agent.js --config tech-neighbour   use a named client config
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { simpleParser } = require('mailparser');
const MailComposer = require('nodemailer/lib/mail-composer');
const { createGenerate } = require('./lib/gemini');

const generate = createGenerate(process.env.GEMINI_API_KEY);
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const configName = (args[args.indexOf('--config') + 1] && args.includes('--config')) ? args[args.indexOf('--config') + 1] : 'default';

// ── Client configs ────────────────────────────────────────────────
// One block per client. This is the entire per-client surface. Everything the
// agent needs to sound like them and qualify like them lives here.
const CONFIGS = {
  // Dogfood target: the user's real residential-IT business. Swap GMAIL creds to
  // techneighbourbc@gmail.com's OAuth to run it live on their actual inquiries.
  'tech-neighbour': {
    businessName: 'Tech Neighbour BC',
    ownerName: 'Aidan',
    whatWeDo: 'residential and small-business IT support in the Lower Mainland: computer and wifi fixes, setup and troubleshooting, virus removal, smart-home and printer help, on-site or remote.',
    serviceArea: 'the Lower Mainland, BC',
    voice: 'friendly, plain-spoken, reassuring, no jargon; talks to non-technical homeowners like a helpful neighbour.',
    qualify: 'A good inquiry is a real person in the Lower Mainland with a specific tech problem or setup need. Out of area, vague spam, sales pitches, and recruiters are NOT qualified.',
    bookingLink: 'https://calendar.app.google/7R7srDKzWrvmLQg37',
    signature: '\n\nAidan\nTech Neighbour BC\ntechneighbourbc@gmail.com',
  },
  // Fallback so the agent is always runnable for a smoke test against any inbox.
  default: {
    businessName: 'the business',
    ownerName: 'the owner',
    whatWeDo: 'its services',
    serviceArea: 'its service area',
    voice: 'warm, clear, professional, human.',
    qualify: 'A good inquiry is a real prospective customer with a specific need the business can serve.',
    bookingLink: '',
    signature: '',
  },
};
const CFG = CONFIGS[configName] || CONFIGS.default;

const GMAIL_USER = process.env.GMAIL_USER;
const LOOKBACK_DAYS = 3;
const LOG_PATH = path.join(__dirname, `intake-log.${configName}.jsonl`);

// ── Gmail ─────────────────────────────────────────────────────────
function gmailClient() {
  const oauth2 = new google.auth.OAuth2(
    process.env.GMAIL_OAUTH_CLIENT_ID,
    process.env.GMAIL_OAUTH_CLIENT_SECRET
  );
  oauth2.setCredentials({ refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: oauth2 });
}
function header(payload, name) {
  const h = (payload.headers || []).find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}
function addressOf(v) {
  if (!v) return '';
  const m = v.match(/<([^>]+)>/);
  return (m ? m[1] : v).trim().toLowerCase();
}
function nameOf(v) {
  if (!v) return '';
  const m = v.match(/^\s*"?([^"<]+?)"?\s*</);
  return (m ? m[1] : '').trim();
}

// ── Dedup log (per client, local file) ────────────────────────────
function loadProcessed() {
  try {
    return new Set(fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n')
      .filter(Boolean).map(l => JSON.parse(l).message_id));
  } catch (e) { return new Set(); }
}
function appendLog(row) {
  fs.appendFileSync(LOG_PATH, JSON.stringify(row) + '\n');
}

// ── The agent's brain ─────────────────────────────────────────────
async function handleInquiry(msg) {
  const prompt = `You are the front desk assistant for ${CFG.businessName}. You handle inbound messages that land in the business's inbox and prepare a reply for ${CFG.ownerName} to approve.

About ${CFG.businessName}: ${CFG.whatWeDo}
Service area: ${CFG.serviceArea}
Voice to write in: ${CFG.voice}
What counts as a qualified inquiry: ${CFG.qualify}

A message just arrived:
From: ${msg.fromName || msg.fromEmail} <${msg.fromEmail}>
Subject: ${msg.subject || '(none)'}
Body (most recent message only, ignore quoted history):
"""
${(msg.body || '').slice(0, 1800)}
"""

STEP 1 - Classify this message as EXACTLY one of:
- "inquiry": a genuine prospective customer with a need the business can serve
- "existing": an ongoing conversation / existing customer / a reply in a thread
- "spam": marketing, sales pitch aimed at the business, recruiter, newsletter, automated notice
- "out_of_scope": a real person but clearly outside the service area or services
- "other": anything else

STEP 2 - Only if intent is "inquiry": qualify it.
- qualified: true if it fits "${CFG.qualify}", else false with a one-line reason.
- Extract: what they need (one line), and whether a call/appointment is the right next step (booking: true/false).

STEP 3 - Only if intent is "inquiry" AND qualified: write a reply draft.
- Address them by first name if you can infer it.
- In the owner's voice (${CFG.voice}). 3-6 sentences, plain English, no buzzwords, no em dashes.
- Acknowledge their specific need, give one genuinely useful line (reassurance or a clarifying question), and move toward the next step.
${CFG.bookingLink ? `- If booking is true, invite them to grab a time and include this exact link on its own line: ${CFG.bookingLink}` : ''}
- Do NOT quote a firm price, invent details, or overpromise. No sign-off (added separately).

Respond with JSON only:
{
  "intent": "...",
  "qualified": true/false,
  "reason": "<one short sentence>",
  "need": "<one line or empty>",
  "booking": true/false,
  "draft": "<reply text, or empty string>"
}`;

  try {
    const raw = await generate(prompt);
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { intent: 'other', qualified: false, reason: 'unparseable', draft: '' };
    return JSON.parse(m[0]);
  } catch (err) {
    return { intent: 'other', qualified: false, reason: `classifier error: ${err.message}`, draft: '' };
  }
}

async function buildRawDraft({ to, subject, inReplyTo, references, body }) {
  const replySubject = /^re:/i.test(subject || '') ? subject : `Re: ${subject || 'your message'}`;
  const mail = new MailComposer({
    from: GMAIL_USER, to, subject: replySubject,
    text: body + CFG.signature,
    inReplyTo,
    references: [references, inReplyTo].filter(Boolean).join(' '),
  });
  const built = await new Promise((res, rej) => mail.compile().build((e, m) => e ? rej(e) : res(m)));
  return built.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Main ──────────────────────────────────────────────────────────
async function run() {
  if (!process.env.GMAIL_OAUTH_REFRESH_TOKEN) {
    throw new Error('GMAIL_OAUTH_REFRESH_TOKEN missing. Run: node get-gmail-token.js');
  }
  console.log(`Intake agent for "${CFG.businessName}" (${configName})${DRY ? ' [DRY RUN]' : ''}\n`);
  const gmail = gmailClient();
  const processed = loadProcessed();

  const query = `in:inbox newer_than:${LOOKBACK_DAYS}d -from:${GMAIL_USER} -in:chats`;
  const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 50 });
  const ids = (list.data.messages || []).map(m => m.id);
  console.log(`Found ${ids.length} candidate inbound message(s).\n`);

  let inquiries = 0, drafted = 0, skipped = 0;

  for (const id of ids) {
    const full = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const payload = full.data.payload || {};
    const rfcId = header(payload, 'Message-ID');
    if (!rfcId || processed.has(rfcId)) { skipped++; continue; }

    const fromHeader = header(payload, 'From');
    const fromEmail = addressOf(fromHeader);
    if (!fromEmail || fromEmail === (GMAIL_USER || '').toLowerCase()) { skipped++; continue; }

    const subject = header(payload, 'Subject');
    const raw = await gmail.users.messages.get({ userId: 'me', id, format: 'raw' });
    const parsed = await simpleParser(Buffer.from(raw.data.raw, 'base64'));
    const body = parsed.text || (parsed.html ? parsed.html.replace(/<[^>]+>/g, ' ') : '') || full.data.snippet || '';

    const msg = { fromEmail, fromName: nameOf(fromHeader), subject, body };
    const res = await handleInquiry(msg);

    const tag = res.intent === 'inquiry' ? (res.qualified ? 'QUALIFIED INQUIRY' : 'inquiry (not qualified)') : res.intent;
    console.log(`  [${tag}] ${msg.fromName || fromEmail} — "${subject || ''}"`);
    if (res.reason) console.log(`      ${res.reason}`);
    if (res.need) console.log(`      needs: ${res.need}${res.booking ? ' (booking warranted)' : ''}`);

    let didDraft = false;
    if (res.intent === 'inquiry' && res.qualified && res.draft && !DRY) {
      try {
        const rawDraft = await buildRawDraft({
          to: fromEmail, subject, inReplyTo: rfcId,
          references: header(payload, 'References'), body: res.draft,
        });
        await gmail.users.drafts.create({
          userId: 'me',
          requestBody: { message: { raw: rawDraft, threadId: full.data.threadId } },
        });
        didDraft = true; drafted++;
        console.log(`      draft saved to Gmail Drafts`);
      } catch (err) {
        console.log(`      (draft failed: ${err.message})`);
      }
    } else if (res.intent === 'inquiry' && res.qualified && DRY) {
      console.log(`      draft (dry):\n${res.draft.split('\n').map(l => '        ' + l).join('\n')}`);
    }
    if (res.intent === 'inquiry') inquiries++;

    appendLog({ message_id: rfcId, from: fromEmail, subject: subject || null,
      intent: res.intent, qualified: !!res.qualified, need: res.need || null,
      booking: !!res.booking, drafted: didDraft, at: new Date().toISOString() });
    processed.add(rfcId);
  }

  console.log(`\nDone. Inquiries: ${inquiries} | Drafts: ${drafted} | Skipped: ${skipped}`);
}

run().catch(err => { console.error('Fatal error:', err.message); process.exit(1); });
