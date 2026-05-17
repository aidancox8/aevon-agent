const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const primary = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });
const fallback = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

async function generate(prompt, useFallback = false) {
  const model = useFallback ? fallback : primary;
  try {
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (err) {
    if (!useFallback && (err.message.includes('429') || err.message.includes('503'))) {
      console.warn(`Primary model unavailable (${err.message.match(/\d{3}/)?.[0] ?? 'err'}), falling back to gemini-2.5-flash`);
      return generate(prompt, true);
    }
    throw err;
  }
}

module.exports = { generate };
