/**
 * cadre/verify.js, one verifier behind three free accounts.
 *
 * Reoon, ZeroBounce and Verifalia each give a small free allowance and each says "out" in its
 * own way (Reoon a 403 with "Not enough credits", ZeroBounce a getcredits of 0, Verifalia a 402).
 * The scripts that guess or discover an address must never treat "the verifier is out" as "the
 * address is bad": on 2026-09-15 the format guesser wrote "none of 6 formats verified" on 41 leads
 * while Reoon was returning 403 on every call. So this module returns exactly one of three things,
 * a verdict, "catch-all", or NoVerifier, and callers stop rather than write on the third.
 *
 * Order: Reoon (cheapest, detects catch-all) then ZeroBounce then Verifalia. A service that
 * reports itself out is skipped for the rest of the process.
 */
const REOON_KEY = process.env.REOON_KEY;
const ZB_KEY = process.env.ZEROBOUNCE_KEY;
const VF_USER = process.env.VERIFALIA_USER;   // Verifalia accepts username:password or a browser app key
const VF_PASS = process.env.VERIFALIA_PASS;

class NoVerifier extends Error {}

const dead = { reoon: !REOON_KEY, zerobounce: !ZB_KEY, verifalia: !(VF_USER && VF_PASS) };
const used = { reoon: 0, zerobounce: 0, verifalia: 0 };

async function reoon(email) {
  const r = await fetch(`https://emailverifier.reoon.com/api/v1/verify?email=${encodeURIComponent(email)}&key=${REOON_KEY}&mode=power`);
  const j = await r.json().catch(() => ({}));
  if (r.status === 403 || /not enough credits|recharge/i.test(JSON.stringify(j))) { dead.reoon = true; return null; }
  if (!r.ok) return null;
  used.reoon++;
  if (j.is_catch_all === true) return { ok: false, catchAll: true, via: 'reoon' };
  return { ok: j.is_deliverable === true, catchAll: false, via: 'reoon' };
}

async function zerobounce(email) {
  const r = await fetch(`https://api.zerobounce.net/v2/validate?api_key=${ZB_KEY}&email=${encodeURIComponent(email)}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) { if (/credit|limit/i.test(JSON.stringify(j))) dead.zerobounce = true; return null; }
  used.zerobounce++;
  if (j.status === 'catch-all') return { ok: false, catchAll: true, via: 'zerobounce' };
  if (j.status === 'valid') return { ok: true, catchAll: false, via: 'zerobounce' };
  if (j.status === 'invalid' || j.status === 'spamtrap' || j.status === 'abuse' || j.status === 'do_not_mail') return { ok: false, catchAll: false, via: 'zerobounce' };
  return null; // unknown: no opinion
}

/**
 * Verifalia v2.6: submit one entry, poll until completed, read the classification.
 * Shape transcribed from the docs on 2026-09-15 and not yet exercised against a live account;
 * the first live run is a test. Classification 'Deliverable' | 'Undeliverable' | 'Risky' |
 * 'Unknown'; a catch-all shows as Risky with status 'CatchAllConnectionFailure' or similar.
 */
async function verifalia(email) {
  const auth = 'Basic ' + Buffer.from(`${VF_USER}:${VF_PASS}`).toString('base64');
  let r = await fetch('https://api.verifalia.com/v2.6/email-validations', {
    method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [{ inputData: email }] }),
  });
  if (r.status === 402 || r.status === 429) { dead.verifalia = true; return null; }
  if (!r.ok) return null;
  let j = await r.json();
  const id = j.overview && j.overview.id;
  for (let i = 0; i < 10 && id && j.overview.status !== 'Completed'; i++) {
    await new Promise((res) => setTimeout(res, 2000));
    r = await fetch(`https://api.verifalia.com/v2.6/email-validations/${id}`, { headers: { Authorization: auth } });
    if (!r.ok) return null;
    j = await r.json();
  }
  const e = j.entries && j.entries.data && j.entries.data[0];
  if (!e) return null;
  used.verifalia++;
  if (/catchall|catch-all/i.test(e.status || '')) return { ok: false, catchAll: true, via: 'verifalia' };
  if (e.classification === 'Deliverable') return { ok: true, catchAll: false, via: 'verifalia' };
  if (e.classification === 'Undeliverable') return { ok: false, catchAll: false, via: 'verifalia' };
  return null;
}

/** Returns {ok, catchAll, via}. Throws NoVerifier when every configured service is out. */
async function verify(email) {
  for (const [name, fn] of [['reoon', reoon], ['zerobounce', zerobounce], ['verifalia', verifalia]]) {
    if (dead[name]) continue;
    let v = null;
    try { v = await fn(email); } catch (e) { v = null; }
    if (v) return v;
    if (dead[name]) continue;       // this service just reported itself out, try the next
    // no opinion from a live service: try the next one for a verdict
  }
  if (dead.reoon && dead.zerobounce && dead.verifalia) throw new NoVerifier('every verifier is out of credit');
  return null; // services alive but none had a verdict
}

function status() { return { dead: { ...dead }, used: { ...used } }; }

module.exports = { verify, NoVerifier, status };
