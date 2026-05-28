const { GoogleGenerativeAI } = require('@google/generative-ai');
const { generateViaOpenRouter } = require('./openrouter');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const MODEL_NAMES = [
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
];

const MODELS = MODEL_NAMES.map(m => genAI.getGenerativeModel({ model: m }));

let minModelIndex = 0; // permanently skip models exhausted during this run

async function generate(prompt, modelIndex, attempt = 0) {
  if (modelIndex === undefined) modelIndex = minModelIndex;
  if (modelIndex < minModelIndex) modelIndex = minModelIndex;

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

    console.warn(`${MODEL_NAMES[modelIndex]} exhausted, skipping for this run...`);
    minModelIndex = Math.max(minModelIndex, modelIndex + 1);
    return generate(prompt, minModelIndex, 0);
  }
}

module.exports = { generate };
