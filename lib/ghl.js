/**
 * lib/ghl.js, client for the GoHighLevel v2 API (services.leadconnectorhq.com).
 *
 * WHY IT IS HERE. There is no active GHL integration yet. This is scaffolding for whichever
 * campaign ends up on GHL, written before the token exists so the fail-closed shape is decided
 * before there is anything to break.
 *
 * WHY EVERY WRITE IS GUARDED. A missed guard here does not cost money the way treg does, but
 * it can message a real contact or create a real appointment on a live location. So:
 *   - reads (get, search, list) run with just a token
 *   - anything that changes state (send, upsert, tag, note, create) refuses unless
 *     GHL_ARMED === 'true'
 *
 * WHAT IS NOT VERIFIED. No call has ever been made from this file. No GHL_TOKEN exists in
 * .env. The shapes below are transcribed from GoHighLevel's v2 API docs
 * (https://highlevel.stoplight.io/docs/integrations) and are unconfirmed against a live
 * response. searchConversations in particular is assumed to exist at GET
 * /conversations/search; it is documented in the sidebar but this has not been hit live.
 * Treat the first live call as a test, not as production.
 *
 * Env:
 *   GHL_TOKEN        required for anything at all
 *   GHL_LOCATION_ID  required wherever GHL wants a locationId in the body or query
 *   GHL_ARMED        must be exactly 'true' before a write is allowed
 */
const https = require('https');

const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

// Read lazily, at call time, not at require time, so a file that only reads constants from
// this module (ARMED, GhlError) does not need a token to already be sitting in the environment.
function getToken() {
  const token = process.env.GHL_TOKEN || '';
  if (!token) throw new GhlError('GHL_TOKEN is not set. There is no GHL token yet; add one to .env before calling this.', 0, null);
  return token;
}
function getLocationId() {
  return process.env.GHL_LOCATION_ID || '';
}
const ARMED = () => String(process.env.GHL_ARMED || '').toLowerCase() === 'true';

class GhlError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'GhlError';
    this.status = status;
    this.body = body;
  }
}

/** Refuses to build a write request unless GHL_ARMED is exactly 'true'. Reads skip this. */
function assertArmed(action) {
  if (!ARMED()) {
    throw new GhlError(`GHL_ARMED is not "true", so ${action} was not sent. This is deliberate.`, 0, null);
  }
}

/**
 * Builds a request without sending it: {url, headers, payload}. Exists so the offline check
 * can assert on exact URLs, headers and bodies without a network call or a token.
 */
function _buildRequest(method, path, body) {
  const url = `${BASE}${path}`;
  const payload = body === undefined || body === null ? null : JSON.stringify(body);
  const headers = {
    Authorization: `Bearer ${getToken()}`,
    Version: VERSION,
    Accept: 'application/json',
    ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
  };
  return { url, headers, payload };
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    let built;
    try {
      built = _buildRequest(method, path, body);
    } catch (e) {
      return reject(e);
    }
    const req = https.request(built.url, { method, headers: built.headers }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (e) { parsed = { raw }; }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        const message = (parsed && (parsed.message || parsed.error)) || `HTTP ${res.statusCode}`;
        reject(new GhlError(message, res.statusCode, parsed));
      });
    });
    req.on('error', reject);
    if (built.payload) req.write(built.payload);
    req.end();
  });
}

// --- conversations -----------------------------------------------------------------------

/** Write. Sends a message on an existing conversation/contact. */
async function sendMessage({ contactId, message, type = 'SMS' } = {}) {
  assertArmed('sendMessage');
  return request('POST', '/conversations/messages', { type, contactId, message });
}

/** Read. */
async function getMessages(conversationId, { limit = 20 } = {}) {
  const qs = new URLSearchParams({ limit: String(limit) }).toString();
  return request('GET', `/conversations/${encodeURIComponent(conversationId)}/messages?${qs}`);
}

/**
 * Read. Assumed to exist: GET /conversations/search is documented in GHL's v2 reference but
 * has not been hit live from here, see the file header.
 */
async function searchConversations({ locationId, lastMessageDirection, limit = 20 } = {}) {
  const params = { locationId: locationId || getLocationId(), limit: String(limit) };
  if (lastMessageDirection) params.lastMessageDirection = lastMessageDirection;
  const qs = new URLSearchParams(params).toString();
  return request('GET', `/conversations/search?${qs}`);
}

// --- contacts ------------------------------------------------------------------------------

/** Write. Creates or updates a contact by the fields GHL matches on (usually email/phone). */
async function upsertContact({ firstName, lastName, phone, email, tags, source } = {}) {
  assertArmed('upsertContact');
  return request('POST', '/contacts/upsert', {
    locationId: getLocationId(),
    firstName,
    lastName,
    phone,
    email,
    tags,
    source,
  });
}

/** Write. */
async function addTags(contactId, tags) {
  assertArmed('addTags');
  return request('POST', `/contacts/${encodeURIComponent(contactId)}/tags`, { tags });
}

/** Write. */
async function addNote(contactId, body) {
  assertArmed('addNote');
  return request('POST', `/contacts/${encodeURIComponent(contactId)}/notes`, { body });
}

// --- calendars -------------------------------------------------------------------------------

/** Read. */
async function listCalendars() {
  const qs = new URLSearchParams({ locationId: getLocationId() }).toString();
  return request('GET', `/calendars/?${qs}`);
}

/** Read. */
async function freeSlots(calendarId, { startDate, endDate, timezone } = {}) {
  const params = {};
  if (startDate) params.startDate = startDate;
  if (endDate) params.endDate = endDate;
  if (timezone) params.timezone = timezone;
  const qs = new URLSearchParams(params).toString();
  return request('GET', `/calendars/${encodeURIComponent(calendarId)}/free-slots${qs ? `?${qs}` : ''}`);
}

/** Write. */
async function createAppointment({ calendarId, contactId, startTime, title } = {}) {
  assertArmed('createAppointment');
  return request('POST', '/calendars/events/appointments', {
    locationId: getLocationId(),
    calendarId,
    contactId,
    startTime,
    title,
  });
}

module.exports = {
  sendMessage,
  getMessages,
  searchConversations,
  upsertContact,
  addTags,
  addNote,
  listCalendars,
  freeSlots,
  createAppointment,
  _buildRequest,
  GhlError,
  BASE,
  VERSION,
};
