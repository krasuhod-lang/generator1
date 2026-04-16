const axios = require('axios');

/**
 * Call the Gemini API.
 *
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {string} opts.userPrompt
 * @param {number} opts.temperature
 * @param {number} opts.maxTokens
 * @returns {Promise<{content: string, usage: {promptTokens: number, completionTokens: number, totalTokens: number}}>}
 */
async function callGemini({ systemPrompt, userPrompt, temperature, maxTokens }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set');
  }

  const model = 'gemini-2.0-flash';
  const defaultBase = 'https://generativelanguage.googleapis.com/v1beta/models';
  const baseUrl = process.env.GEMINI_BASE_URL || defaultBase;
  const url = `${baseUrl}/${model}:generateContent?key=${apiKey}`;

  const axiosConfig = {
    headers: { 'Content-Type': 'application/json' },
    timeout: 120000,
  };

  // Proxy support
  const proxyUrl = process.env.HTTPS_PROXY;
  if (proxyUrl) {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    axiosConfig.httpsAgent = new HttpsProxyAgent(proxyUrl);
  }

  const body = {
    system_instruction: {
      parts: [{ text: systemPrompt }],
    },
    contents: [
      {
        parts: [{ text: userPrompt }],
      },
    ],
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
    },
  };

  const response = await axios.post(url, body, axiosConfig);

  const candidate = response.data.candidates?.[0];
  if (!candidate) {
    throw new Error('Gemini returned no candidates');
  }

  const content = candidate.content?.parts?.map((p) => p.text).join('') || '';
  const meta = response.data.usageMetadata || {};

  return {
    content,
    usage: {
      promptTokens: meta.promptTokenCount || 0,
      completionTokens: meta.candidatesTokenCount || 0,
      totalTokens: meta.totalTokenCount || 0,
    },
  };
}

module.exports = { callGemini };
