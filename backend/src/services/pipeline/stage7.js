const { callLLM } = require('../llm/callLLM');
const { SYSTEM_PROMPTS } = require('../../prompts/systemPrompts');
const { autoCloseJSON } = require('../../utils/autoCloseJSON');
const { calculateCoverage } = require('../../utils/calculateCoverage');
const db = require('../../config/db');

/**
 * Stage 7 – Final Content Generation
 * Uses all previous stage results to generate the final SEO-optimised content.
 */
async function run(taskId, context, log) {
  const { task } = context;
  const provider = task.provider || 'deepseek';

  const allData = {
    serp: context.results.stage1?.serp,
    niche: context.results.stage2,
    entities: context.results.stage3,
    commercial: context.results.stage4,
    community: context.results.stage5,
    eeat: context.results.stage6,
  };

  const userPrompt = `Keyword: ${task.keyword}
Niche: ${task.niche || 'not specified'}
Target audience: ${task.target_audience || 'not specified'}
Tone of voice: ${task.tone_of_voice || 'not specified'}
Region: ${task.region || 'not specified'}
Language: ${task.language || 'russian'}
Content type: ${task.content_type || 'article'}
Brand: ${task.brand_name || 'not specified'}
USP: ${task.unique_selling_points || 'not specified'}
Target word count: ${task.word_count_target || 'not specified'}
Additional requirements: ${task.additional_requirements || 'none'}

Full research data:
${JSON.stringify(allData).slice(0, 15000)}`;

  log('Generating final content...');

  const result = await callLLM({
    systemPrompt: SYSTEM_PROMPTS.stage7,
    userPrompt,
    provider,
    maxTokens: 8192,
  });

  let parsed;
  try { parsed = JSON.parse(autoCloseJSON(result.content)); } catch (_e) { parsed = { raw: result.content }; }

  // Calculate LSI keyword coverage if entities are available
  const lsiKeywords = context.results.stage3?.lsi_keywords || [];
  const contentText = parsed.content_html || parsed.raw || '';
  if (lsiKeywords.length > 0 && contentText) {
    parsed.lsi_coverage = calculateCoverage(lsiKeywords, contentText);
  }

  await db.query('UPDATE tasks SET stage7_result = $2 WHERE id = $1', [
    taskId, JSON.stringify(parsed),
  ]);

  log('Content generation completed');
  return parsed;
}

module.exports = { run };
