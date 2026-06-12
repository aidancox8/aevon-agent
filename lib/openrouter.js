const axios = require('axios');
require('dotenv').config();

// OpenRouter gutted most of its free tier (2026-06): all the models below except
// gpt-oss-120b now 404 with "unavailable for free". Pruned to the verified-working
// one plus llama-3.3 (intermittent 429 but recovers). Re-test before adding more.
const OPENROUTER_MODELS = [
  'openai/gpt-oss-120b:free',
  'meta-llama/llama-3.3-70b-instruct:free',
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
