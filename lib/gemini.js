const { GoogleGenerativeAI } = require('@google/generative-ai');
const { generateViaOpenRouter } = require('./openrouter');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const MODEL_NAMES = [
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
];

const MODELS = MODEL_NAMES.map(m => genAI.getGenerativeModel({ model: m }));

async function generate(prompt, modelIndex = 0, attempt = 0) {
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

    if (attempt < 2) {
      const wait = (attempt + 1) * 15000;
      console.warn(`${MODEL_NAMES[modelIndex]} unavailable (attempt ${attempt + 1}/2), retrying in ${wait / 1000}s...`);
      await new Promise(r => setTimeout(r, wait));
      return generate(prompt, modelIndex, attempt + 1);
    }

    console.warn(`${MODEL_NAMES[modelIndex]} exhausted, trying next...`);
    return generate(prompt, modelIndex + 1, 0);
  }
}

module.exports = { generate };
