const { GoogleGenerativeAI } = require('@google/generative-ai');
const { generateViaOpenRouter } = require('./openrouter');
require('dotenv').config();

const MODEL_NAMES = [
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash',
];
// gemini-2.5-flash-lite was removed 2026-08-24: the API now returns
// "no longer available to new users, use models/gemini-3.5-flash-lite".

const MODEL_COOLDOWN_MS = 10 * 60 * 1000;
const GEMINI_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS || '8000', 10);

/**
 * Account-level failures are not per-model failures.
 *
 * On 2026-08-24 the Gemini prepayment credits ran out and EVERY model started returning 429
 * "Your prepayment credits are depleted". The retry logic read that as transient, so each call
 * burned three models times two attempts with 5s sleeps, roughly 30 seconds, before falling
 * through to OpenRouter, which worked fine the whole time. Across a personalizer run of 25
 * leads that is twelve wasted minutes and a lot of noise hiding the real cause.
 *
 * Detect it once, then skip Gemini for the rest of the process.
 */
let accountDead = null;
const ACCOUNT_FAILURES = [
  { re: /prepayment credits are depleted|billing/i, why: 'Gemini prepayment credits are depleted' },
  { re: /API key not valid|API_KEY_INVALID|PERMISSION_DENIED/i, why: 'Gemini API key is not valid' },
];
function accountFailureReason(msg) {
  for (const f of ACCOUNT_FAILURES) if (f.re.test(msg)) return f.why;
  return null;
}

function createGenerate(apiKey) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const models = MODEL_NAMES.map(m => genAI.getGenerativeModel({ model: m }));
  const cooldowns = new Map();

  /**
   * HEDGED mode, for anything a person is watching. Measured 2026-09-09: flash-lite answers in
   * 0.5 to 1.9s, then stalls past 8s on one call in four with no pattern. Waiting the timeout
   * and trying the next model cost the Front Desk demo 22 to 46 seconds on the first turn.
   * Instead, fire the first two Gemini models a second apart and take whichever answers first;
   * if neither has by 6s, OpenRouter joins the race. Costs at most two extra cheap calls, and
   * the slow one is abandoned rather than waited on. Batch jobs keep the sequential path.
   */
  async function hedged(prompt) {
    let settled = false;
    const timers = [];
    const one = (i) => models[i].generateContent(prompt).then((r) => r.response.text().trim());
    // Late starters are skipped once an answer is in, and their timers are cleared, so the
    // process is free to exit the moment the caller is done rather than 30s later.
    const after = (ms, fn) => new Promise((resolve, reject) => {
      timers.push(setTimeout(() => { if (settled) return resolve(new Promise(() => {})); fn().then(resolve, reject); }, ms));
    });
    const racers = [one(0), after(1000, () => one(1)), after(6000, () => generateViaOpenRouter(prompt))];
    try {
      const text = await Promise.any(racers);
      return text;
    } catch (agg) {
      throw (agg.errors && agg.errors[0]) || agg;
    } finally {
      settled = true;
      for (const t of timers) clearTimeout(t);
    }
  }

  return async function generate(prompt, modelIndex, attempt = 0) {
    if (accountDead) return generateViaOpenRouter(prompt);
    if (modelIndex === undefined && process.env.GEMINI_HEDGE === '1') return hedged(prompt);
    if (modelIndex === undefined) {
      modelIndex = 0;
      while (modelIndex < models.length && (cooldowns.get(modelIndex) || 0) > Date.now()) {
        modelIndex++;
      }
    }

    if (modelIndex >= models.length) {
      console.warn('All Gemini models exhausted, falling back to OpenRouter...');
      return generateViaOpenRouter(prompt);
    }

    try {
      // A hung connection used to cost 30s before anything else was tried, and the Front Desk
      // demo showed a minute of spinner for it (2026-09-09). Measured flash-lite latency is 0.5 to
      // 1.9s, so anything past the deadline is a stuck socket, not a slow model.
      const result = await Promise.race([
        models[modelIndex].generateContent(prompt),
        new Promise((_, reject) => setTimeout(() => reject(new Error('gemini timeout 503')), GEMINI_TIMEOUT_MS)),
      ]);
      return result.response.text().trim();
    } catch (err) {
      const dead = accountFailureReason(err.message);
      if (dead) {
        if (!accountDead) console.warn(`${dead}. Skipping Gemini for the rest of this run, using OpenRouter.`);
        accountDead = dead;
        return generateViaOpenRouter(prompt);
      }
      const isTransient = err.message.includes('429') || err.message.includes('503');
      if (!isTransient) throw err;

      if (attempt < 1 && !/timeout/.test(err.message)) {
        console.warn(`${MODEL_NAMES[modelIndex]} unavailable, retrying in 5s...`);
        await new Promise(r => setTimeout(r, 5000));
        return generate(prompt, modelIndex, attempt + 1);
      }

      console.warn(`${MODEL_NAMES[modelIndex]} on cooldown for 10min, trying next...`);
      cooldowns.set(modelIndex, Date.now() + MODEL_COOLDOWN_MS);
      return generate(prompt, modelIndex + 1, 0);
    }
  };
}

const generate = createGenerate(process.env.GEMINI_API_KEY);

module.exports = { generate, createGenerate, accountFailureReason };
