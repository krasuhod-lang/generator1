const { callLLM } = require('../llm/callLLM');
const { SYSTEM_PROMPTS } = require('../../prompts/systemPrompts');
const { autoCloseJSON } = require('../../utils/autoCloseJSON');
const db = require('../../config/db');

/**
 * Stage 6 – E-E-A-T Trust Scanner
 */
async function run(taskId, context, log) {
  const { task } = context;
  const provider = task.provider || 'deepseek';

  const allPreviousData = {
    serp: context.results.stage1?.serp,
    niche: context.results.stage2,
    entities: context.results.stage3,
    commercial: context.results.stage4,
    community: context.results.stage5,
  };

  const userPrompt = `Keyword: ${task.keyword}
Niche: ${task.niche || 'not specified'}
Content type: ${task.content_type || 'not specified'}
Brand: ${task.brand_name || 'not specified'}
Previous analyses: ${JSON.stringify(allPreviousData).slice(0, 10000)}`;

  log('Running E-E-A-T trust scan...');

  const result = await callLLM({
    systemPrompt: SYSTEM_PROMPTS.eeatTrustScanner,
    userPrompt,
    provider,
  });

  let parsed;
  try { parsed = JSON.parse(autoCloseJSON(result.content)); } catch (_e) { parsed = { raw: result.content }; }

  await db.query('UPDATE tasks SET stage6_result = $2 WHERE id = $1', [
    taskId, JSON.stringify(parsed),
  ]);

  log('E-E-A-T trust scan completed');
  return parsed;
}

module.exports = { run };
