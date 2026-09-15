#!/usr/bin/env node
/**
 * cadre/quota.js, what each free account has left right now, from the accounts themselves.
 *
 * Printed at the top of the daily supply run so the log says what was available before the
 * scripts spent it, and so a month where nothing refilled is visible as a line rather than as a
 * mysterious zero. Services without a balance endpoint are probed with the cheapest call that
 * reveals a quota error (none is charged for a rejected call).
 *
 *   node cadre/quota.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const E = process.env;

const row = (name, text) => console.log(`  ${name.padEnd(12)}${text}`);

(async () => {
  console.log('Free-tier standing:');
  try {
    const r = await fetch('https://api.prospeo.io/account-information', { method: 'POST', headers: { 'X-KEY': E.PROSPEO_KEY, 'Content-Type': 'application/json' }, body: '{}' });
    const j = await r.json(); const x = j.response || {};
    row('prospeo', `${x.remaining_credits} credits left of 100, renews ${String(x.next_quota_renewal_date || '').slice(0, 10)}`);
  } catch (e) { row('prospeo', `unreachable (${e.message})`); }
  try {
    const r = await fetch('https://api.tomba.io/v1/usage', { headers: { 'X-Tomba-Key': E.TOMBA_KEY, 'X-Tomba-Secret': E.TOMBA_SECRET } });
    const j = await r.json(); const d = (j.data || [])[0] || {};
    row('tomba', `${d.search || 0} searches used this period (free plan: 25 a month, 5 a day)`);
  } catch (e) { row('tomba', `unreachable (${e.message})`); }
  try {
    const r = await fetch(`https://api.zerobounce.net/v2/getcredits?api_key=${E.ZEROBOUNCE_KEY}`);
    const j = await r.json();
    row('zerobounce', `${j.Credits} checks left`);
  } catch (e) { row('zerobounce', `unreachable (${e.message})`); }
  try {
    const r = await fetch('https://api.snov.io/v1/oauth/access_token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', client_id: E.SNOV_CLIENT_ID, client_secret: E.SNOV_CLIENT_SECRET }) });
    const tok = (await r.json()).access_token;
    const b = await fetch('https://api.snov.io/v1/get-balance', { headers: { Authorization: `Bearer ${tok}` } });
    const j = await b.json();
    row('snov', `${j.data && j.data.balance != null ? j.data.balance : JSON.stringify(j).slice(0, 80)} credits left of 50`);
  } catch (e) { row('snov', `unreachable (${e.message})`); }
  try {
    // Reoon has no balance call on the free plan; a syntactically invalid address is rejected
    // before any credit is spent, but a 403 still tells us the account is out.
    const r = await fetch(`https://emailverifier.reoon.com/api/v1/verify?email=quota-probe@example.invalid&key=${E.REOON_KEY}&mode=quick`);
    const t = await r.text();
    row('reoon', /not enough credits/i.test(t) ? 'OUT of credit' : `answering (HTTP ${r.status})`);
  } catch (e) { row('reoon', `unreachable (${e.message})`); }
  try {
    const r = await fetch('https://api.getprospect.com/public/v1/email/find?name=Quota%20Probe&company=example.invalid&apiKey=' + E.GETPROSPECT_KEY);
    const t = await r.text();
    row('getprospect', /quota|credit|limit/i.test(t) && r.status !== 404 ? 'OUT of credit' : `answering (HTTP ${r.status})`);
  } catch (e) { row('getprospect', `unreachable (${e.message})`); }
  row('lusha', E.LUSHA_KEY ? 'no balance endpoint; the chain skips it on a 402' : 'no key');
  row('verifalia', E.VERIFALIA_USER && E.VERIFALIA_PASS ? 'configured (25 a day)' : 'not configured: add VERIFALIA_USER and VERIFALIA_PASS');
  row('hunter', 'free plan renews Oct 9');
})();
