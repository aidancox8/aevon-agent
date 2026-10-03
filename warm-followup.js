#!/usr/bin/env node
/**
 * warm-followup.js — drafted (NEVER sent) follow-up touches for warm prospects.
 *
 * The gap this closes: the only intent this business has ever seen arrived ad hoc and was
 * handled ad hoc. Jean's drafts waited on a human to hit send. Vickers watched the demo
 * twice, declined, and there was no follow-up on record. Sofia missed her demo, got three
 * follow-ups, and went quiet. Warmth without a system behind it cools at exactly the rate
 * you would expect.
 *
 * What counts as warm (a human showed intent, not a bot):
 *   - a reply classified interested / question / referral
 *   - an "I'm interested" button click
 *   - 2+ genuine site visits (bot-filtered: same rules as signals-digest.js)
 *   - a manual entry in warm-manual.json (Jean, Vickers, Sofia and their known state)
 *
 * What does NOT count: raw visit counts (90 of 114 "warm visitors" were mail scanners),
 * DMARC/TLS reports, ticket bots, auto-replies. The signal query applies the bot rules
 * before anything else, because acting on scanner traffic is how the old numbers lied.
 *
 * Stages, tracked as email_events/cadre_email_events rows with event_type='warm_touch'
 * and metadata.stage. No schema change needed.
 *   stage 1 (1-3 days after the signal, thread quiet): acknowledge the signal, one question
 *   stage 2 (6-8 days after stage 1): one concrete thing the first note did not say
 *   stage 3 (13-15 days after stage 2): the breakup. Plain close-out, easy exit.
 * After stage 3 the lead is marked warm_closed and this script never touches it again.
 * Email has done all it can at that point; the report lists warm_closed leads as
 * "needs a human move" (call, LinkedIn, referral path).
 *
 * Guards:
 *   - drafts only. Nothing here sends. Ever.
 *   - skips dont_contact / unsubscribed / bounced / converted
 *   - skips when a 'replied' event is newer than the last warm touch (the thread is alive;
 *     reply-processor owns it)
 *   - idempotent: a logged warm_touch for a stage is never re-drafted
 *   - every draft runs through the proactive gate (handled-personally list, employer
 *     exclusion, forbidden claims). A failed gate is logged LOUDLY and the draft is not
 *     created. canSendReply is not used: it permits only replies inside a thread a human
 *     started, and these drafts start the touch.
 *
 *   node warm-followup.js --dry
 *   node warm-followup.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const MailComposer = require('nodemailer/lib/mail-composer');
const supabase = require('./lib/supabase');
// canSendReply is deliberately NOT used here: it permits exactly one thing, replying inside
// a thread a human started, and fails everything else. Warm follow-ups are proactive drafts,
// so they get the same safety rules (handled-personally list, employer exclusion, forbidden
// claims) without the reply-only restriction.
const { HANDLED_PERSONALLY, FORBIDDEN } = require('./lib/send-gate');
const { excludedOrgReason } = require('./tempo/dnc');

const DRY = process.argv.includes('--dry');
const GMAIL_USER = process.env.GMAIL_USER;
const MANUAL_FILE = path.join(__dirname, 'warm-manual.json');

const DAY = 86400000;
const STATS = { leads: 0, events: 0, signals: 0 };
const STAGE_DELAY = { 1: 1 * DAY, 2: 6 * DAY, 3: 13 * DAY }; // days after previous touch
const SKIP_STATUS = new Set(['dont_contact', 'unsubscribed', 'bounced', 'converted']);
const GOOD_INTENT = new Set(['interested', 'question', 'referral']);

// ── bot rules, same as signals-digest.js ───────────────────────────
function isBotUa(ua) {
  const u = (ua || '').toLowerCase();
  if (!u) return true;
  if (/x11;\s*linux|headless|bot|crawler|spider|python-requests|curl|wget|preview|scanner/.test(u)) return true;
  const m = u.match(/chrome\/(\d+)/);
  if (m && parseInt(m[1], 10) < 130) return true;
  return false;
}

function gmailClient() {
  const oauth2 = new google.auth.OAuth2(
    process.env.GMAIL_OAUTH_CLIENT_ID, process.env.GMAIL_OAUTH_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: oauth2 });
}

async function buildRawDraft({ to, subject, body, inReplyTo }) {
  const mail = new MailComposer({
    from: GMAIL_USER, to, subject,
    text: body + '\n\nBest,\nAidan Cox\naevon.ca',
    ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}),
  });
  const built = await new Promise((resolve, reject) =>
    mail.compile().build((err, msg) => (err ? reject(err) : resolve(msg))));
  return built.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Proactive-draft gate: the safety rules from lib/send-gate minus the reply-only
 *  restriction (these drafts start the touch, they do not answer one). Returns a reason
 *  string when blocked, null when the draft may be created. */
function draftGate({ to, businessName, body }) {
  const email = String(to || '').toLowerCase().trim();
  if (!email) return 'no recipient address';
  if (HANDLED_PERSONALLY.includes(email)) return 'recipient is handled personally';
  const org = excludedOrgReason(businessName, email);
  if (org) return org;
  for (const f of FORBIDDEN) {
    if (f.re.test(body)) return `draft ${f.why}`;
  }
  return null;
}

function firstName(contactName) {
  return (contactName || '').trim().split(/\s+/)[0] || 'there';
}

// ── hand-written copy. Same house rules as the cold copy: short, ask-led, easy no,
//    no fabricated customers, no price, no filler phrases, no em dashes. ──────────
function stageCopy(stage, w) {
  const first = firstName(w.contact_name);
  // manualLeads() and warmLeads() both set camelCase signalDetail; read it here, or every
  // manual draft silently falls back to the generic opener.
  w = { ...w, signal_detail: w.signal_detail || w.signalDetail };
  const detail = w.detail || '';
  if (stage === 1) {
    const openers = {
      missed_demo: `We missed each other on ${w.signal_detail || 'our call'}. No worries if the timing was off.`,
      demo_watched: `Wanted to check whether the demo was any use.`,
      replied_interest: `Thanks for your note.`,
      interested_click: `You asked me to reach out, so here I am.`,
      manual: w.signal_detail || `Picking up where we left off.`,
    };
    return `Hi ${first},

${openers[w.signal] || openers.manual}
${detail ? detail + '\n\n' : ''}Still worth a look, or should I close this out?`;
  }
  if (stage === 2) {
    const seconds = {
      cadre: `One thing worth adding. The renewal warnings go to the person whose ticket it is, not only to the office, at sixty, thirty and seven days. That tends to end the week-before scramble.\n\nWorth ten minutes?`,
      aevon: `One thing worth adding. What I build sits inside the workflow you already have, so nobody learns a new system to get the benefit. That is usually the part people ask about first.\n\nWorth ten minutes?`,
    };
    return `Hi ${first},

${seconds[w.campaign] || seconds.aevon}`;
  }
  // stage 3: the breakup. Consistently the highest-replying message in any sequence,
  // because it is the only one that asks for nothing.
  return `Hi ${first},

Last note from me on this.

If ${w.problem || 'this'} is already handled or just not this year's problem, no reply needed and I will leave it there.

If the timing is wrong, say when and I will come back then.`;
}

function rejectCopy(body) {
  const words = body.trim().split(/\s+/).length;
  if (words > 110) return `${words} words, too long`;
  if (/\bcircl(e|ing) back|following up|bumping this|touching base|per my last\b/i.test(body)) return 'filler follow-up phrase';
  if (/\bour (clients|customers)\b|\bcompanies like\b/i.test(body)) return 'implies customers that do not exist';
  if (/\$|\bprice|\bpricing\b/i.test(body)) return 'mentions price';
  if (!/\n\n/.test(body)) return 'no paragraph breaks';
  return null;
}

// ── signal detection ──────────────────────────────────────────────
async function warmLeads(campaign) {
  const leadTable = campaign === 'cadre' ? 'cadre_leads' : 'leads';
  const eventTable = campaign === 'cadre' ? 'cadre_email_events' : 'email_events';
  // Supabase returns at most 1,000 rows per request. email_events holds ~10k, so a single
  // select silently saw a tenth of the history. Page through everything.
  const all = async (table, cols, order) => {
    let rows = [], from = 0;
    while (true) {
      let q = supabase.from(table).select(cols).range(from, from + 999);
      if (order) q = q.order(order, { ascending: true });
      const { data, error } = await q;
      if (error) throw new Error(`fetch ${table} failed: ${error.message}`);
      rows = rows.concat(data || []);
      if (!data || data.length < 1000) return rows;
      from += 1000;
    }
  };
  const leads = await all(leadTable, 'id, business_name, contact_name, email, status, email_subject, industry, last_sent_at', 'id');
  const events = await all(eventTable, 'lead_id, event_type, created_at, metadata', 'created_at');
  STATS.leads += leads.length; STATS.events += events.length;

  const byLead = new Map();
  for (const e of events || []) {
    if (!byLead.has(e.lead_id)) byLead.set(e.lead_id, []);
    byLead.get(e.lead_id).push(e);
  }

  const out = [];
  for (const lead of leads || []) {
    if (SKIP_STATUS.has(lead.status)) continue;
    const evs = byLead.get(lead.id) || [];

    // newest reply anywhere on the thread
    const replies = evs.filter(e => e.event_type === 'replied');
    const lastReply = replies.length ? replies[replies.length - 1] : null;
    const goodReply = replies.find(e => GOOD_INTENT.has(e.metadata && e.metadata.intent));
    const interested = evs.find(e => e.event_type === 'interested');

    // genuine visits: bot-filtered, not within 10 min of a send, sessions 30+ min apart
    const sentAts = evs.filter(e => e.event_type === 'sent').map(e => new Date(e.created_at).getTime());
    const visits = [];
    for (const e of evs) {
      if (e.event_type !== 'clicked') continue;
      if (isBotUa(e.metadata && e.metadata.ua)) continue;
      const t = new Date(e.created_at).getTime();
      if (sentAts.some(s => Math.abs(t - s) < 10 * 60000)) continue;
      if (visits.length && t - visits[visits.length - 1] < 30 * 60000) continue;
      visits.push(t);
    }

    let signal = null, signalAt = null, signalDetail = '';
    if (goodReply) {
      signal = 'replied_interest';
      signalAt = new Date(goodReply.created_at);
      signalDetail = (goodReply.metadata && goodReply.metadata.intent) || '';
    } else if (interested) {
      signal = 'interested_click'; signalAt = new Date(interested.created_at);
    } else if (visits.length >= 2) {
      signal = 'demo_watched'; signalAt = new Date(visits[visits.length - 1]);
      signalDetail = `${visits.length} separate visits`;
    }
    if (!signal) continue;
    STATS.signals++;
    if (DRY) console.log(`  signal: ${lead.business_name} | ${signal} ${signalDetail} | ${signalAt.toISOString().slice(0, 10)}`);
    // A signal older than 30 days with no touch yet is history, not warmth. Drafting "you took a
    // look" to someone who clicked months ago reads as surveillance, not follow-up.
    if (Date.now() - signalAt.getTime() > 30 * DAY && !evs.some(e => e.event_type === 'warm_touch')) continue;

    const touches = evs.filter(e => e.event_type === 'warm_touch');
    const closed = evs.some(e => e.event_type === 'warm_closed');
    const lastTouch = touches.length ? touches[touches.length - 1] : null;
    // Thread alive and newer than our last touch: reply-processor owns it, stay out.
    if (lastReply && (!lastTouch || new Date(lastReply.created_at) > new Date(lastTouch.created_at))) continue;

    out.push({
      campaign, lead, signal, signalAt, signalDetail,
      touches: touches.map(t => t.metadata && t.metadata.stage),
      lastTouchAt: lastTouch ? new Date(lastTouch.created_at) : null,
      closed,
      // lead_insights and signal_quote are internal notes and raw scrape text, not sentences a
      // prospect should read. Hand-written detail only comes from warm-manual.json.
      detail: '',
      problem: campaign === 'cadre' ? 'certification tracking' : 'this',
      inboundMessageId: lastReply && lastReply.metadata && lastReply.metadata.inbound_message_id,
      originalSubject: lead.email_subject,
    });
  }
  return out;
}

function manualLeads() {
  if (!fs.existsSync(MANUAL_FILE)) return [];
  const list = JSON.parse(fs.readFileSync(MANUAL_FILE, 'utf8'));
  return list.filter(m => !m.closed).map(m => ({
    campaign: m.campaign || 'aevon', manual: true,
    signal: 'manual', signalAt: new Date(m.signal_date),
    signalDetail: m.signal_detail || '', detail: m.detail || '', problem: m.problem || 'this',
    touches: m.touches || [], lastTouchAt: m.last_touch_at ? new Date(m.last_touch_at) : null,
    business_name: m.business_name, contact_name: m.contact_name, email: m.email,
    originalSubject: m.subject || '',
  }));
}

function nextStage(w) {
  const done = new Set(w.touches);
  for (const s of [1, 2, 3]) if (!done.has(s)) return s;
  return null;
}

function dueStage(w, now) {
  if (w.closed) return null;
  const s = nextStage(w);
  if (!s) return 'closed';
  const base = s === 1 ? w.signalAt : w.lastTouchAt;
  if (!base) return null;
  return (now - base >= STAGE_DELAY[s]) ? s : null;
}

(async () => {
  for (const v of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'GMAIL_OAUTH_REFRESH_TOKEN', 'GMAIL_USER']) {
    if (!process.env[v]) { console.error(`${v} missing. Failing loud, not drafting nothing quietly.`); process.exit(1); }
  }
  const now = new Date();
  const gmail = DRY ? null : gmailClient();
  const all = [...await warmLeads('aevon'), ...await warmLeads('cadre'), ...manualLeads()];

  let drafted = 0, skipped = 0;
  const needHuman = [];
  for (const w of all) {
    const name = w.business_name || (w.lead && w.lead.business_name);
    const stage = dueStage(w, now);
    if (stage === 'closed') {
      if (!DRY && !w.manual) {
        await supabase.from(w.campaign === 'cadre' ? 'cadre_email_events' : 'email_events')
          .insert({ lead_id: w.lead.id, event_type: 'warm_closed', metadata: { source: 'warm-followup' } });
      }
      needHuman.push(`${name}: email sequence exhausted, needs a human move (call, LinkedIn, referral)`);
      continue;
    }
    if (!stage) { skipped++; continue; }

    const body = stageCopy(stage, w);
    const problem = rejectCopy(body);
    if (problem) { console.error(`REJECT ${name} stage ${stage}: ${problem}`); continue; }
    const subject = w.originalSubject ? `Re: ${w.originalSubject.replace(/^re:\s*/i, '')}` : `Re: ${name}`;
    const to = w.email || (w.lead && w.lead.email);
    if (!to) { console.error(`SKIP ${name}: no email address`); continue; }

    const gateReason = draftGate({ to, businessName: name, body });
    if (gateReason) { console.error(`GATE BLOCKED ${name} stage ${stage}: ${gateReason}`); continue; }

    if (DRY) { console.log(`[dry] stage ${stage} -> ${name} <${to}>\n${body}\n---`); drafted++; continue; }

    const raw = await buildRawDraft({ to, subject, body, inReplyTo: w.inboundMessageId });
    await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } });
    const meta = { source: 'warm-followup', stage, signal: w.signal };
    if (w.manual) {
      // Write the touch back into warm-manual.json immediately. A draft the file does not
      // know about gets drafted again on the next run.
      const list = JSON.parse(fs.readFileSync(MANUAL_FILE, 'utf8'));
      const entry = list.find(m => m.email === to);
      if (entry) {
        entry.touches = [...(entry.touches || []), stage];
        entry.last_touch_at = now.toISOString();
        fs.writeFileSync(MANUAL_FILE, JSON.stringify(list, null, 2));
      } else {
        console.error(`DRAFTED for ${name} but could not find it in warm-manual.json to record the touch. Fix now or this will double-draft.`);
        process.exit(1);
      }
    } else {
      const et = w.campaign === 'cadre' ? 'cadre_email_events' : 'email_events';
      const { error } = await supabase.from(et).insert({ lead_id: w.lead.id, event_type: 'warm_touch', metadata: meta });
      if (error) { console.error(`LOGGED DRAFT BUT FAILED TO RECORD IT for ${name}: ${error.message}. Fix now or this will double-draft.`); process.exit(1); }
    }
    drafted++;
    console.log(`drafted stage ${stage} -> ${name} <${to}>`);
  }

  console.log(`\nRead ${STATS.leads} leads and ${STATS.events} events; ${STATS.signals} had a warm signal (before the 30-day age and live-thread filters).`);
  console.log(`Done. Drafted: ${drafted} | Not due yet: ${skipped}`);
  if (needHuman.length) {
    console.log('\nNeeds a human move (email has done all it can):');
    needHuman.forEach(n => console.log(`  - ${n}`));
  }
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
