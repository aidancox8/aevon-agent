const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const primary = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });
const fallback = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

async function generate(prompt, useFallback = false, attempt = 0) {
  const model = useFallback ? fallback : primary;
  try {
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (err) {
    const isTransient = err.message.includes('429') || err.message.includes('503');
    if (!isTransient) throw err;

    // Retry primary up to 3x with backoff before touching the fallback
    if (!useFallback && attempt < 3) {
      const wait = (attempt + 1) * 15000;
      console.warn(`Primary unavailable (attempt ${attempt + 1}/3), retrying in ${wait / 1000}s...`);
      await new Promise(r => setTimeout(r, wait));
      return generate(prompt, false, attempt + 1);
    }

    if (!useFallback) {
      console.warn(`Primary exhausted retries, falling back to gemini-2.5-flash`);
      return generate(prompt, true, 0);
    }

    throw err;
  }
}

module.exports = { generate };
