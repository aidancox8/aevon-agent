const { GoogleGenerativeAI } = require('@google/generative-ai');
const { generateViaOpenRouter } = require('./openrouter');
require('dotenv').config();

const MODEL_NAMES = [
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
];

const MODEL_COOLDOWN_MS = 10 * 60 * 1000;

function createGenerate(apiKey) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const models = MODEL_NAMES.map(m => genAI.getGenerativeModel({ model: m }));
  const cooldowns = new Map();

  return async function generate(prompt, modelIndex, attempt = 0) {
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
      const result = await models[modelIndex].generateContent(prompt);
      return result.response.text().trim();
    } catch (err) {
      const isTransient = err.message.includes('429') || err.message.includes('503');
      if (!isTransient) throw err;

      if (attempt < 1) {
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

module.exports = { generate, createGenerate };
