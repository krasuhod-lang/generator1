const { callLLM } = require('../llm/callLLM');
const { SYSTEM_PROMPTS } = require('../../prompts/systemPrompts');
const { autoCloseJSON } = require('../../utils/autoCloseJSON');
const db = require('../../config/db');

/**
 * Stage 5 – Community Voice Analysis
 */
async function run(taskId, context, log) {
  const { task } = context;
  const provider = task.provider || 'deepseek';

  const userPrompt = `Keyword: ${task.keyword}
Niche: ${task.niche || 'not specified'}
Target audience: ${task.target_audience || 'not specified'}
Language: ${task.language || 'not specified'}
Community data from stage 1: ${JSON.stringify(context.results.stage1?.community || {}).slice(0, 6000)}`;

  log('Analysing community voice...');

  const result = await callLLM({
    systemPrompt: SYSTEM_PROMPTS.stage5,
    userPrompt,
    provider,
  });

  let parsed;
  try { parsed = JSON.parse(autoCloseJSON(result.content)); } catch (_e) { parsed = { raw: result.content }; }

  await db.query('UPDATE tasks SET stage5_result = $2 WHERE id = $1', [
    taskId, JSON.stringify(parsed),
  ]);

  log('Community voice analysis completed');
  return parsed;
}

module.exports = { run };
