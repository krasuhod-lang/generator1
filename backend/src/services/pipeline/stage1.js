'use strict';

const { callLLM }            = require('../llm/callLLM');
const { SYSTEM_PROMPTS, SYSTEM_PROMPTS_EXT } = require('../../prompts/systemPrompts');
const { fillPromptVars }     = require('../../utils/fillPromptVars');
const db                     = require('../../config/db');

/**
 * Вспомогательная функция — безопасно извлекает массив из объекта/массива.
 * Обрабатывает как [], так и { key: [...] } (Gemini иногда оборачивает).
 */
function safeArr(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  if (typeof val === 'object') {
    const firstArr = Object.values(val).find(v => Array.isArray(v));
    return firstArr || [];
  }
  return [];
}

/**
 * Stage 1: Запуск трёх параллельных агентов (Entity, Intent, Community).
 * Адаптер: deepseek (для всех трёх).
 *
 * @param {object} task   — строка tasks из БД
 * @param {object} ctx    — { log, progress, taskId }
 * @param {object} stage0Result — результат Stage 0 (или null)
 * @returns {object} stage1Result — объединённый JSON со всеми ключами
 */
async function runStage1(task, ctx, stage0Result) {
  const { log, progress, taskId, onTokens } = ctx;

  log('Stage 1: Запуск трёх параллельных агентов (Entity / Intent / Community)...', 'info');
  progress(12, 'stage1');

  const targetService = task.input_target_service;
  const rawLSI        = task.input_raw_lsi || '';
  const brandFacts    = task.input_brand_facts || '';

  // Сжимаем stage0 до разумного контекста
  const stage0Ctx = JSON.stringify(stage0Result || {}).substring(0, 4000);

  // ── Call 1A: Entity Landscape ──────────────────────────────────────
  const entityContext = `\n\n===== INPUT DATA =====
NICHE / TARGET SERVICE: ${targetService}
LSI TERMS (первые 600 символов): ${rawLSI.substring(0, 600)}
STAGE 0 RESULT: ${stage0Ctx}
BRAND FACTS: ${brandFacts.substring(0, 500)}

OUTPUT: Return ONLY valid JSON with these keys:
- entity_graph: [{entity, type, weight, relations:[]}]
- lsi_clusters: [{cluster_name, keywords:[], intent}]
- commercial_intents: [{intent, query_example, conversion_potential}]
- terminology_map: {term: definition}
NO markdown. NO extra text.`;

  // ── Call 1B: Commercial Intent ─────────────────────────────────────
  const intentContext = `\n\n===== INPUT DATA =====
NICHE / TARGET SERVICE: ${targetService}
STAGE 0 RESULT: ${stage0Ctx}
LSI TERMS: ${rawLSI.substring(0, 600)}

OUTPUT: Return ONLY valid JSON with these keys:
- commercial_intents: [{intent, query_example, conversion_potential, stage: 'awareness|consideration|decision'}]
- lsi_clusters: [{cluster_name, keywords:[], intent}]
- search_patterns: [{pattern, frequency: 'high|medium|low', content_type}]
NO markdown. NO extra text.`;

  // ── Call 1C: Community Voice ───────────────────────────────────────
  const communityContext = `\n\n===== INPUT DATA =====
NICHE / TARGET SERVICE: ${targetService}
STAGE 0 RESULT: ${stage0Ctx}
LSI TERMS: ${rawLSI.substring(0, 600)}

OUTPUT: Return ONLY valid JSON with these keys:
- lsi_clusters: [{cluster_name, keywords:[], intent}]
- language_map: {formal_term: colloquial_synonym}
- user_questions: [{question, answer_hint, priority: 'high|medium|low'}]
- pain_points: [{pain, trigger_phrase, solution_angle}]
NO markdown. NO extra text.`;

  const promptSize1A = (SYSTEM_PROMPTS_EXT.entityLandscape + entityContext).length;
  const promptSize1B = (SYSTEM_PROMPTS_EXT.commercialIntent + intentContext).length;
  const promptSize1C = (SYSTEM_PROMPTS_EXT.communityVoice + communityContext).length;

  log(`Stage 1A Entity — промпт ${promptSize1A} символов (~${Math.round(promptSize1A / 4)} токенов)`, 'info');
  log(`Stage 1B Intent — промпт ${promptSize1B} символов (~${Math.round(promptSize1B / 4)} токенов)`, 'info');
  log(`Stage 1C Community — промпт ${promptSize1C} символов (~${Math.round(promptSize1C / 4)} токенов)`, 'info');

  // Заполняем плейсхолдеры в system-промптах реальными данными задачи
  const filledEntity     = fillPromptVars(SYSTEM_PROMPTS_EXT.entityLandscape, task);
  const filledIntent     = fillPromptVars(SYSTEM_PROMPTS_EXT.commercialIntent, task);
  const filledCommunity  = fillPromptVars(SYSTEM_PROMPTS_EXT.communityVoice, task);

  // Запускаем параллельно — Promise.all с индивидуальным catch
  const [entityResult, intentResult, communityResult] = await Promise.all([
    callLLM('deepseek', filledEntity, entityContext, {
      retries:   3,
      taskId,
      stageName: 'stage1',
      callLabel: 'Entity Landscape',
      temperature: 0.3,
      log,
      onTokens,
    }).catch(e => { log(`Stage 1A Entity ОШИБКА: ${e.message}`, 'error'); return null; }),

    callLLM('deepseek', filledIntent, intentContext, {
      retries:   3,
      taskId,
      stageName: 'stage1',
      callLabel: 'Commercial Intent',
      temperature: 0.3,
      log,
      onTokens,
    }).catch(e => { log(`Stage 1B Intent ОШИБКА: ${e.message}`, 'error'); return null; }),

    callLLM('deepseek', filledCommunity, communityContext, {
      retries:   3,
      taskId,
      stageName: 'stage1',
      callLabel: 'Community Voice',
      temperature: 0.3,
      log,
      onTokens,
    }).catch(e => { log(`Stage 1C Community ОШИБКА: ${e.message}`, 'error'); return null; }),
  ]);

  // Логируем результаты агентов
  log(`Stage 1A Entity:    ${entityResult    ? `✓ ключи: [${Object.keys(entityResult).join(', ')}]`    : '✗ null'}`, entityResult    ? 'success' : 'warn');
  log(`Stage 1B Intent:    ${intentResult    ? `✓ ключи: [${Object.keys(intentResult).join(', ')}]`    : '✗ null'}`, intentResult    ? 'success' : 'warn');
  log(`Stage 1C Community: ${communityResult ? `✓ ключи: [${Object.keys(communityResult).join(', ')}]` : '✗ null'}`, communityResult ? 'success' : 'warn');

  if (!entityResult && !intentResult && !communityResult) {
    throw new Error('Stage 1: все три агента вернули ошибки — проверь API ключи и квоту');
  }

  // Базовый объект из первого непустого результата
  let stage1Result = entityResult || intentResult || communityResult;

  // Объединяем LSI-кластеры из всех трёх агентов
  const mergedLSI = [
    ...safeArr(entityResult?.lsi_clusters),
    ...safeArr(intentResult?.lsi_clusters),
    ...safeArr(communityResult?.lsi_clusters),
  ];
  if (mergedLSI.length) stage1Result.lsi_clusters = mergedLSI;

  // Объединяем commercial_intents
  const mergedIntents = [
    ...safeArr(entityResult?.commercial_intents),
    ...safeArr(intentResult?.commercial_intents),
  ];
  if (mergedIntents.length) stage1Result.commercial_intents = mergedIntents;

  // Добавляем language_map и user_questions из Community агента
  if (communityResult?.language_map)  stage1Result.language_map  = communityResult.language_map;
  if (communityResult?.user_questions) stage1Result.user_questions = communityResult.user_questions;
  if (communityResult?.pain_points)   stage1Result.pain_points   = communityResult.pain_points;

  // Entity graph из агента 1A
  if (entityResult?.entity_graph) stage1Result.entity_graph = entityResult.entity_graph;
  if (entityResult?.terminology_map) stage1Result.terminology_map = entityResult.terminology_map;

  // Сохраняем в БД
  await db.query(
    `UPDATE tasks SET stage1_result = $1, updated_at = NOW() WHERE id = $2`,
    [JSON.stringify(stage1Result), taskId]
  );

  log(
    `Stage 1 завершён. LSI кластеров: ${(stage1Result.lsi_clusters || []).length} | ` +
    `entity_graph: ${entityResult ? 'есть' : 'нет'} | ` +
    `commercial_intents: ${safeArr(stage1Result.commercial_intents).length}`,
    'success'
  );

  progress(22, 'stage1');
  return stage1Result;
}

module.exports = { runStage1, safeArr };
