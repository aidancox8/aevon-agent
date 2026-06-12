const axios = require('axios');
require('dotenv').config();

// All currently-live OpenRouter free TEXT/instruct models (pulled from the live
// /models list 2026-06), ordered by capability. The generate loop tries the next
// on any failure, so a long list is pure fallback resilience. Audio (lyria),
// vision (*-vl), and sub-2B toy models are excluded; they can't reliably score leads.
const OPENROUTER_MODELS = [
  'openai/gpt-oss-120b:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nousresearch/hermes-3-llama-3.1-405b:free',
  'openai/gpt-oss-20b:free',
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-3-nano-30b-a3b:free',
  'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
  'meta-llama/llama-3.2-3b-instruct:free',
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
    const isTransient = status === 429 || status === 503 || err.code === 'ECONNABORTED';
    if (!isTransient) throw err;

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
