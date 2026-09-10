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

/** Book a held slot: appointment on her calendar, confirmation text, tag, reminder at T-30. */
async function confirm(state, contactId, contact, hold, which = 0) {
  const slot = new Date(hold.slots[which] || hold.slots[0]);
  const title = `${hold.kind === 'showing' ? 'Showing' : 'Call'} with ${cfg.ownerName}, ${firstName(contact) || 'lead'}`;
  // A reschedule replaces the earlier booking rather than adding a second one.
  const prior = state.appointments.find((a) => a.contactId === contactId && new Date(a.at) > new Date());
  if (prior) {
    await write('cancel earlier appointment', () => ghl.createAppointment({ calendarId: fd.calendarId, contactId, startTime: prior.at, title: prior.title, cancel: true }), { contactId, startTime: prior.at });
    state.appointments = state.appointments.filter((a) => a !== prior);
  }
  await write('create appointment', () => ghl.createAppointment({ calendarId: fd.calendarId, contactId, startTime: slot.toISOString(), title }),
    { contactId, startTime: slot.toISOString(), title, leadName: firstName(contact) || '', remindAt: addMin(slot, -REMIND_MIN).toISOString() });
  const msg = prior ? `Moved you to ${fmt(slot, TZ)}. I will call you then. Reply here if anything changes.` : `You are booked for ${fmt(slot, TZ)}. I will call you then. Reply here if anything changes.`;
  await write('send confirmation', () => ghl.sendMessage({ contactId, message: msg }), { contactId, message: msg });
  remember(state, contactId, 'me', msg);
  await write('tag booked', () => ghl.addTags(contactId, ['agent-booked']), { contactId, tags: ['agent-booked'] });
  state.appointments.push({ contactId, leadName: firstName(contact) || '', at: slot.toISOString(), title, remindAt: addMin(slot, -REMIND_MIN).toISOString(), reminded: false });
  delete state.holds[contactId];
}

/** Reminders that have come due since the last pass. */
async function sendReminders(state, now) {
  for (const a of state.appointments) {
    if (a.reminded || new Date(a.remindAt) > now || new Date(a.at) < now) continue;
    // In her voice, to the person by name: "Hi Marcus, I will call you at 12:45, in about 15 minutes."
    const msg = `Hi ${a.leadName || 'there'}, I will ${a.title.toLowerCase().startsWith('showing') ? 'see you' : 'call you'} at ${new Date(a.at).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })}, in about ${REMIND_MIN} minutes.`;
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

/** Post a draft for approval: internal comment plus the agent-draft tag. Every draft goes through here. */
async function postDraft(state, contactId, draft) {
  await write('post draft as internal comment', () => ghl.sendMessage({ contactId, message: `DRAFT for your OK (add tag agent-send to send):\n\n${draft}`, type: 'InternalComment' }), { contactId });
  await write('tag agent-draft', () => ghl.addTags(contactId, ['agent-draft']), { contactId, tags: ['agent-draft'] });
  state.drafts[contactId] = { text: draft, at: new Date().toISOString() };
  remember(state, contactId, 'me', draft);
  say('     draft:\n' + draft.split('\n').map((l) => '       ' + l).join('\n'));
}

/** Offer two slots inside a preference (or the next two if none), and hold them. */
async function offerFor(state, contactId, contact, pref, kind, carry) {
  const who = firstName(contact) || contactId;
  const { rules, day } = pref ? narrowRules(RULES, pref) : { rules: RULES, day: null };
  delete state.holds[contactId];   // their own held slots are free again
  const { offered } = findFreeSlots(await busyEvents(state), { ...rules, offer: 6 });
  const keep = offered.filter((d) => onDay(d, day, TZ)).slice(0, RULES.offer || 2);
  let draft;
  if (keep.length) {
    draft = `${pref ? `${pref.label} works. ` : ''}I can call you ${keep.map((d) => fmt(d, TZ)).join(' or ')}. Which works better?`;
    state.holds[contactId] = { slots: keep.map((d) => d.toISOString()), kind, expires: addMin(new Date(), HOLD_MIN).toISOString(), known: carry.known || [], missing: carry.missing || [] };
    say(`  ${who}: ${pref ? `asked for ${pref.label}; ` : ''}offered ${keep.length} slot(s)`);
    say(`     offered slots: ${keep.map((d) => d.toISOString()).join(', ')}`);
  } else {
    // Same day first, then anything. "I am with a client then" is how she would put it.
    const sameDay = day ? findFreeSlots(await busyEvents(state), { ...rules, hours: RULES.hours, offer: 6 }).offered.filter((d) => onDay(d, day, TZ)).slice(0, RULES.offer || 2) : [];
    const near = sameDay.length ? sameDay : findFreeSlots(await busyEvents(state), RULES).offered;
    draft = `I am with a client ${pref ? pref.label.replace(/^(\w{3}, \w{3} \d{1,2}) (\d)/, '$1 at $2') : 'then'}, sorry. ${sameDay.length ? 'Same day I could do' : 'I could do'} ${near.map((d) => fmt(d, TZ)).join(' or ')}. Would either of those work?`;
    state.holds[contactId] = { slots: near.map((d) => d.toISOString()), kind, expires: addMin(new Date(), HOLD_MIN).toISOString(), known: carry.known || [], missing: carry.missing || [] };
    say(`  ${who}: asked for ${pref ? pref.label : 'a time'}; nothing free, offered nearest`);
    say(`     offered slots: ${near.map((d) => d.toISOString()).join(', ')}`);
  }
  await postDraft(state, contactId, draft);
}

/**
 * ONE MESSAGE, ONE JOB. Time-talk is handled by the booking code and never by the drafting
 * model; the model only ever writes the qualifying replies. Order:
 *   1. A pick of a held slot books it.
 *   2. Any message naming a day or time (also with no hold: "can we do Sep 15?" after a booking
 *      is a reschedule) gets a fresh offer inside that window.
 *   3. Mid-booking and unreadable: ask the model which of pick / other time / decline / unclear,
 *      record any facts it answered, and act on that.
 *   4. Otherwise it is conversation: classify, qualify, learn, draft. The offer of a call comes
 *      only once the lead has answered enough to be worth her time, and it goes out alone.
 */
async function handleInbound(state, { contactId, contact, text, messageId }) {
  remember(state, contactId, 'them', text);
  const mem = memory(state, contactId);
  const hold = state.holds[contactId];
  const holding = !!(hold && new Date(hold.expires) > new Date());
  const who = firstName(contact) || contactId;
  const booked = state.appointments.find((a) => a.contactId === contactId && new Date(a.at) > new Date());

  // 1. A pick.
  const picked = holding ? pickSlot(text, hold.slots, TZ) : null;
  if (picked !== null) {
    say(`  ${who}: confirmed slot ${picked + 1}`);
    await confirm(state, contactId, contact, hold, picked);
    return;
  }

  // 1b. A cancellation of a live booking. "cancel", "can't make it", "need to cancel", "something
  // came up, can't do it" with no new time named. The appointment goes, the reminder with it, the
  // lead gets a text, and the door stays open. Found missing in rehearsal 2026-09-10.
  const pref = parsePreference(text, new Date(), TZ);
  const cancelWords = /\b(cancel|cancell?ing|can(?:'|no)?t (make|do) (it|that|the call)|won(?:'|no)?t be able|not going to (make|work)|scrap (it|that|the call)|call it off)\b/i;
  if (booked && cancelWords.test(text) && !(pref && (pref.at || pref.dayOffset !== null))) {
    say(`  ${who}: cancelling the ${fmt(new Date(booked.at), TZ)} call`);
    await write('cancel appointment', () => ghl.createAppointment({ calendarId: fd.calendarId, contactId, startTime: booked.at, title: booked.title, cancel: true }), { contactId, startTime: booked.at });
    state.appointments = state.appointments.filter((a) => a !== booked);
    delete state.holds[contactId];
    const msg = `No problem, I have taken the ${fmt(new Date(booked.at), TZ)} call off. Text me here when you want to pick another time.`;
    await write('send cancellation', () => ghl.sendMessage({ contactId, message: msg }), { contactId, message: msg });
    remember(state, contactId, 'me', msg);
    await write('tag cancelled', () => ghl.addTags(contactId, ['agent-cancelled']), { contactId, tags: ['agent-cancelled'] });
    return;
  }

  // 2. A day or time, held or not. After a booking this is a reschedule.
  // A named day or date, or a clock time, is time-talk on its own ("Wed sep 16 10 am"); a bare
  // part of day ("mornings are better") needs a hold, a booking, or a scheduling word around it.
  const explicit = !!(pref && (pref.at || pref.dayOffset !== null));
  if (pref && (holding || booked || explicit || /\b(resched|move|change|instead|rather|better|works|prefer|can we|could we|how about|what about)\b/i.test(text))) {
    if (booked) say(`  ${who}: wants to move the ${fmt(new Date(booked.at), TZ)} call`);
    // An exact day and clock time that is free ("Thursday 12:45 pls") is a pick, not a
    // preference: book it. A day alone, or a taken time, gets the two-slot offer.
    if (pref.at && pref.dayOffset !== null) {
      const { rules, day } = narrowRules(RULES, pref);
      const { offered } = findFreeSlots(await busyEvents(state), { ...rules, offer: 1 });
      const exact = offered.find((d) => onDay(d, day, TZ));
      if (exact) {
        say(`  ${who}: named a free time, booking it`);
        await confirm(state, contactId, contact, { slots: [exact.toISOString()], kind: holding ? hold.kind : 'call' }, 0);
        return;
      }
    }
    await offerFor(state, contactId, contact, pref, holding ? hold.kind : 'call', holding ? hold : mem);
    return;
  }

  // 3. Mid-booking, and the rules could not read it.
  if (holding) {
    const read = await readBookingReply({ text, slots: hold.slots, timezone: TZ, missing: hold.missing || [], known: hold.known || [] });
    say(`  ${who}: mid-booking, model read it as ${read.kind}${read.note ? ` (${read.note})` : ''}`);
    if (read.answered.length) {
      const labels = read.answered.map((a) => a.split(':')[0].trim().toLowerCase());
      const stillMissing = (hold.missing || []).filter((m) => !labels.some((l) => m.toLowerCase().includes(l) || l.includes(m.toLowerCase().split(' ')[0])));
      hold.known = [...(hold.known || []), ...read.answered]; hold.missing = stillMissing;
      learn(state, contactId, read.answered, stillMissing);
      say(`     learned: ${read.answered.join(' | ')}`);
      const noteText = [`Agent read this message at ${fmt(new Date(), TZ)}.`, ...read.answered.map((k) => `known: ${k}`), ...stillMissing.map((m) => `still needed: ${m}`)].join(String.fromCharCode(10));
      await write('add note', () => ghl.addNote(contactId, noteText), { contactId, learned: read.answered, stillNeeded: stillMissing });
    }
    if (read.kind === 'pick' && read.slot !== null) {
      say(`  ${who}: confirmed slot ${read.slot + 1}`);
      await confirm(state, contactId, contact, hold, read.slot);
      return;
    }
    if (read.kind === 'other_time' && read.when) {
      const p2 = parsePreference(read.when, new Date(), TZ);
      if (p2) { await offerFor(state, contactId, contact, p2, hold.kind, hold); return; }
    }
    if (read.kind === 'decline') {
      delete state.holds[contactId];
      await postDraft(state, contactId, 'No problem. When the timing is better, text me here and I will find you a time.');
      return;
    }
    hold.expires = addMin(new Date(), HOLD_MIN).toISOString();   // keep the hold alive for the next reply
    await postDraft(state, contactId, `${read.answered.length ? 'Got it, thanks. Which' : 'Which'} works better for a call, ${hold.slots.map((s) => fmt(new Date(s), TZ)).join(' or ')}? Or tell me a time that suits you.`);
    return;
  }

  // 4. Conversation.
  const res = await handleInquiry({ fromName: contact.name || '', fromEmail: contact.email || `${contact.phone || contactId}@sms`, subject: '(text)', body: text, history: mem.history.slice(0, -1), known: mem.known });
  const tag = res.intent === 'inquiry' ? (res.qualified ? 'QUALIFIED' : 'inquiry, not qualified') : res.intent;
  say(`  ${who}: [${tag}] ${res.reason || ''}`);
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
  await write('add note', () => ghl.addNote(contactId, noteLines.join(String.fromCharCode(10))), { contactId, lines: noteLines.length });
  const tags = ['agent-read', res.qualified ? 'qualified' : 'needs-qualifying'];
  if (/\bva\b/i.test((res.known || []).join(' '))) tags.push('va');
  await write('add tags', () => ghl.addTags(contactId, tags), { contactId, tags });

  // A real person who is not (yet) qualified still gets a short draft: "hi" deserves "hi, what are
  // you looking for?". Only spam, out of scope and other are left unanswered.
  if (!res.draft) return;

  // WORTH HER TIME? The offer of a call comes only once the lead has answered enough: never on
  // their first text (one text is a request, two is a conversation), then when three of her facts
  // are in or they have replied a third time. Configurable per client as frontDesk.offerAfterKnown.
  // When it goes, it goes alone: the model's questions are dropped so the text has one job and the
  // reply can only mean a time. Aidan, 2026-09-09: "call can come after you've verified they're
  // worthy of your time."
  const theirTurns = mem.history.filter((h) => h.who === 'them').length;
  const worthACall = theirTurns >= 2 && (mem.known.length >= (fd.offerAfterKnown || 3) || theirTurns >= 3);
  if (fd.calendarId !== undefined && !booked && worthACall) {
    const firstSentence = (res.draft.trim().match(/^[^.!?]*[.!?]/) || [res.draft.trim()])[0].trim();
    const ack = /\?$/.test(firstSentence) ? 'Thanks, that is everything I need for now.' : firstSentence.replace(/^Hi [^,]+,\s*/i, '').replace(/^[a-z]/, (c) => c.toUpperCase());
    const { offered, skipped } = findFreeSlots(await busyEvents(state), RULES);
    if (offered.length) {
      if (skipped.length) say(`     held ${offered.length} slot(s); skipped ${skipped[0].reason}`);
      say(`     offered slots: ${offered.map((d) => d.toISOString()).join(', ')}`);
      state.holds[contactId] = { slots: offered.map((d) => d.toISOString()), kind: 'call', expires: addMin(new Date(), HOLD_MIN).toISOString(), known: mem.known, missing: mem.missing };
      await postDraft(state, contactId, `${ack}\n\nI can call you ${offered.map((d) => fmt(d, TZ)).join(' or ')}. Which works better, or is there a time that suits you more?`);
      return;
    }
  }

  const draft = res.draft.trim();
  if (cfg.autoSend === true && process.env.GHL_ARMED === 'true' && !DRY) {
    await ghl.sendMessage({ contactId, message: draft });
    await ghl.addTags(contactId, ['agent-sent']);
    remember(state, contactId, 'me', draft);
    say('     sent (autoSend on)');
    return;
  }
  await postDraft(state, contactId, draft);
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
