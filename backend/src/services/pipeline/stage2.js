const { callLLM } = require('../llm/callLLM');
const { SYSTEM_PROMPTS } = require('../../prompts/systemPrompts');
const { autoCloseJSON } = require('../../utils/autoCloseJSON');
const db = require('../../config/db');

/**
 * Stage 2 – Niche Landscape Analysis
 */
async function run(taskId, context, log) {
  const { task } = context;
  const provider = task.provider || 'deepseek';

  const previousResults = JSON.stringify({
    serp: context.results.stage1?.serp,
    entity: context.results.stage1?.entity,
  }).slice(0, 10000);

  const userPrompt = `Keyword: ${task.keyword}
Niche: ${task.niche || 'not specified'}
Competitors: ${task.competitor_urls || '[]'}
Previous analysis: ${previousResults}`;

  log('Running niche landscape analysis...');

  const result = await callLLM({
    systemPrompt: SYSTEM_PROMPTS.nicheLandscape,
    userPrompt,
    provider,
  });

  let parsed;
  try { parsed = JSON.parse(autoCloseJSON(result.content)); } catch (_e) { parsed = { raw: result.content }; }

  await db.query('UPDATE tasks SET stage2_result = $2 WHERE id = $1', [
    taskId, JSON.stringify(parsed),
  ]);

  log('Niche landscape analysis completed');
  return parsed;
}

module.exports = { run };
