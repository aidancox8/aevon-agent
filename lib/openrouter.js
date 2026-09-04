const axios = require('axios');
require('dotenv').config();

// All currently-live OpenRouter free TEXT/instruct models (pulled from the live
// /models list 2026-06), ordered by capability. The generate loop tries the next
// on any failure, so a long list is pure fallback resilience. Audio (lyria),
// vision (*-vl), and sub-2B toy models are excluded; they can't reliably score leads.
const OPENROUTER_MODELS = [
  // Re-pulled from the live /models list 2026-08-31. Five of the previous eight slugs were
  // dead (404), so the chain spent every call walking corpses: the first model would hit a
  // capacity limit, and every fallback after it was gone. That surfaced as "all models
  // exhausted" and zero copy written, which reads like a quota problem rather than a stale
  // config. Re-check this list when generation starts failing wholesale.
  // Ordered by capability. Vision, code, safety and sub-3B models are excluded: they cannot
  // reliably write a short persuasive email.
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'z-ai/glm-5.2:free',
  'minimax/minimax-m3:free',
  'thinkingmachines/inkling:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'google/gemma-4-31b-it:free',
  'poolside/laguna-s-2.1:free',
  'inclusionai/ling-3.0-flash-fin:free',
  'minimax/minimax-m2.7:free',
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-3.5-lightning:free',
  'thinkingmachines/inkling-small:free',
  // Added 2026-09-04 from the live list (22 free models that day, none from Meta). laguna-xs
  // was tested and left out: it spends its whole token budget reasoning and returns nothing.
  'dots-studio/dots-3-note-preview:free',
  'inclusionai/ling-3.0-flash-sante:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  // OpenRouter's own router over whatever free model has capacity. Last, as the catch-all.
  'openrouter/free',
];

const OPENROUTER_MIN_GAP = 4000; // ~15 RPM to stay under free tier limits
let lastOpenRouterAt = 0;

async function generateViaOpenRouter(prompt, modelIndex = 0, attempt = 0) {
  if (modelIndex >= OPENROUTER_MODELS.length) throw new Error('All OpenRouter models exhausted');
  const model = OPENROUTER_MODELS[modelIndex];

  const gap = Date.now() - lastOpenRouterAt;
  if (gap < OPENROUTER_MIN_GAP) await new Promise(r => setTimeout(r, OPENROUTER_MIN_GAP - gap));
  lastOpenRouterAt = Date.now();

  try {
    const { data } = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://aevon.ca',
          'X-Title': 'Aevon Outreach',
        },
        timeout: 30000,
      }
    );
    return data.choices[0].message.content.trim();
  } catch (err) {
    const status = err.response?.status;
    // 401 = bad key: no model will work, fail loudly.
    if (status === 401) throw err;
    const isTransient = status === 429 || status === 503 || err.code === 'ECONNABORTED';

    // Non-transient (404 delisted slug, 400, 402 needs credits...): this model is
    // dead for us — skip straight to the next one instead of killing the chain.
    if (!isTransient) {
      console.warn(`OpenRouter ${model} failed (${status || err.code}), trying next...`);
      return generateViaOpenRouter(prompt, modelIndex + 1, 0);
    }

    if (attempt < 1) {
      console.warn(`OpenRouter ${model} unavailable, retrying in 5s...`);
      await new Promise(r => setTimeout(r, 5000));
      return generateViaOpenRouter(prompt, modelIndex, attempt + 1);
    }

    console.warn(`OpenRouter ${model} exhausted, trying next...`);
    return generateViaOpenRouter(prompt, modelIndex + 1, 0);
  }
}

module.exports = { generateViaOpenRouter };
