// Approximate per-token pricing (USD) as of 2024
const PRICING = {
  deepseek: {
    prompt: 0.00000014, // $0.14 per 1M tokens
    completion: 0.00000028, // $0.28 per 1M tokens
  },
  gemini: {
    prompt: 0.000000075, // Gemini 2.0 Flash pricing
    completion: 0.0000003,
  },
};

/**
 * Calculate cost in USD for a given number of tokens.
 *
 * @param {{ promptTokens: number, completionTokens: number }} tokens
 * @param {string} [provider='deepseek']
 * @returns {number} cost in USD
 */
function calculateCost(tokens, provider = 'deepseek') {
  const prices = PRICING[provider] || PRICING.deepseek;
  const promptCost = (tokens.promptTokens || 0) * prices.prompt;
  const completionCost = (tokens.completionTokens || 0) * prices.completion;
  return promptCost + completionCost;
}

/**
 * Format USD cost as a human-readable string.
 *
 * @param {number} usd
 * @returns {string}
 */
function formatCost(usd) {
  if (usd < 0.01) {
    return `$${(usd * 100).toFixed(4)}¢`;
  }
  return `$${usd.toFixed(4)}`;
}

module.exports = { calculateCost, formatCost };
