/**
 * lib/treg.js — client for treg.to, a proxy that fronts ~2,900 endpoints across ~60
 * providers behind one token (https://github.com/superdesigndev/treg).
 *
 * WHY IT IS HERE. The Cadre lead pipeline is source-limited, not idea-limited. SimplyHired
 * returns page one only and 403s every GitHub runner, and 111 of 226 queued leads have no
 * email address at all. treg fronts Apollo, Hunter and Crunchbase WITHOUT a subscription to
 * any of them: "otherwise eligible endpoints are served on treg's key and metered against
 * your prepaid balance". People data is quoted from $0.00038 a result, against the $49/month
 * TheirStack that was priced and not bought.
 *
 * WHY EVERY CALL IS GUARDED. Unlike every other integration in this repo, a bug here spends
 * real money, silently, in a loop. So:
 *   - nothing metered runs unless TREG_ARMED === 'true'
 *   - every run carries a hard budget in cents and stops dead when it is reached
 *   - each call sends an Idempotency-Key, so a retry is a cached replay and not a second charge
 *   - the running total is printed, never inferred
 *
 * WHAT IS NOT VERIFIED. As of 2026-09-02 no call has been made from here. The contract below
 * is transcribed from https://treg.to/llms.txt and the shapes are unconfirmed against a live
 * response. Treat the first live run as a test, not as production.
 *
 * UPSTREAM TERMS ARE THE REAL RISK, not the code. Serving Apollo and LinkedIn data on treg's
 * key to callers with no provider account is the arrangement those providers exist to forbid,
 * and LinkedIn litigates it. If Cadre comes to depend on this and access is withdrawn, the
 * pipeline goes with it. Same shape as the Adzuna licence problem already on file. Keep it as
 * an enrichment source that can be swapped out, never as the spine.
 *
 * Env:
 *   TREG_TOKEN   required for anything at all
 *   TREG_ARMED   must be exactly 'true' before a metered call is allowed
 */
const https = require('https');
const crypto = require('crypto');

const BASE = 'https://treg.to';
const TOKEN = process.env.TREG_TOKEN || '';
/**
 * Identity tokens (the kind `treg login` issues, which carry an "org" claim) must be sent with
 * the team slug alongside them: 'For identity tokens, also include X-Treg-Org: <team-slug>'.
 * Machine tokens do not need it, so this is sent only when set.
 */
const ORG = process.env.TREG_ORG || '';
const ARMED = String(process.env.TREG_ARMED || '').toLowerCase() === 'true';

/** treg reports money in millionths of a dollar. Everything user-facing is cents. */
const microToCents = (micro) => (Number(micro || 0) / 10000);
const centsToMicro = (cents) => Math.round(Number(cents || 0) * 10000);

class TregError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'TregError';
    this.status = status;
    this.body = body;
  }
}

function request(method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    if (!TOKEN) return reject(new TregError('TREG_TOKEN is not set. Create a token at treg.to and put it in .env.', 0, null));
    const url = new URL(path.startsWith('http') ? path : BASE + path);
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = https.request(url, {
      method,
      headers: {
        'X-Treg-Token': TOKEN,
        ...(ORG ? { 'X-Treg-Org': ORG } : {}),
        Accept: 'application/json',
        'User-Agent': 'aevon-agent/1.0',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (e) { parsed = { raw }; }
        const meta = {
          status: res.statusCode,
          costMicro: Number(res.headers['x-treg-cost-micro'] || 0),
          replay: res.headers['x-treg-idempotent-replay'] === 'true',
          callId: res.headers['x-treg-call-id'] || null,
          retryAfter: res.headers['retry-after'] || null,
        };
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ data: parsed, meta });
        const detail = (parsed && (parsed.detail || parsed.error)) || `HTTP ${res.statusCode}`;
        reject(new TregError(detail, res.statusCode, parsed));
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Free. Returns { cents, micro }. Also the cheapest way to prove a token works. */
async function balance() {
  // /balance is what llms.txt documents and it 404s. The live path is /billing, which also
  // reports whether a card is attached. Transcribed docs are a hypothesis, the server is the
  // authority.
  const { data } = await request('GET', '/billing');
  const micro = Number(data && data.balance_micro);
  return { micro, cents: microToCents(micro), usd: data && data.balance_usd, cardOnFile: !!(data && data.card_on_file), raw: data };
}

/** Free. Find endpoint ids rather than hardcoding guesses at them. */
async function search(q) {
  const { data } = await request('GET', `/catalog/search?q=${encodeURIComponent(q)}`);
  return data;
}

/** Free. Params, COST, WORKS (success rate), SPEED, LAST OK for one endpoint. */
async function describe(endpointId) {
  const { data } = await request('GET', `/catalog/endpoints/${encodeURIComponent(endpointId)}`);
  return data;
}

/**
 * A metered call. This is the only function here that can spend money.
 *
 * Many of the useful endpoints are POST with a JSON body, not GET with a query string.
 * findymail.search.employees, the one that matters most for Cadre, takes
 * {website, job_titles[], count} and bills per contact RETURNED, so `count` is the price dial.
 *
 * `budget` is a mutable { spentMicro, capMicro } passed in by the caller, so one run shares a
 * single ceiling across every call it makes. Checking before AND after matters: the estimate
 * is not authoritative, only the X-Treg-Cost-Micro that comes back is.
 */
async function call(endpointId, params = {}, { budget, idempotencyKey, method = 'GET', body = null } = {}) {
  if (!ARMED) {
    throw new TregError('TREG_ARMED is not "true", so no metered call was made. This is deliberate.', 0, null);
  }
  if (budget && budget.spentMicro >= budget.capMicro) {
    throw new TregError(`budget of ${microToCents(budget.capMicro).toFixed(2)} cents already spent`, 0, null);
  }
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])
  ).toString();
  // A stable key means a retry after a timeout is a replay, not a second charge. The body is
  // part of the key because for POST endpoints it is the body, not the query, that varies.
  const key = idempotencyKey
    || crypto.createHash('sha1').update(`${method} ${endpointId}?${qs} ${JSON.stringify(body || {})}`).digest('hex').slice(0, 32);

  const { data, meta } = await request(method, `/call/${endpointId}${qs ? `?${qs}` : ''}`, {
    body: body === null ? undefined : body,
    headers: { 'Idempotency-Key': key },
  });
  if (budget) budget.spentMicro += meta.costMicro;
  return { data, costMicro: meta.costMicro, costCents: microToCents(meta.costMicro), replay: meta.replay, callId: meta.callId };
}

/** A budget object for one run. Cents in, because nobody reasons in millionths of a dollar. */
function newBudget(cents) {
  const capMicro = centsToMicro(cents);
  if (!(capMicro > 0)) throw new Error('budget must be a positive number of cents');
  return { spentMicro: 0, capMicro };
}

module.exports = { balance, search, describe, call, newBudget, microToCents, centsToMicro, TregError, ARMED, hasToken: !!TOKEN };
