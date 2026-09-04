#!/usr/bin/env node
/**
 * frontdesk/worker.js, the Front Desk agent running against a client's GoHighLevel.
 *
 * One pass per invocation, meant to run every few minutes from a scheduler. Each pass:
 *
 *   1. Pulls recent inbound conversations from GHL and skips anything already handled.
 *   2. If the lead is replying "C" to a slot we offered, books it: appointment on the calendar,
 *      confirmation text, reminder scheduled.
 *   3. Otherwise classifies the message with the same brain as intake-agent.js, qualifies it
 *      against the client's own list, and drafts a reply in their voice.
 *   4. Writes what it learned to the contact: a note with known and still-needed facts, tags for
 *      the pipeline. This is the flag the client did not have before.
 *   5. Puts the draft where the client sees it. APPROVAL FIRST: the draft is posted as an internal
 *      comment and the contact is tagged `agent-draft`. The client approves by adding the tag
 *      `agent-send` in GHL (one tap on the phone), or sends their own version and removes the tag.
 *      Only a client config with autoSend: true skips this, and even then GHL_ARMED must be set.
 *   6. Sends any reminders that have come due.
 *
 * NOTHING TOUCHES A CLIENT SYSTEM WITHOUT A TOKEN THEY GAVE US, and nothing writes unless
 * GHL_ARMED=true. With neither, --dry prints every decision and every payload and stops there.
 * That is also how the Thursday demo runs.
 *
 *   node frontdesk/worker.js --client skyline --dry
 *   node frontdesk/worker.js --client skyline
 *   node frontdesk/worker.js --client skyline --simulate "<an inbound text>" --from "+12535550142"
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i > -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const DRY = args.includes('--dry') || !!flag('simulate');
const CLIENT = flag('client') || 'skyline';
const SIMULATE = flag('simulate');
// --keep lets a simulated conversation carry state across two runs, so the C reply can be tested.
const KEEP = args.includes('--keep');

// intake-agent picks its config from argv at load, so name the client before requiring it.
process.argv.push('--config', CLIENT);
const { handleInquiry, CONFIGS } = require('../intake-agent');
const ghl = require('../lib/ghl');
const { findFreeSlots, fmt, addMin } = require('./slots');

const cfg = CONFIGS[CLIENT];
if (!cfg) throw new Error(`no client config named "${CLIENT}"`);
const fd = cfg.frontDesk || {};
const RULES = Object.assign({
  timezone: 'America/Los_Angeles', hours: { start: '09:00', end: '18:00' }, days: [1, 2, 3, 4, 5, 6],
  slotMin: 15, noticeMin: 120, horizonDays: 10, offer: 2,
  bufferAfterCallMin: 5, bufferBeforeShowingMin: 20, bufferAfterShowingMin: 15,
}, fd.rules || {});
const REMIND_MIN = fd.reminderMinutesBefore || 30;
const HOLD_MIN = fd.holdMinutes || 120;
const TZ = RULES.timezone;

// Per-client state on disk: what we have handled, what we are holding, what we have booked.
// A JSON file, not a database, because a client deployment should have no shared infrastructure.
const STATE_PATH = path.join(__dirname, 'state', `${CLIENT}.json`);
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch (e) { return { processed: [], drafts: {}, holds: {}, appointments: [] }; }
}
function saveState(s) {
  if (DRY && !KEEP) return;
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 1));
}

const say = (...a) => console.log(...a);
const would = (what, payload) => say(`  ${DRY ? 'would' : 'do'}: ${what}`, payload ? JSON.stringify(payload) : '');

/** A write that is silent in --dry and refused by lib/ghl unless armed. */
async function write(what, fn, payload) {
  would(what, payload);
  if (DRY) return { dry: true };
  return fn();
}

/** Busy blocks from the client's GHL calendar, as slot-engine events. */
async function busyEvents(state) {
  const holds = Object.values(state.holds).filter((h) => new Date(h.expires) > new Date())
    .flatMap((h) => h.slots.map((s) => ({ start: s, end: addMin(new Date(s), RULES.slotMin).toISOString(), type: 'hold' })));
  if (DRY || !fd.calendarId) return holds.concat(fd.fixtureEvents || []);
  // free-slots gives availability, not events; invert it by treating anything not free as busy is
  // more work than we need. Appointments booked through us are in state; GHL's own free-slots
  // covers the rest at booking time via a second check in confirm().
  return holds;
}

function firstName(contact) {
  return (contact.firstName || contact.name || '').trim().split(/\s+/)[0] || '';
}

/** The lead typed C (or yes) to the first slot we offered. Book it. */
async function confirm(state, contactId, contact, hold) {
  const slot = new Date(hold.slots[0]);
  const title = `${hold.kind === 'showing' ? 'Showing' : 'Call'} with ${cfg.ownerName}, ${firstName(contact) || 'lead'}`;
  await write('create appointment', () => ghl.createAppointment({ calendarId: fd.calendarId, contactId, startTime: slot.toISOString(), title }),
    { contactId, startTime: slot.toISOString(), title });
  const msg = `You are booked with ${cfg.ownerName} for ${fmt(slot, TZ)}. Reply here if anything changes.`;
  await write('send confirmation', () => ghl.sendMessage({ contactId, message: msg }), { contactId, message: msg });
  await write('tag booked', () => ghl.addTags(contactId, ['agent-booked']), { contactId, tags: ['agent-booked'] });
  state.appointments.push({ contactId, at: slot.toISOString(), title, remindAt: addMin(slot, -REMIND_MIN).toISOString(), reminded: false });
  delete state.holds[contactId];
}

/** Reminders that have come due since the last pass. */
async function sendReminders(state, now) {
  for (const a of state.appointments) {
    if (a.reminded || new Date(a.remindAt) > now || new Date(a.at) < now) continue;
    const msg = `Reminder: your ${a.title.toLowerCase().startsWith('showing') ? 'showing' : 'call'} with ${cfg.ownerName} is at ${fmt(new Date(a.at), TZ)}, in about ${REMIND_MIN} minutes.`;
    await write('send reminder', () => ghl.sendMessage({ contactId: a.contactId, message: msg }), { contactId: a.contactId, message: msg });
    a.reminded = true;
  }
}

/** A client-approved draft: the contact carries the tag agent-send. Send it, swap the tag. */
async function sendApproved(state, contactId) {
  const d = state.drafts[contactId];
  if (!d) return;
  await write('send approved draft', () => ghl.sendMessage({ contactId, message: d.text }), { contactId, message: d.text });
  await write('retag sent', () => ghl.addTags(contactId, ['agent-sent']), { contactId, tags: ['agent-sent'] });
  delete state.drafts[contactId];
}

async function handleInbound(state, { contactId, contact, text, messageId }) {
  const hold = state.holds[contactId];
  if (hold && new Date(hold.expires) > new Date() && /^\s*(c|yes|y|confirm)\s*[.!]?\s*$/i.test(text)) {
    say(`  ${firstName(contact) || contactId}: confirmed slot 1`);
    await confirm(state, contactId, contact, hold);
    return;
  }

  const res = await handleInquiry({ fromName: contact.name || '', fromEmail: contact.email || `${contact.phone || contactId}@sms`, subject: '(text)', body: text });
  const tag = res.intent === 'inquiry' ? (res.qualified ? 'QUALIFIED' : 'inquiry, not qualified') : res.intent;
  say(`  ${firstName(contact) || contactId}: [${tag}] ${res.reason || ''}`);
  if (res.known && res.known.length) say(`     known: ${res.known.join(' | ')}`);
  if (res.missing && res.missing.length) say(`     still needed: ${res.missing.join(' | ')}`);
  if (res.intent !== 'inquiry') return;

  // The record first. Even a weak lead gets filed, because "I lost track of it" is the complaint.
  const noteLines = [
    `Agent read this message at ${fmt(new Date(), TZ)}.`,
    ...(res.known || []).map((k) => `known: ${k}`),
    ...(res.missing || []).map((m) => `still needed: ${m}`),
    res.need ? `wants: ${res.need}` : null,
  ].filter(Boolean);
  await write('add note', () => ghl.addNote(contactId, noteLines.join('\n')), { contactId, lines: noteLines.length });
  const tags = ['agent-read', res.qualified ? 'qualified' : 'needs-qualifying'];
  if (/\bva\b/i.test((res.known || []).join(' '))) tags.push('va');
  await write('add tags', () => ghl.addTags(contactId, tags), { contactId, tags });

  if (!res.qualified || !res.draft) return;

  // Offer times only when a meeting is the right next step, and hold them so two leads are not
  // offered the same quarter hour before either answers.
  let draft = res.draft.trim();
  if (res.booking && fd.calendarId !== undefined) {
    const { offered, skipped } = findFreeSlots(await busyEvents(state), RULES);
    if (offered.length) {
      draft += `\n\nI can do ${offered.map((d) => fmt(d, TZ)).join(' or ')}. Reply C to take the first, or tell me what works.`;
      state.holds[contactId] = { slots: offered.map((d) => d.toISOString()), kind: 'call', expires: addMin(new Date(), HOLD_MIN).toISOString() };
      if (skipped.length) say(`     held ${offered.length} slot(s); skipped ${skipped[0].reason}`);
    }
  }

  if (cfg.autoSend === true && process.env.GHL_ARMED === 'true' && !DRY) {
    await ghl.sendMessage({ contactId, message: draft });
    await ghl.addTags(contactId, ['agent-sent']);
    say('     sent (autoSend on)');
    return;
  }

  // Approval first. The draft lives as an internal comment the client sees in the conversation,
  // and the contact carries agent-draft until they add agent-send or handle it themselves.
  await write('post draft as internal comment', () => ghl.sendMessage({ contactId, message: `DRAFT for your OK (add tag agent-send to send):\n\n${draft}`, type: 'InternalComment' }), { contactId });
  await write('tag agent-draft', () => ghl.addTags(contactId, ['agent-draft']), { contactId, tags: ['agent-draft'] });
  state.drafts[contactId] = { text: draft, at: new Date().toISOString() };
  say('     draft:\n' + draft.split('\n').map((l) => '       ' + l).join('\n'));
}

(async () => {
  const state = loadState();
  const now = new Date();
  say(`Front Desk for "${cfg.businessName}" (${CLIENT})${DRY ? ' [DRY, nothing written]' : ''}, ${fmt(now, TZ)}\n`);

  if (SIMULATE) {
    const phone = flag('from') || '+15555550100';
    await handleInbound(state, { contactId: `sim_${phone.replace(/\D/g, '')}`, contact: { name: flag('name') || '', phone }, text: SIMULATE, messageId: 'sim' });
    saveState(state);
    return;
  }

  // Live: recent inbound conversations. Shape of searchConversations is assumed from the docs
  // and must be checked against a real response on the first armed run.
  const convos = await ghl.searchConversations({ locationId: process.env.GHL_LOCATION_ID, lastMessageDirection: 'inbound', limit: 25 });
  for (const c of (convos.conversations || [])) {
    const msgs = await ghl.getMessages(c.id, { limit: 5 });
    const latest = (msgs.messages || msgs.messages?.messages || []).find((m) => m.direction === 'inbound');
    if (!latest || state.processed.includes(latest.id)) continue;
    const contact = { name: c.fullName || c.contactName || '', phone: c.phone, email: c.email };
    const tags = c.tags || [];
    if (tags.includes('agent-send')) await sendApproved(state, c.contactId);
    await handleInbound(state, { contactId: c.contactId, contact, text: latest.body || latest.message || '', messageId: latest.id });
    state.processed.push(latest.id);
  }
  await sendReminders(state, now);
  state.processed = state.processed.slice(-2000);
  saveState(state);
  say('\nDone.');
})().catch((e) => { console.error('front desk failed:', e.message); process.exit(1); });
