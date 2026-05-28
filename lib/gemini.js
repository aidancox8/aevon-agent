const { GoogleGenerativeAI } = require('@google/generative-ai');
const { generateViaOpenRouter } = require('./openrouter');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const MODEL_NAMES = [
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
];

const MODELS = MODEL_NAMES.map(m => genAI.getGenerativeModel({ model: m }));

const MODEL_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
const modelCooldowns = new Map(); // modelIndex -> resume timestamp

async function generate(prompt, modelIndex, attempt = 0) {
  if (modelIndex === undefined) {
    modelIndex = 0;
    // Skip any models still in cooldown
    while (modelIndex < MODELS.length && (modelCooldowns.get(modelIndex) || 0) > Date.now()) {
      modelIndex++;
    }
  }

  if (modelIndex >= MODELS.length) {
    console.warn('All Gemini models exhausted, falling back to OpenRouter...');
    return generateViaOpenRouter(prompt);
  }
  try {
    const result = await MODELS[modelIndex].generateContent(prompt);
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
    modelCooldowns.set(modelIndex, Date.now() + MODEL_COOLDOWN_MS);
    return generate(prompt, modelIndex + 1, 0);
  }
}

module.exports = { generate };
