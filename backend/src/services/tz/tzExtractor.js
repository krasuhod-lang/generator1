const { callLLM } = require('../llm/callLLM');
const { SYSTEM_PROMPTS } = require('../../prompts/systemPrompts');
const { autoCloseJSON } = require('../../utils/autoCloseJSON');

/**
 * Send extracted text to the LLM and get structured TZ fields back.
 *
 * @param {string} text – raw text extracted from TZ file
 * @returns {Promise<object>} – structured JSON with TZ fields
 */
async function extractFields(text) {
  if (!text || !text.trim()) {
    throw new Error('Empty text provided for TZ extraction');
  }

  // Truncate very long documents to stay within token limits
  const MAX_CHARS = 30000;
  const truncated = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;

  const { content } = await callLLM({
    systemPrompt: SYSTEM_PROMPTS.tzExtractor,
    userPrompt: truncated,
    provider: process.env.TZ_LLM_PROVIDER || 'deepseek',
    temperature: 0.1,
    maxTokens: 2048,
  });

  // Parse the LLM response as JSON
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (_e) {
    // Attempt to repair broken JSON
    const repaired = autoCloseJSON(content);
    parsed = JSON.parse(repaired);
  }

  // Ensure all expected fields exist (set missing ones to null)
  const fields = [
    'keyword', 'niche', 'target_audience', 'tone_of_voice', 'region',
    'language', 'competitor_urls', 'content_type', 'brand_name',
    'unique_selling_points', 'word_count_target', 'additional_requirements',
  ];

  for (const field of fields) {
    if (!(field in parsed)) {
      parsed[field] = null;
    }
  }

  return parsed;
}

module.exports = { extractFields };
