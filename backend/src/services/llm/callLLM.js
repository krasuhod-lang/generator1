const { callDeepSeek } = require('./deepseek.adapter');
const { callGemini } = require('./gemini.adapter');

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

/**
 * Route an LLM call to the appropriate provider with retry logic.
 *
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {string} opts.userPrompt
 * @param {string} [opts.provider='deepseek'] – 'deepseek' | 'gemini'
 * @param {number} [opts.temperature=0.7]
 * @param {number} [opts.maxTokens=4096]
 * @returns {Promise<{content: string, usage: {promptTokens: number, completionTokens: number, totalTokens: number}}>}
 */
async function callLLM({ systemPrompt, userPrompt, provider = 'deepseek', temperature = 0.7, maxTokens = 4096 }) {
  const adapter = provider === 'gemini' ? callGemini : callDeepSeek;

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await adapter({ systemPrompt, userPrompt, temperature, maxTokens });
      return result;
    } catch (err) {
      lastError = err;
      console.error(`[callLLM] Attempt ${attempt}/${MAX_RETRIES} failed (${provider}):`, err.message);

      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw new Error(`[callLLM] All ${MAX_RETRIES} attempts failed for provider "${provider}": ${lastError.message}`);
}

module.exports = { callLLM };
