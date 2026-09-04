#!/usr/bin/env node
// Offline assertions for lib/ghl.js. No network call is made: https.request is stubbed below
// before lib/ghl is required, so even a real GHL_TOKEN in the environment could not reach
// GoHighLevel from this script. There is no GHL_TOKEN in .env; the value set below is a fake
// placeholder used only to exercise the Authorization header shape.
const https = require('https');
const { EventEmitter } = require('events');

const calls = [];
const realRequest = https.request;
https.request = function (url, options, callback) {
  calls.push({ url: String(url), method: options.method, headers: options.headers, body: '' });
  const req = new EventEmitter();
  req.write = (chunk) => { calls[calls.length - 1].body += chunk; };
  req.end = () => {
    const res = new EventEmitter();
    res.statusCode = 200;
    process.nextTick(() => {
      callback(res);
      res.emit('data', Buffer.from('{"ok":true}'));
      res.emit('end');
    });
  };
  return req;
};

process.env.GHL_TOKEN = 'test-fake-token-not-real';
process.env.GHL_LOCATION_ID = 'loc-test-1';
delete process.env.GHL_ARMED;

const ghl = require('./lib/ghl');

let bad = 0;
function check(label, ok) {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
}
async function rejects(label, promise, matchText) {
  try {
    await promise;
    check(label, false);
  } catch (e) {
    check(label, matchText ? e.message.includes(matchText) : true);
  }
}
async function resolves(label, promise) {
  try {
    await promise;
    check(label, true);
  } catch (e) {
    check(`${label}  (threw: ${e.message})`, false);
  }
}

async function main() {
  // 1. require-time: no GHL_TOKEN throw. The module was required above with GHL_TOKEN set,
  // so prove the lazy-read separately by clearing it and calling a builder.
  const savedToken = process.env.GHL_TOKEN;
  delete process.env.GHL_TOKEN;
  let threwAtCallTime = false;
  try {
    ghl._buildRequest('GET', '/conversations/x/messages');
  } catch (e) {
    threwAtCallTime = e instanceof ghl.GhlError && e.message.includes('GHL_TOKEN');
  }
  check('missing GHL_TOKEN throws a clear error at call time, not require time', threwAtCallTime);
  process.env.GHL_TOKEN = savedToken;

  // 2. Version header on every built request.
  const built = ghl._buildRequest('GET', '/calendars/');
  check('Version header is 2021-07-28', built.headers.Version === '2021-07-28');

  // 3. Authorization header carries the bearer token.
  check('Authorization header is Bearer <token>', built.headers.Authorization === 'Bearer test-fake-token-not-real');

  // 4. Accept header present.
  check('Accept header is application/json', built.headers.Accept === 'application/json');

  // 5. No Content-Type on a bodyless GET.
  check('GET with no body has no Content-Type', built.headers['Content-Type'] === undefined);

  // 6. Content-Type present on a request with a body.
  const builtWithBody = ghl._buildRequest('POST', '/contacts/upsert', { locationId: 'loc-test-1' });
  check('POST with a body has Content-Type application/json', builtWithBody.headers['Content-Type'] === 'application/json');

  // 7. sendMessage: correct URL, throws unarmed.
  calls.length = 0;
  await rejects('sendMessage() throws when GHL_ARMED is unset', ghl.sendMessage({ contactId: 'c1', message: 'hi' }), 'GHL_ARMED is not "true"');
  check('sendMessage never reached https.request while unarmed', calls.length === 0);

  process.env.GHL_ARMED = 'true';

  calls.length = 0;
  await resolves('sendMessage() succeeds when armed', ghl.sendMessage({ contactId: 'c1', message: 'hi', type: 'SMS' }));
  check('sendMessage POSTs to /conversations/messages', calls[0] && calls[0].url === 'https://services.leadconnectorhq.com/conversations/messages' && calls[0].method === 'POST');
  check('sendMessage body matches {type, contactId, message}', calls[0] && JSON.parse(calls[0].body).contactId === 'c1' && JSON.parse(calls[0].body).type === 'SMS');

  // 8. getMessages: correct URL, no arming needed.
  delete process.env.GHL_ARMED;
  calls.length = 0;
  await resolves('getMessages() succeeds with no GHL_ARMED (read)', ghl.getMessages('convo-1', { limit: 5 }));
  check('getMessages GETs /conversations/:id/messages?limit=', calls[0] && calls[0].url === 'https://services.leadconnectorhq.com/conversations/convo-1/messages?limit=5' && calls[0].method === 'GET');

  // 9. searchConversations: locationId defaulted from env, no arming needed.
  calls.length = 0;
  await resolves('searchConversations() succeeds with no GHL_ARMED (read)', ghl.searchConversations({ lastMessageDirection: 'inbound' }));
  const searchUrl = calls[0] && new URL(calls[0].url);
  check('searchConversations injects locationId from GHL_LOCATION_ID', searchUrl && searchUrl.searchParams.get('locationId') === 'loc-test-1');
  check('searchConversations passes through lastMessageDirection', searchUrl && searchUrl.searchParams.get('lastMessageDirection') === 'inbound');

  // 10. upsertContact: locationId injected, throws unarmed.
  delete process.env.GHL_ARMED;
  calls.length = 0;
  await rejects('upsertContact() throws when GHL_ARMED is unset', ghl.upsertContact({ email: 'a@b.com' }), 'GHL_ARMED is not "true"');
  check('upsertContact never reached https.request while unarmed', calls.length === 0);

  process.env.GHL_ARMED = 'true';
  calls.length = 0;
  await resolves('upsertContact() succeeds when armed', ghl.upsertContact({ firstName: 'A', email: 'a@b.com' }));
  check('upsertContact POSTs to /contacts/upsert', calls[0] && calls[0].url === 'https://services.leadconnectorhq.com/contacts/upsert');
  check('upsertContact body has locationId injected', calls[0] && JSON.parse(calls[0].body).locationId === 'loc-test-1');

  // 11. addTags: throws unarmed, correct URL and body when armed.
  delete process.env.GHL_ARMED;
  await rejects('addTags() throws when GHL_ARMED is unset', ghl.addTags('c1', ['warm']), 'GHL_ARMED is not "true"');
  process.env.GHL_ARMED = 'true';
  calls.length = 0;
  await resolves('addTags() succeeds when armed', ghl.addTags('c1', ['warm']));
  check('addTags POSTs to /contacts/:id/tags with {tags}', calls[0] && calls[0].url === 'https://services.leadconnectorhq.com/contacts/c1/tags' && JSON.parse(calls[0].body).tags[0] === 'warm');

  // 12. addNote: throws unarmed, correct URL and body when armed.
  delete process.env.GHL_ARMED;
  await rejects('addNote() throws when GHL_ARMED is unset', ghl.addNote('c1', 'called, left voicemail'), 'GHL_ARMED is not "true"');
  process.env.GHL_ARMED = 'true';
  calls.length = 0;
  await resolves('addNote() succeeds when armed', ghl.addNote('c1', 'called, left voicemail'));
  check('addNote POSTs to /contacts/:id/notes with {body}', calls[0] && calls[0].url === 'https://services.leadconnectorhq.com/contacts/c1/notes' && JSON.parse(calls[0].body).body === 'called, left voicemail');

  // 13. listCalendars: locationId in query, no arming needed.
  delete process.env.GHL_ARMED;
  calls.length = 0;
  await resolves('listCalendars() succeeds with no GHL_ARMED (read)', ghl.listCalendars());
  const calUrl = calls[0] && new URL(calls[0].url);
  check('listCalendars GETs /calendars/ with locationId query', calUrl && calUrl.pathname === '/calendars/' && calUrl.searchParams.get('locationId') === 'loc-test-1');

  // 14. freeSlots: correct URL and query, no arming needed.
  calls.length = 0;
  await resolves('freeSlots() succeeds with no GHL_ARMED (read)', ghl.freeSlots('cal-1', { startDate: '2026-09-01', endDate: '2026-09-07', timezone: 'America/Vancouver' }));
  const slotsUrl = calls[0] && new URL(calls[0].url);
  check('freeSlots GETs /calendars/:id/free-slots with date range', slotsUrl && slotsUrl.pathname === '/calendars/cal-1/free-slots' && slotsUrl.searchParams.get('startDate') === '2026-09-01');

  // 15. createAppointment: locationId injected, throws unarmed.
  delete process.env.GHL_ARMED;
  await rejects('createAppointment() throws when GHL_ARMED is unset', ghl.createAppointment({ calendarId: 'cal-1', contactId: 'c1', startTime: '2026-09-01T10:00:00-07:00', title: 'intro call' }), 'GHL_ARMED is not "true"');
  process.env.GHL_ARMED = 'true';
  calls.length = 0;
  await resolves('createAppointment() succeeds when armed', ghl.createAppointment({ calendarId: 'cal-1', contactId: 'c1', startTime: '2026-09-01T10:00:00-07:00', title: 'intro call' }));
  check('createAppointment POSTs to /calendars/events/appointments', calls[0] && calls[0].url === 'https://services.leadconnectorhq.com/calendars/events/appointments');
  check('createAppointment body has locationId injected', calls[0] && JSON.parse(calls[0].body).locationId === 'loc-test-1');

  delete process.env.GHL_ARMED;
  https.request = realRequest;

  console.log(`\n${bad === 0 ? 'ALL PASSED' : `${bad} FAILED`}`);
  process.exit(bad ? 1 : 0);
}

main();
