const axios = require('axios');
require('dotenv').config();

const OPENROUTER_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'openai/gpt-oss-120b:free',
  'deepseek/deepseek-v4-flash:free',
];

async function generateViaOpenRouter(prompt, modelIndex = 0, attempt = 0) {
  if (modelIndex >= OPENROUTER_MODELS.length) throw new Error('All OpenRouter models exhausted');
  const model = OPENROUTER_MODELS[modelIndex];
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

    if (attempt < 2) {
      const wait = (attempt + 1) * 15000;
      console.warn(`OpenRouter ${model} unavailable (attempt ${attempt + 1}/2), retrying in ${wait / 1000}s...`);
      await new Promise(r => setTimeout(r, wait));
      return generateViaOpenRouter(prompt, modelIndex, attempt + 1);
    }

    console.warn(`OpenRouter ${model} exhausted, trying next...`);
    return generateViaOpenRouter(prompt, modelIndex + 1, 0);
  }
}

module.exports = { generateViaOpenRouter };
