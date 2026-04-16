const { callLLM } = require('../llm/callLLM');
const { SYSTEM_PROMPTS } = require('../../prompts/systemPrompts');
const { autoCloseJSON } = require('../../utils/autoCloseJSON');
const db = require('../../config/db');

/**
 * Stage 1 – SERP Reality Check + Entity Analysis + Community Voice (parallel)
 * Runs three LLM analyses in parallel for efficiency.
 */
async function run(taskId, context, log) {
  const { task } = context;
  const provider = task.provider || 'deepseek';
  const competitorData = JSON.stringify(context.results.stage0?.competitors || []);

  const userContext = `Keyword: ${task.keyword}
Niche: ${task.niche || 'not specified'}
Target audience: ${task.target_audience || 'not specified'}
Region: ${task.region || 'not specified'}
Language: ${task.language || 'not specified'}
Competitor data: ${competitorData.slice(0, 8000)}`;

  log('Running SERP, Entity, and Community analyses in parallel...');

  const [serpResult, entityResult, communityResult] = await Promise.all([
    callLLM({ systemPrompt: SYSTEM_PROMPTS.serpRealityCheck, userPrompt: userContext, provider }),
    callLLM({ systemPrompt: SYSTEM_PROMPTS.entityLandscape, userPrompt: userContext, provider }),
    callLLM({ systemPrompt: SYSTEM_PROMPTS.communityVoice, userPrompt: userContext, provider }),
  ]);

  let serp, entity, community;
  try { serp = JSON.parse(autoCloseJSON(serpResult.content)); } catch (_e) { serp = { raw: serpResult.content }; }
  try { entity = JSON.parse(autoCloseJSON(entityResult.content)); } catch (_e) { entity = { raw: entityResult.content }; }
  try { community = JSON.parse(autoCloseJSON(communityResult.content)); } catch (_e) { community = { raw: communityResult.content }; }

  const stageResult = { serp, entity, community };

  await db.query('UPDATE tasks SET stage1_result = $2 WHERE id = $1', [
    taskId,
    JSON.stringify(stageResult),
  ]);

  log('Stage 1 analysis completed');
  return stageResult;
}

module.exports = { run };
