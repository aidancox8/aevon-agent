/**
 * intake-agent.js  —  the Front Desk intake build (MVP)
 *
 * RETIRED as the lead offer 2026-08-03, not deleted. The code works and can still be sold
 * to anyone who asks for exactly this, it is simply no longer what outreach pitches. See
 * sales/front-desk-offer.md for why.
 *
 * This is the deliverable we sell, not the demo reel. Point it at a business's
 * inbox and it does the real Front Desk job on their INBOUND customer inquiries:
 *   1. reads new inbound messages
 *   2. decides if each is a genuine customer inquiry (vs spam/newsletter/existing thread)
 *   3. qualifies it against the owner's criteria
 *   4. drafts a reply in the owner's voice, offering a booking link when a
 *      call/appointment is warranted
 *   5. leaves the draft in Gmail Drafts for the owner to approve
 *   6. records what it did to a local log (per-client, no shared DB needed)
 *
 * AUTONOMY. Step 5 is a dial, not a fixed behaviour, because that is what the offer
 * promises: everything sits in drafts for the owner's approval at first, and once they
 * trust how it sounds they let the first reply go out on its own. Drafting is the
 * DEFAULT and auto-send is off unless a client config opts in AND the environment is
 * armed. See canAutoSend() for every condition and why each one is there.
 *
 * AEVON'S OWN MAILBOX CAN NEVER AUTO-SEND. CLAUDE.md rule 1 in this repo is that no
 * email is ever sent to a lead or prospect without Aidan's approval. That rule governs
 * Aevon's outreach; this toggle exists for CLIENT deployments, where the client is the
 * approver of their own replies to their own customers. To keep the two from ever being
 * confused, an aevon.ca sending address is refused in code, not by remembering.
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
 *   node intake-agent.js --drafts-only force drafting even for an auto-send client
 *   node intake-agent.js --autonomy    print the resolved autonomy decision and exit
 *   node intake-agent.js --sample      run the config's canned examples, no mailbox needed
 *   node intake-agent.js --try         run ONE message pasted on stdin, no mailbox needed
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
const DRAFTS_ONLY = args.includes('--drafts-only');
const EXPLAIN_ONLY = args.includes('--autonomy');
const SAMPLE = args.includes('--sample');
/**
 * `--try` runs ONE message the operator supplies, rather than the canned samples.
 *
 * The canned samples are messages we wrote, which makes them worth exactly nothing as
 * evidence to a prospect: of course it handles the examples we invented. `--try` takes a real
 * inquiry, pasted on stdin, so a prospect can hand over something from their own inbox and
 * watch it work on that. Same classifier, same drafting, still no mailbox and nothing written.
 *
 *   pbpaste | node intake-agent.js --config skyline --try
 *   node intake-agent.js --config skyline --try --from "Jane Doe <j@x.com>" --subject "3bd?"
 *   (then paste, and press Enter twice)
 */
const TRY = args.includes('--try');
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};

function readStdin() {
  // Interactive: a BLANK LINE ends the message. Ctrl+D is the Unix EOF and Ctrl+Z Enter is the
  // Windows one, and neither is something to explain on a sales call. Piped input still works
  // and still ends at EOF.
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    if (process.stdin.isTTY) {
      console.log('Paste the inquiry, then press Enter twice (an empty line ends it):\n');
      process.stdin.on('data', (c) => {
        buf += c;
        if (/\r?\n\s*\r?\n$/.test(buf) && buf.trim()) { process.stdin.pause(); resolve(buf.trim()); }
      });
    } else {
      process.stdin.on('data', (c) => { buf += c; });
    }
    process.stdin.on('end', () => resolve(buf.trim()));
  });
}
const configName = (args[args.indexOf('--config') + 1] && args.includes('--config')) ? args[args.indexOf('--config') + 1] : 'default';

// ── Client configs ────────────────────────────────────────────────
// One block per client. This is the entire per-client surface. Everything the
// agent needs to sound like them and qualify like them lives here.
//
// Autonomy fields, both optional and both safe when absent:
//   autoSend          false (default) = always draft. true = eligible to send, but
//                     still subject to every check in canAutoSend().
//   autoSendDailyCap  hard ceiling on sends per calendar day for this client. A
//                     client that opts in without naming one gets AUTOSEND_CAP_FALLBACK,
//                     because "unlimited" is never the right answer for a loop that
//                     emails strangers on someone else's behalf.
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
    // Its own mailbox + OAuth token (from get-gmail-token.js run while logged
    // into this account), so it never touches Aevon's inbox.
    gmailUser: process.env.TN_GMAIL_USER || 'techneighbourbc@gmail.com',
    refreshTokenEnv: 'TN_GMAIL_OAUTH_REFRESH_TOKEN',
    // Aidan's own business. Left on drafts deliberately: this is the dogfood
    // mailbox, and it is the one place we get to read every reply before it goes
    // out and judge whether the voice is good enough to trust unattended.
    autoSend: false,
  },
  /**
   * PROVISIONAL. Written 2026-09-01 for the Thursday call, from what Sofia has actually said
   * in the thread and nothing else. She has NOT confirmed any of the qualification criteria,
   * her voice, or where the handoff lands, so treat every field here as a starting draft to
   * be corrected live on the call rather than as a spec.
   *
   * What is known, in her words: leads come from Facebook and Google ads into landing pages,
   * into a CRM, where an ISA calls them until they reach someone and then forwards them to
   * her. She lives near JBLM. She lost her Zillow territory when they moved to Flex.
   *
   * WHERE THIS AGENT SITS. On HER side of the ISA handoff, not in front of it. The ISA does
   * the calling; this answers the ones already forwarded to her while she is out showing
   * houses. That is the only part of her funnel nothing currently covers, and it is the only
   * part that is a Gmail inbox, which is what this build reads. Everything upstream is CRM
   * and telephony and is a separate scope.
   *
   * Not wired to a mailbox: there is no token for her account and there will not be one
   * unless she buys. `--config skyline --dry` runs the classifier and prints what it would
   * write, which is the honest thing to demo.
   */
  skyline: {
    businessName: 'Skyline Properties',
    ownerName: 'Sofia',
    whatWeDo: 'residential real estate brokerage in the South Puget Sound, working with military families relocating to and from Joint Base Lewis-McChord, including VA-financed purchases and PCS-timed sales.',
    serviceArea: 'the South Puget Sound area of Washington, within reach of JBLM',
    voice: 'warm, direct and brief; writes like a busy broker on her phone between showings, plain sentences, no real estate jargon, no exclamation marks.',
    qualify: 'A good inquiry is someone buying or selling a home in the South Puget Sound area, most often a service member or spouse with PCS orders to or from JBLM. Vendors, lead-generation pitches, recruiters, other agents prospecting for referrals, and anyone outside Washington are NOT qualified.',
    // The point of a build over an off-the-shelf tool. A general assistant asks "what is your
    // budget and timeline"; it does not know that a report date is the deadline everything
    // else hangs off, or that a missing COE is what stalls a VA closing.
    askFor: [
      'report date, or the month they need to be in',
      'whether orders are in hand or still pending',
      'VA or conventional, and if VA whether they have their Certificate of Eligibility',
      'price range',
      'on-base or off-base, and how far from the gate they will drive',
      'whether they have a house to sell at the current duty station',
    ],
    bookingLink: '',
    signature: '\n\nSofia Epps\nR.E. Broker, Skyline Properties',
    // Runnable with --sample, so the classifier can be demonstrated on a call without a
    // token, a mailbox, or anyone's real mail. Written to cover the three shapes that
    // actually arrive: a strong PCS buyer, someone who does not know what a VA loan is,
    // and a lead with nothing in it worth chasing yet.
    samples: [
      { fromName: 'Marcus Ellison', fromEmail: 'm.ellison84@gmail.com',
        subject: 'PCSing to JBLM in November',
        body: 'Hi, just got my orders today. Reporting to Lewis-McChord November 3rd, coming from Fort Campbell. My wife and I want to buy rather than rent this time. Planning to use my VA loan, first time using it. Looking off-base, ideally under 30 minutes from the gate, three bedrooms if we can get it. We fly out for a house hunting trip the second week of October. Are you available then?' },
      { fromName: 'Danielle Ruiz', fromEmail: 'dani.ruiz.pnw@gmail.com',
        subject: 'Question about VA loans',
        body: 'Hello, my husband is being stationed at Lewis-McChord in January and we are starting to look. Everyone tells us to use the VA loan but honestly I do not understand it. Do we need money down? What is the certificate everyone keeps mentioning? We have never bought before. Thank you, Danielle' },
      { fromName: 'tyler', fromEmail: 'tyler.mcgrath22@gmail.com',
        subject: 'housing',
        body: 'hey whats housing like around base, how much am i looking at' },
      { fromName: 'Krista at LeadFlow', fromEmail: 'krista@leadflowpro.io',
        subject: 'Exclusive buyer leads in your ZIP',
        body: 'Hi Sofia, I work with top producing agents in Pierce County and we have exclusive buyer leads available in your area. Do you have 15 minutes this week to discuss how we can fill your pipeline? Happy to send over our pricing sheet.' },
    ],
    gmailUser: process.env.SKYLINE_GMAIL_USER || 'sofia.epps@example.invalid',
    refreshTokenEnv: 'SKYLINE_GMAIL_OAUTH_REFRESH_TOKEN',
    // Drafts only, and it stays that way through the trial no matter what the offer says.
    // She has not seen a single reply in her own voice yet, so there is nothing to trust.
    autoSend: false,
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
    gmailUser: process.env.GMAIL_USER,
    refreshTokenEnv: 'GMAIL_OAUTH_REFRESH_TOKEN',
    autoSend: false,
  },
};
const CFG = CONFIGS[configName] || CONFIGS.default;

const GMAIL_USER = CFG.gmailUser;
const REFRESH_TOKEN = process.env[CFG.refreshTokenEnv];
const LOOKBACK_DAYS = 3;
const LOG_PATH = path.join(__dirname, `intake-log.${configName}.jsonl`);

// ── Autonomy ──────────────────────────────────────────────────────
// Sending mail unattended on someone else's behalf is the one thing in this file
// that cannot be undone, so every condition below fails CLOSED: anything unknown,
// unparseable or unset results in a draft, never a send.

// A client who opts in without naming a cap still gets one.
const AUTOSEND_CAP_FALLBACK = 20;

// Mailboxes that may never auto-send regardless of config, because they are ours
// and CLAUDE.md rule 1 governs them. This is a structural block, not a reminder.
const PROTECTED_SENDER_PATTERNS = [/@aevon\.ca$/i, /^aidan@/i];

// Addresses no reply should ever be fired at unattended. A human reading a draft
// would spot these instantly; an unattended loop would not.
const AUTOMATED_SENDER_PATTERNS = [
  /^(no-?reply|do-?not-?reply|donotreply)@/i,
  /^(mailer-daemon|postmaster|bounce|bounces|abuse)@/i,
  /^(notification|notifications|alerts?|updates?|news|newsletter)@/i,
  /^(support|billing|receipts?|invoices?)@/i,
];

// A generated reply that trips any of these is not fit to leave unread.
const UNSAFE_DRAFT_PATTERNS = [
  /\[[^\]]{2,}\]/,           // unfilled placeholder like [Name] or [your area]
  /\{\{[\s\S]*?\}\}/,        // unrendered template token
  /\bas an ai\b/i,           // the model talking about itself
  /\bI (?:cannot|can't|am unable to)\b/i,
  /\bTODO\b/,
  /\bLorem ipsum\b/i,
];

const ARMED = String(process.env.INTAKE_AUTOSEND_ARMED || '').toLowerCase() === 'true';

function isProtectedSender(addr) {
  return PROTECTED_SENDER_PATTERNS.some((re) => re.test(String(addr || '')));
}
function isAutomatedRecipient(addr) {
  return AUTOMATED_SENDER_PATTERNS.some((re) => re.test(String(addr || '')));
}
function draftIsSafeToSend(text) {
  const t = String(text || '').trim();
  if (t.length < 40) return { ok: false, why: 'reply is too short to be a real answer' };
  if (t.length > 4000) return { ok: false, why: 'reply is implausibly long' };
  const bad = UNSAFE_DRAFT_PATTERNS.find((re) => re.test(t));
  if (bad) return { ok: false, why: `reply matched an unsafe pattern (${bad})` };
  return { ok: true };
}

/**
 * How many auto-sends this config has already made today, read back from the log
 * rather than held in memory, so the cap survives restarts and hourly cron runs.
 * An unreadable or corrupt log counts as "cap already reached", not as zero.
 */
function autoSentToday() {
  let lines;
  try {
    lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').filter(Boolean);
  } catch (e) {
    return e.code === 'ENOENT' ? { count: 0, recipients: new Set() } : null;
  }
  const today = new Date().toDateString();
  const recipients = new Set();
  let count = 0;
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch (e) { return null; }
    if (!row.sent || !row.at) continue;
    const when = new Date(row.at);
    if (isNaN(when) || when.toDateString() !== today) continue;
    count += 1;
    if (row.from) recipients.add(String(row.from).toLowerCase());
  }
  return { count, recipients };
}

/**
 * The single decision point. Returns { send: bool, why: string } and is the ONLY
 * thing the main loop consults. Every caller-visible reason is a printable string
 * so a run always says out loud why it drafted instead of sent.
 */
function autonomy() {
  if (DRY) return { send: false, why: 'dry run' };
  if (DRAFTS_ONLY) return { send: false, why: '--drafts-only was passed' };
  if (CFG.autoSend !== true) return { send: false, why: `config "${configName}" has autoSend off` };
  if (isProtectedSender(GMAIL_USER)) {
    return { send: false, why: `${GMAIL_USER} is an Aevon mailbox and may never auto-send (CLAUDE.md rule 1)` };
  }
  if (!ARMED) return { send: false, why: 'INTAKE_AUTOSEND_ARMED is not "true" in the environment' };
  const cap = Number.isFinite(CFG.autoSendDailyCap) ? CFG.autoSendDailyCap : AUTOSEND_CAP_FALLBACK;
  if (!(cap > 0)) return { send: false, why: 'daily cap is not a positive number' };
  return { send: true, why: `armed, cap ${cap}/day`, cap };
}

async function sendReply(gmail, { raw, threadId }) {
  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, threadId },
  });
  return res.data.id;
}

// ── Gmail ─────────────────────────────────────────────────────────
function gmailClient() {
  const oauth2 = new google.auth.OAuth2(
    process.env.GMAIL_OAUTH_CLIENT_ID,
    process.env.GMAIL_OAUTH_CLIENT_SECRET
  );
  oauth2.setCredentials({ refresh_token: REFRESH_TOKEN });
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
${(CFG.askFor && CFG.askFor.length) ? `- These are the facts ${CFG.ownerName} needs before this lead is workable:
${CFG.askFor.map((q) => `    - ${q}`).join('\n')}
  For each one, decide from the message whether it is already ANSWERED or still MISSING. Put the
  answered ones in "known" as short "label: value" strings, and list the missing ones in "missing".
  Never guess a value that is not in the message, and never ask about something already answered.` : ''}

STEP 3 - Only if intent is "inquiry" AND qualified: write a reply draft.
- Address them by first name if you can infer it.
- In the owner's voice (${CFG.voice}). 3-6 sentences, plain English, no buzzwords, no em dashes.
- Acknowledge their specific need, give one genuinely useful line (reassurance or a clarifying question), and move toward the next step.
${(CFG.askFor && CFG.askFor.length) ? `- Ask for AT MOST TWO of the missing facts, the two that matter most for this particular message. A reply that asks for six things reads like a form and gets ignored. The rest can be asked later.` : ''}
${CFG.bookingLink ? `- If booking is true, invite them to grab a time and include this exact link on its own line: ${CFG.bookingLink}` : ''}
- Do NOT quote a firm price, invent details, or overpromise. No sign-off (added separately).

Respond with JSON only:
{
  "intent": "...",
  "qualified": true/false,
  "reason": "<one short sentence>",
  "need": "<one line or empty>",
  "booking": true/false,${(CFG.askFor && CFG.askFor.length) ? `
  "known": ["<label: value>", ...],
  "missing": ["<the fact still needed>", ...],` : ''}
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
  const mode = autonomy();

  // `--autonomy` answers "what would this run do, and why" without touching a mailbox.
  // Worth having: the answer depends on a config field, an env var and the sending
  // address at once, and guessing which one is off is how accidents happen.
  if (EXPLAIN_ONLY) {
    console.log(`config      : ${configName} ("${CFG.businessName}")`);
    console.log(`mailbox     : ${GMAIL_USER || '(unset)'}`);
    console.log(`autoSend    : ${CFG.autoSend === true}`);
    console.log(`armed       : ${ARMED}`);
    console.log(`decision    : ${mode.send ? 'SEND replies automatically' : 'DRAFT only'}`);
    console.log(`because     : ${mode.why}`);
    return;
  }

  // `--sample` runs the classifier against the config's own example messages. No mailbox, no
  // OAuth token, nothing written anywhere. It exists so the agent can be shown working on a
  // call before a prospect has granted access to anything, which is the only order that makes
  // sense: nobody hands over their inbox to see whether the thing is any good.
  if (SAMPLE || TRY) {
    let messages;
    if (TRY) {
      const body = await readStdin();
      if (!body) throw new Error('Nothing on stdin. Pipe a message in, or paste and press Ctrl+D.');
      const raw = flag('from') || 'A prospect <prospect@example.com>';
      messages = [{
        fromName: nameOf(raw) || raw.replace(/<.*>/, '').trim() || 'A prospect',
        fromEmail: addressOf(raw),
        subject: flag('subject') || '(no subject)',
        body,
      }];
      console.log(`\nOne live message through "${CFG.businessName}" (${configName}). Nothing is read or written.\n`);
    } else {
      messages = CFG.samples || [];
      if (!messages.length) throw new Error(`config "${configName}" has no samples to run. Add a samples: [] block.`);
      console.log(`Sample run for "${CFG.businessName}" (${configName}). Nothing is read or written.\n`);
    }
    for (const msg of messages) {
      const res = await handleInquiry(msg);
      const tag = res.intent === 'inquiry' ? (res.qualified ? 'QUALIFIED INQUIRY' : 'inquiry (not qualified)') : res.intent;
      console.log(`── ${msg.fromName} <${msg.fromEmail}>  "${msg.subject}"`);
      console.log(`   [${tag}]${res.reason ? '  ' + res.reason : ''}`);
      if (res.need) console.log(`   needs: ${res.need}${res.booking ? '  (booking warranted)' : ''}`);
      if (res.known && res.known.length) console.log(`   known: ${res.known.join(' | ')}`);
      if (res.missing && res.missing.length) console.log(`   still needed: ${res.missing.join(' | ')}`);
      if (res.draft) console.log('\n' + res.draft.split('\n').map((l) => '     ' + l).join('\n'));
      console.log();
    }
    return;
  }

  if (!REFRESH_TOKEN) {
    throw new Error(`${CFG.refreshTokenEnv} missing in .env. Authorize this mailbox: log into ${GMAIL_USER}, run get-gmail-token.js, and put the printed token in ${CFG.refreshTokenEnv}.`);
  }
  console.log(`Intake agent for "${CFG.businessName}" (${configName})${DRY ? ' [DRY RUN]' : ''}`);
  console.log(mode.send ? `Autonomy: SENDING automatically (${mode.why})\n` : `Autonomy: drafts only (${mode.why})\n`);

  // Read the day's send history once, up front. A null here means the log could not
  // be trusted, and an untrustworthy cap is treated as an exhausted one.
  let budget = mode.send ? autoSentToday() : { count: 0, recipients: new Set() };
  if (mode.send && !budget) {
    console.log('Could not read the send log, so this run will draft instead of send.\n');
    mode.send = false;
    budget = { count: 0, recipients: new Set() };
  }

  const gmail = gmailClient();
  const processed = loadProcessed();

  const query = `in:inbox newer_than:${LOOKBACK_DAYS}d -from:${GMAIL_USER} -in:chats`;
  const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 50 });
  const ids = (list.data.messages || []).map(m => m.id);
  console.log(`Found ${ids.length} candidate inbound message(s).\n`);

  let inquiries = 0, drafted = 0, sent = 0, skipped = 0;

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
    // The qualification is the part worth watching on a demo: it shows the agent reading
    // THEIR criteria out of a real message rather than writing a generic pleasantry.
    if (res.known && res.known.length) console.log(`      known: ${res.known.join(' | ')}`);
    if (res.missing && res.missing.length) console.log(`      still needed: ${res.missing.join(' | ')}`);

    let didDraft = false, didSend = false, heldBecause = null;
    if (res.intent === 'inquiry' && res.qualified && res.draft && !DRY) {
      let rawReply = null;
      try {
        rawReply = await buildRawDraft({
          to: fromEmail, subject, inReplyTo: rfcId,
          references: header(payload, 'References'), body: res.draft,
        });
      } catch (err) {
        console.log(`      (could not compose a reply: ${err.message})`);
      }

      // Per-message checks, applied only when the run is allowed to send at all.
      // Each one demotes this message to a draft rather than aborting the run, so a
      // single odd inquiry never stops the rest from being handled.
      let sendThis = mode.send && !!rawReply;
      if (sendThis) {
        const safety = draftIsSafeToSend(res.draft);
        if (!safety.ok) { sendThis = false; heldBecause = safety.why; }
        else if (isAutomatedRecipient(fromEmail)) { sendThis = false; heldBecause = 'recipient looks like an automated address'; }
        else if (budget.recipients.has(fromEmail)) { sendThis = false; heldBecause = 'already auto-replied to this address today'; }
        else if (budget.count >= mode.cap) { sendThis = false; heldBecause = `daily cap of ${mode.cap} reached`; }
      }

      if (sendThis) {
        try {
          await sendReply(gmail, { raw: rawReply, threadId: full.data.threadId });
          didSend = true; sent++;
          budget.count += 1;
          budget.recipients.add(fromEmail);
          console.log(`      reply SENT (${budget.count}/${mode.cap} today)`);
        } catch (err) {
          // A failed send must never silently drop the reply. Fall through to a draft.
          heldBecause = `send failed: ${err.message}`;
        }
      }

      if (!didSend && rawReply) {
        try {
          await gmail.users.drafts.create({
            userId: 'me',
            requestBody: { message: { raw: rawReply, threadId: full.data.threadId } },
          });
          didDraft = true; drafted++;
          console.log(`      draft saved to Gmail Drafts${heldBecause ? `  [held: ${heldBecause}]` : ''}`);
        } catch (err) {
          console.log(`      (draft failed: ${err.message})`);
        }
      }
    } else if (res.intent === 'inquiry' && res.qualified && DRY) {
      console.log(`      draft (dry):\n${res.draft.split('\n').map(l => '        ' + l).join('\n')}`);
    }
    if (res.intent === 'inquiry') inquiries++;

    appendLog({ message_id: rfcId, from: fromEmail, subject: subject || null,
      intent: res.intent, qualified: !!res.qualified, need: res.need || null,
      booking: !!res.booking, known: res.known || null, missing: res.missing || null,
      drafted: didDraft, sent: didSend,
      held: heldBecause, at: new Date().toISOString() });
    processed.add(rfcId);
  }

  console.log(`\nDone. Inquiries: ${inquiries} | Sent: ${sent} | Drafts: ${drafted} | Skipped: ${skipped}`);
}

// Only run when invoked directly, so check-intake-autonomy.js can require the safety
// helpers and assert on them without opening a mailbox.
if (require.main === module) {
  run().catch(err => { console.error('Fatal error:', err.message); process.exit(1); });
}

module.exports = {
  autonomy,
  draftIsSafeToSend,
  isProtectedSender,
  isAutomatedRecipient,
  AUTOSEND_CAP_FALLBACK,
};
