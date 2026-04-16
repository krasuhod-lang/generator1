const { callLLM } = require('../llm/callLLM');
const { SYSTEM_PROMPTS } = require('../../prompts/systemPrompts');
const { autoCloseJSON } = require('../../utils/autoCloseJSON');
const db = require('../../config/db');

/**
 * Stage 4 – Commercial Intent & Conversion Mapping
 */
async function run(taskId, context, log) {
  const { task } = context;
  const provider = task.provider || 'deepseek';

  const userPrompt = `Keyword: ${task.keyword}
Niche: ${task.niche || 'not specified'}
Target audience: ${task.target_audience || 'not specified'}
Content type: ${task.content_type || 'not specified'}
Brand: ${task.brand_name || 'not specified'}
USP: ${task.unique_selling_points || 'not specified'}
SERP analysis: ${JSON.stringify(context.results.stage1?.serp || {}).slice(0, 4000)}`;

  log('Analysing commercial intent...');

  const result = await callLLM({
    systemPrompt: SYSTEM_PROMPTS.commercialIntent,
    userPrompt,
    provider,
  });

  let parsed;
  try { parsed = JSON.parse(autoCloseJSON(result.content)); } catch (_e) { parsed = { raw: result.content }; }

  await db.query('UPDATE tasks SET stage4_result = $2 WHERE id = $1', [
    taskId, JSON.stringify(parsed),
  ]);

  log('Commercial intent analysis completed');
  return parsed;
}

module.exports = { run };
