const { callLLM } = require('../llm/callLLM');
const { SYSTEM_PROMPTS } = require('../../prompts/systemPrompts');
const { autoCloseJSON } = require('../../utils/autoCloseJSON');
const db = require('../../config/db');

/**
 * Stage 3 – Entity & Semantic Landscape
 */
async function run(taskId, context, log) {
  const { task } = context;
  const provider = task.provider || 'deepseek';

  const userPrompt = `Keyword: ${task.keyword}
Niche: ${task.niche || 'not specified'}
Language: ${task.language || 'not specified'}
Previous entity data: ${JSON.stringify(context.results.stage1?.entity || {}).slice(0, 8000)}
Niche landscape: ${JSON.stringify(context.results.stage2 || {}).slice(0, 4000)}`;

  log('Building entity & semantic landscape...');

  const result = await callLLM({
    systemPrompt: SYSTEM_PROMPTS.stage3,
    userPrompt,
    provider,
  });

  let parsed;
  try { parsed = JSON.parse(autoCloseJSON(result.content)); } catch (_e) { parsed = { raw: result.content }; }

  await db.query('UPDATE tasks SET stage3_result = $2 WHERE id = $1', [
    taskId, JSON.stringify(parsed),
  ]);

  log('Entity & semantic landscape completed');
  return parsed;
}

module.exports = { run };
