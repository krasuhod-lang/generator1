const axios = require('axios');

/**
 * Call the DeepSeek Chat API.
 *
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {string} opts.userPrompt
 * @param {number} opts.temperature
 * @param {number} opts.maxTokens
 * @returns {Promise<{content: string, usage: {promptTokens: number, completionTokens: number, totalTokens: number}}>}
 */
async function callDeepSeek({ systemPrompt, userPrompt, temperature, maxTokens }) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY is not set');
  }

  const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  const url = `${baseUrl}/chat/completions`;

  const response = await axios.post(
    url,
    {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature,
      max_tokens: maxTokens,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      timeout: 120000,
    }
  );

  const choice = response.data.choices?.[0];
  if (!choice) {
    throw new Error('DeepSeek returned no choices');
  }

  const usage = response.data.usage || {};

  return {
    content: choice.message?.content || '',
    usage: {
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || 0,
    },
  };
}

module.exports = { callDeepSeek };
