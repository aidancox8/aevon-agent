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
// A person is watching a simulated turn. Race the models instead of waiting on one.
if (SIMULATE && !process.env.GEMINI_HEDGE) process.env.GEMINI_HEDGE = '1';
// --keep lets a simulated conversation carry state across two runs, so the C reply can be tested.
const KEEP = args.includes('--keep');

// intake-agent picks its config from argv at load, so name the client before requiring it.
process.argv.push('--config', CLIENT);
const { handleInquiry, readBookingReply, CONFIGS } = require('../intake-agent');
const ghl = require('../lib/ghl');
const { findFreeSlots, fmt, addMin } = require('./slots');
const { parsePreference, narrowRules, onDay } = require('./preference');
const { pickSlot } = require('./pick');

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
  catch (e) { return { processed: [], drafts: {}, holds: {}, appointments: [], contacts: {} }; }
}

/**
 * What we remember per contact: the transcript and the facts, so the classifier reads every
 * message in context. Without this, "1" after an offer was judged alone and filed as noise
 * (rehearsal 2026-09-09). In production the transcript also comes from GHL; this is the copy the
 * agent wrote or read, which is what it needs.
 */
function memory(state, contactId) {
  if (!state.contacts) state.contacts = {};
  if (!state.contacts[contactId]) state.contacts[contactId] = { history: [], known: [], missing: [] };
  return state.contacts[contactId];
}
function remember(state, contactId, who, text) {
  const m = memory(state, contactId);
  m.history.push({ who, text: String(text || '').slice(0, 600), at: new Date().toISOString() });
  m.history = m.history.slice(-30);
}
function learn(state, contactId, known, missing) {
  const m = memory(state, contactId);
  const labels = new Set(known.map((k) => k.split(':')[0].trim().toLowerCase()));
  m.known = [...m.known.filter((k) => !labels.has(k.split(':')[0].trim().toLowerCase())), ...known];
  m.missing = missing;
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
async function confirm(state, contactId, contact, hold, which = 0) {
  const slot = new Date(hold.slots[which] || hold.slots[0]);
  const title = `${hold.kind === 'showing' ? 'Showing' : 'Call'} with ${cfg.ownerName}, ${firstName(contact) || 'lead'}`;
  await write('create appointment', () => ghl.createAppointment({ calendarId: fd.calendarId, contactId, startTime: slot.toISOString(), title }),
    { contactId, startTime: slot.toISOString(), title });
  const msg = `You are booked with ${cfg.ownerName} for ${fmt(slot, TZ)}. Reply here if anything changes.`;
  await write('send confirmation', () => ghl.sendMessage({ contactId, message: msg }), { contactId, message: msg });
  remember(state, contactId, 'me', msg);
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
  remember(state, contactId, 'them', text);
  const mem = memory(state, contactId);
  const hold = state.holds[contactId];
  const holding = !!(hold && new Date(hold.expires) > new Date());
  // C, yes, "the second one", "1:15", "Sep 10 115 works": all picks of an offered slot.
  const picked = holding ? pickSlot(text, hold.slots, TZ) : null;
  if (picked !== null) {
    say(`  ${firstName(contact) || contactId}: confirmed slot ${picked + 1}`);
    await confirm(state, contactId, contact, hold, picked);
    return;
  }

  // "Wednesday morning works better." The offer said "tell me what works", so read the answer and
  // offer again inside it. Still a draft for approval; only C books. Found missing in rehearsal
  // 2026-09-08, when this reply was filed as an existing conversation and went nowhere.
  if (holding) {
    const pref = parsePreference(text, new Date(), TZ);
    if (pref) {
      const { rules, day } = narrowRules(RULES, pref);
      // Their own held slots are free again; otherwise the first offer blocks the second.
      delete state.holds[contactId];
      const { offered } = findFreeSlots(await busyEvents(state), { ...rules, offer: 6 });
      const keep = offered.filter((d) => onDay(d, day, TZ)).slice(0, RULES.offer || 2);
      const who = firstName(contact) || contactId;
      let draft;
      if (keep.length) {
        draft = `Hi ${firstName(contact) || 'there'}, ${pref.label} works. I can call you ${keep.map((d) => fmt(d, TZ)).join(' or ')}. Which works better?`;
        state.holds[contactId] = { slots: keep.map((d) => d.toISOString()), kind: hold.kind, expires: addMin(new Date(), HOLD_MIN).toISOString(), known: hold.known || [], missing: hold.missing || [] };
        say(`  ${who}: asked for ${pref.label}; re-offered ${keep.length} slot(s)`);
      } else {
        // Nothing free in what they asked for. Say so and offer the nearest, rather than silence.
        const { offered: near } = findFreeSlots(await busyEvents(state), RULES);
        draft = `Hi ${firstName(contact) || 'there'}, nothing open ${pref.label}, sorry. I can call you ${near.map((d) => fmt(d, TZ)).join(' or ')} instead. Would either of those work?`;
        state.holds[contactId] = { slots: near.map((d) => d.toISOString()), kind: hold.kind, expires: addMin(new Date(), HOLD_MIN).toISOString(), known: hold.known || [], missing: hold.missing || [] };
        say(`  ${who}: asked for ${pref.label}; nothing free, offered nearest`);
      }
      await write('post draft as internal comment', () => ghl.sendMessage({ contactId, message: `DRAFT for your OK (add tag agent-send to send):\n\n${draft}`, type: 'InternalComment' }), { contactId });
      await write('tag agent-draft', () => ghl.addTags(contactId, ['agent-draft']), { contactId, tags: ['agent-draft'] });
      state.drafts[contactId] = { text: draft, at: new Date().toISOString() };
    remember(state, contactId, 'me', draft);
      say('     draft:\n' + draft.split('\n').map((l) => '       ' + l).join('\n'));
      return;
    }
  }

  // Holding, and the rules could not read the reply. Ask the model the right question, with the
  // offered slots in front of it: which one, a different time, a no, or unclear. A pick books;
  // a different time is re-offered through the rules; a no releases the hold and drafts a
  // graceful close; unclear asks which. Filing it as an existing thread said "no draft, not on
  // the pipeline" about a lead mid-booking (rehearsal 2026-09-09).
  if (holding) {
    const who = firstName(contact) || contactId;
    const read = await readBookingReply({ text, slots: hold.slots, timezone: TZ, missing: hold.missing || [], known: hold.known || [] });
    say(`  ${who}: mid-booking, model read it as ${read.kind}${read.note ? ` (${read.note})` : ''}`);
    // Answers to the open questions go on the contact now, whatever else the reply was.
    if (read.answered.length) {
      const labels = read.answered.map((a) => a.split(':')[0].trim().toLowerCase());
      hold.known = [...(hold.known || []), ...read.answered];
      learn(state, contactId, read.answered, (hold.missing || []).filter((m) => !labels.some((l) => m.toLowerCase().includes(l) || l.includes(m.toLowerCase().split(' ')[0]))));
      hold.missing = (hold.missing || []).filter((m) => !labels.some((l) => m.toLowerCase().includes(l) || l.includes(m.toLowerCase().split(' ')[0])));
      say(`     learned: ${read.answered.join(' | ')}`);
      const noteText = [`Agent read this message at ${fmt(new Date(), TZ)}.`, ...read.answered.map((k) => `known: ${k}`), ...hold.missing.map((m) => `still needed: ${m}`)].join(String.fromCharCode(10));
      await write('add note', () => ghl.addNote(contactId, noteText), { contactId, learned: read.answered, stillNeeded: hold.missing });
    }
    if (read.kind === 'pick' && read.slot !== null) {
      say(`  ${who}: confirmed slot ${read.slot + 1}`);
      await confirm(state, contactId, contact, hold, read.slot);
      return;
    }
    if (read.kind === 'other_time' && read.when) {
      const pref = parsePreference(read.when, new Date(), TZ);
      if (pref) return handleInbound(state, { contactId, contact, text: read.when, messageId });
    }
    if (read.kind === 'decline') {
      delete state.holds[contactId];
      const draft = `Hi ${firstName(contact) || 'there'}, no problem. When the timing is better, text me here and I will find you a time.`;
      await write('post draft as internal comment', () => ghl.sendMessage({ contactId, message: `DRAFT for your OK (add tag agent-send to send):\n\n${draft}`, type: 'InternalComment' }), { contactId });
      await write('tag agent-draft', () => ghl.addTags(contactId, ['agent-draft']), { contactId, tags: ['agent-draft'] });
      state.drafts[contactId] = { text: draft, at: new Date().toISOString() };
    remember(state, contactId, 'me', draft);
      say('     draft:\n' + draft.split('\n').map((l) => '       ' + l).join('\n'));
      return;
    }
    // Keep the hold alive so the next reply ("1", "the 12:45") is still read as a pick. Without
    // this the follow-up dropped to the classifier and was filed as "other" (rehearsal 2026-09-09).
    hold.expires = addMin(new Date(), HOLD_MIN).toISOString();
    const ack = read.answered.length ? 'got it, thanks. Which' : 'which';
    const draft = `Hi ${firstName(contact) || 'there'}, ${ack} works better for a call, ${hold.slots.map((s) => fmt(new Date(s), TZ)).join(' or ')}? Or tell me a time that suits you.`;
    say(`  ${who}: asking which`);
    await write('post draft as internal comment', () => ghl.sendMessage({ contactId, message: `DRAFT for your OK (add tag agent-send to send):\n\n${draft}`, type: 'InternalComment' }), { contactId });
    await write('tag agent-draft', () => ghl.addTags(contactId, ['agent-draft']), { contactId, tags: ['agent-draft'] });
    state.drafts[contactId] = { text: draft, at: new Date().toISOString() };
    remember(state, contactId, 'me', draft);
    say('     draft:\n' + draft.split('\n').map((l) => '       ' + l).join('\n'));
    return;
  }

  const res = await handleInquiry({ fromName: contact.name || '', fromEmail: contact.email || `${contact.phone || contactId}@sms`, subject: '(text)', body: text, history: mem.history.slice(0, -1), known: mem.known });
  const tag = res.intent === 'inquiry' ? (res.qualified ? 'QUALIFIED' : 'inquiry, not qualified') : res.intent;
  say(`  ${firstName(contact) || contactId}: [${tag}] ${res.reason || ''}`);
  if (res.known && res.known.length) say(`     known: ${res.known.join(' | ')}`);
  if (res.missing && res.missing.length) say(`     still needed: ${res.missing.join(' | ')}`);
  if (res.intent !== 'inquiry') return;
  learn(state, contactId, res.known || [], res.missing || []);

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

  // A qualified lead is always offered times. The model's `booking` flag was the gate and it
  // flipped on identical text between runs (2026-09-09), which meant a lead sometimes got no
  // offer and their next reply had no hold to match. Sofia's whole ask is booking; offer it.
  // Skip only when this contact already has a live hold or a booked call.
  let draft = res.draft.trim();
  const alreadyBooked = state.appointments.some((a) => a.contactId === contactId && new Date(a.at) > new Date());
  if (fd.calendarId !== undefined && !holding && !alreadyBooked) {
    const { offered, skipped } = findFreeSlots(await busyEvents(state), RULES);
    if (offered.length) {
      draft += `\n\nI can call you ${offered.map((d) => fmt(d, TZ)).join(' or ')}. Which works better, or is there a time that suits you more?`;
      state.holds[contactId] = { slots: offered.map((d) => d.toISOString()), kind: 'call', expires: addMin(new Date(), HOLD_MIN).toISOString(), known: res.known || [], missing: res.missing || [] };
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
    remember(state, contactId, 'me', draft);
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
    // A losing model call can hold the event loop open for half a minute after the turn is
    // done. The turn is saved; nothing else is owed. Measured 2026-09-09: 9 to 36s of nothing.
    process.exit(0);
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
