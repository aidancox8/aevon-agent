const axios = require('axios');
require('dotenv').config();

/**
 * OpenRouter free-model stack, with memory.
 *
 * The old loop had no memory: on a 429 it slept 5s, retried the same model, then walked every
 * remaining model in order, and did the same walk again for the next lead. On a busy evening
 * that was 30 to 60 seconds of failed calls per lead, and the log filled with "exhausted".
 *
 * This one keeps per-model state for the run. A model that fails goes on cooldown (escalating,
 * 45s to 4 min); a model that is delisted or refuses the key is dead for the run; the model
 * that answered last is tried first next time. Empty or reasoning-leaked answers count as
 * failures, because several free models spend the whole token budget thinking and return "".
 *
 * ORDER IS MEASURED, NOT GUESSED. Benchmarked 2026-09-04 on the real email prompt, two calls
 * each (cadre/batches/openrouter-bench-2026-09-04.json). Dropped: thinkingmachines/inkling and
 * inkling-small (403, only on their own plan), nvidia/nemotron-3.5-lightning (hung 156s, then
 * leaked 600 words of reasoning), dots-studio/dots-3-note-preview (empty both times),
 * poolside/laguna-xs (empty). Meta has no free model on OpenRouter at all as of that date.
 *
 * Limits for this key (docs, 2026-09-04): 20 requests/min on free models, 1,000/day because the
 * account has bought at least $10 of credits. The gap below keeps us at ~18/min.
 */
const OPENROUTER_MODELS = [
  'z-ai/glm-5.2:free',                                 // 150ms, 40w, both trials
  'nvidia/nemotron-3-super-120b-a12b:free',            // 160ms, both trials
  'nvidia/nemotron-3-ultra-550b-a55b:free',            // 300-750ms, both trials
  'minimax/minimax-m3:free',                           // 700-1000ms, both trials
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',// 190ms, both trials
  'poolside/laguna-s-2.1:free',                        // 700-1100ms, both trials
  'inclusionai/ling-3.0-flash-sante:free',             // 550ms, both trials
  'minimax/minimax-m2.7:free',                         // empty 1 of 2
  'inclusionai/ling-3.0-flash-fin:free',               // empty 1 of 2
  'openrouter/free',                                   // their router, whatever has capacity
  'google/gemma-4-31b-it:free',                        // 429 from provider, both trials
  'google/gemma-4-26b-a4b-it:free',                    // 429 from provider, both trials
];

const OPENROUTER_MIN_GAP = 3300;   // ~18 requests/min against a 20/min cap
const REQUEST_TIMEOUT = 30000;
const MAX_WAIT_ALL_COOLING = 60000;
const GIVE_UP_AFTER = 5 * 60000;   // per prompt

let lastOpenRouterAt = 0;
/** Per-model run state: { coolUntil, failures, dead } */
const state = new Map(OPENROUTER_MODELS.map((m) => [m, { coolUntil: 0, failures: 0, dead: null }]));
let preferred = OPENROUTER_MODELS[0];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cooldownFor(failures) {
  return Math.min(45000 * Math.pow(2, failures - 1), 240000);
}

/** Models worth trying right now, preferred first, then list order. */
function candidates(now) {
  const live = OPENROUTER_MODELS.filter((m) => { const s = state.get(m); return !s.dead && s.coolUntil <= now; });
  return live.includes(preferred) ? [preferred, ...live.filter((m) => m !== preferred)] : live;
}

function nextWake(now) {
  const times = OPENROUTER_MODELS.map((m) => state.get(m)).filter((s) => !s.dead).map((s) => s.coolUntil - now).filter((t) => t > 0);
  return times.length ? Math.min(...times) : null;
}

/** Content that is not an answer: empty, or a reasoning transcript that escaped. */
function unusable(text) {
  if (!text) return 'empty';
  if (/<think|thinking process:|^\s*\*\*analy/i.test(text)) return 'leaked reasoning';
  return null;
}

async function callModel(model, prompt) {
  const gap = Date.now() - lastOpenRouterAt;
  if (gap < OPENROUTER_MIN_GAP) await sleep(OPENROUTER_MIN_GAP - gap);
  lastOpenRouterAt = Date.now();
  const { data } = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    { model, messages: [{ role: 'user', content: prompt }], temperature: 0.7, max_tokens: 1200 },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://aevon.ca',
        'X-Title': 'Aevon Outreach',
      },
      timeout: REQUEST_TIMEOUT,
    }
  );
  // OpenRouter returns 200 with an error body for some provider failures.
  if (data.error) { const e = new Error(data.error.message || 'provider error'); e.response = { status: data.error.code || 503 }; throw e; }
  return String((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
}

function markFailure(model, why) {
  const s = state.get(model);
  s.failures += 1;
  s.coolUntil = Date.now() + cooldownFor(s.failures);
  console.warn(`OpenRouter ${model} ${why}, cooling ${Math.round(cooldownFor(s.failures) / 1000)}s`);
}

function markDead(model, why) {
  state.get(model).dead = why;
  console.warn(`OpenRouter ${model} ${why}, skipping for the rest of the run`);
}

async function generateViaOpenRouter(prompt) {
  const started = Date.now();
  for (;;) {
    const now = Date.now();
    if (now - started > GIVE_UP_AFTER) throw new Error('All OpenRouter models exhausted (5 min)');
    const list = candidates(now);
    if (!list.length) {
      const wake = nextWake(now);
      if (wake === null) throw new Error('All OpenRouter models exhausted (every model dead)');
      const wait = Math.min(wake, MAX_WAIT_ALL_COOLING);
      console.warn(`OpenRouter: every model cooling, waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    for (const model of list) {
      try {
        const text = await callModel(model, prompt);
        const bad = unusable(text);
        if (bad) { markFailure(model, `returned ${bad}`); continue; }
        state.get(model).failures = 0;
        preferred = model;
        return text;
      } catch (err) {
        const status = err.response && err.response.status;
        if (status === 401) throw err;                         // bad key: nothing will work
        if ([400, 402, 403, 404].includes(status)) { markDead(model, `HTTP ${status}`); continue; }
        markFailure(model, status ? `HTTP ${status}` : (err.code || err.message).slice(0, 40));
      }
    }
    // Every candidate failed this pass; the loop re-evaluates cooldowns and waits if needed.
  }
}

/** For tests and diagnostics. */
function stackStatus() {
  const now = Date.now();
  return OPENROUTER_MODELS.map((m) => { const s = state.get(m); return { model: m, dead: s.dead, coolingFor: Math.max(0, Math.round((s.coolUntil - now) / 1000)), failures: s.failures, preferred: m === preferred }; });
}

module.exports = { generateViaOpenRouter, stackStatus, OPENROUTER_MODELS };
