'use strict';

const { callLLM }        = require('../llm/callLLM');
const { SYSTEM_PROMPTS } = require('../../prompts/systemPrompts');
const { calculateCoverage } = require('../../utils/calculateCoverage');
const { calculateBM25 }  = require('../metrics/bm25');
const db                 = require('../../config/db');

/**
 * Stage 7: Финальный глобальный аудит всей страницы.
 * Адаптер: deepseek.
 *
 * После Stage 7 вычисляем BM25 и сохраняем task_metrics.
 *
 * @param {object}   task       — строка tasks из БД
 * @param {object}   ctx        — { log, progress, taskId }
 * @param {string[]} allBlocks  — массив финальных HTML-блоков (только непустые)
 * @param {string[]} allLSI     — дедуплицированный список всех LSI
 * @returns {{ globalAudit: object, finalHTML: string, globalLSICoverage: number, globalEEATScore: number }}
 */
async function runStage7(task, ctx, allBlocks, allLSI) {
  const { log, progress, taskId, onTokens } = ctx;

  log('Stage 7: Финальный глобальный аудит...', 'info');
  progress(90, 'stage7');

  const targetService = task.input_target_service;
  const brandFacts    = task.input_brand_facts || 'Нет данных';

  const fullHTML = allBlocks.join('\n\n');

  const s7prompt = SYSTEM_PROMPTS.stage7
    .replace('{{FINAL_HTML}}',        () => fullHTML.substring(0, 30000))
    .replace('{{TARGET_SERVICE}}',    () => targetService)
    .replace('{{ORIGINAL_LSI_MUST}}', () => JSON.stringify(allLSI))
    .replace('{{BRAND_FACTS}}',       () => brandFacts);

  log(
    `Stage 7: Глобальный аудит — промпт ${s7prompt.length} символов, ` +
    `HTML ${fullHTML.length} символов, LSI ${allLSI.length} слов...`,
    'info'
  );

  const s7Result = await callLLM(
    'deepseek',
    '',
    s7prompt,
    { retries: 3, taskId, stageName: 'stage7', callLabel: '7 Global Audit', log, onTokens }
  ).catch(e => {
    log(`Stage 7 ОШИБКА: ${e.message}`, 'error');
    return null;
  });

  log(`Stage 7: ответ получен. Ключи: [${Object.keys(s7Result || {}).join(', ')}]`, 'success');

  // Финальный E-E-A-T score
  const globalEEATScore = s7Result?.global_audit?.page_quality_score
    ? parseFloat(s7Result.global_audit.page_quality_score.toFixed(1))
    : 0;

  // Финальное LSI-покрытие всей страницы
  const finalCov = calculateCoverage(fullHTML, allLSI);
  const globalLSICoverage = finalCov.percent;

  // BM25 score для всей страницы
  // calculateBM25(query, documentText) — query = allLSI joined, doc = fullHTML
  const bm25 = calculateBM25(allLSI.join(' '), fullHTML);

  log(
    `Stage 7: E-E-A-T score=${globalEEATScore}, LSI coverage=${globalLSICoverage}%, ` +
    `BM25=${bm25.score.toFixed(2)} (${bm25.interpretation})`,
    'success'
  );

  // Сохраняем финальные метрики в task_metrics
  await db.query(
    `INSERT INTO task_metrics
       (task_id, lsi_coverage, eeat_score, bm25_score, total_cost_usd)
     VALUES ($1, $2, $3, $4, 0)
     ON CONFLICT (task_id) DO UPDATE SET
       lsi_coverage   = EXCLUDED.lsi_coverage,
       eeat_score     = EXCLUDED.eeat_score,
       bm25_score     = EXCLUDED.bm25_score,
       updated_at     = NOW()`,
    [
      taskId,
      globalLSICoverage,
      globalEEATScore,
      bm25.score,
    ]
  );

  // Обновляем tasks: сохраняем финальный HTML и отчёт Stage 7
  await db.query(
    `UPDATE tasks SET
       stage7_result = $1,
       full_html     = $2,
       updated_at    = NOW()
     WHERE id = $3`,
    [JSON.stringify(s7Result || {}), fullHTML, taskId]
  );

  log('<strong>Генерация и аудит полностью завершены!</strong>', 'success');
  progress(98, 'stage7');

  return {
    globalAudit:       s7Result,
    finalHTML:         fullHTML,
    globalLSICoverage,
    globalEEATScore,
    bm25,
  };
}

module.exports = { runStage7 };
