'use strict';

const { callLLM }        = require('../llm/callLLM');
const { SYSTEM_PROMPTS } = require('../../prompts/systemPrompts');
const { calculateCoverage } = require('../../utils/calculateCoverage');
const { calculateBM25 }  = require('../metrics/bm25');
const db                 = require('../../config/db');

/**
 * computeTfIdfDensity — программный подсчёт TF-IDF плотности по финальному HTML.
 * Не зависит от LLM — чистая JS-математика.
 *
 * @param {string} fullHTML — полный HTML страницы
 * @param {Array}  tfIdfArr — [{term, rangeMin, rangeMax}]
 * @returns {Array<{term, actual_count, range_min, range_max, status}>}
 */
function computeTfIdfDensity(fullHTML, tfIdfArr) {
  if (!tfIdfArr || !tfIdfArr.length) return [];

  const plainText = fullHTML.replace(/<[^>]+>/g, ' ').toLowerCase();

  return tfIdfArr.map(item => {
    const term = (item.term || '').trim();
    if (!term) return null;

    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const actualCount = (plainText.match(re) || []).length;
    const rangeMin = parseInt(item.rangeMin) || 0;
    const rangeMax = parseInt(item.rangeMax) || 999;

    let status = 'ok';
    if (actualCount > rangeMax) status = 'overuse';
    else if (actualCount < rangeMin) status = 'underuse';

    return { term, actual_count: actualCount, range_min: rangeMin, range_max: rangeMax, status };
  }).filter(Boolean);
}

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

  // TF-IDF данные из задачи
  let tfIdfArr = [];
  try { tfIdfArr = JSON.parse(task.input_tfidf_json || '[]'); } catch { /* ignore */ }
  const tfIdfWeightsStr = JSON.stringify(tfIdfArr.slice(0, 50)); // ограничиваем для промпта

  const s7prompt = SYSTEM_PROMPTS.stage7
    .replace('{{FINAL_HTML}}',        () => fullHTML.substring(0, 30000))
    .replace('{{TARGET_SERVICE}}',    () => targetService)
    .replace('{{ORIGINAL_LSI_MUST}}', () => JSON.stringify(allLSI))
    .replace(/\{\{BRAND_NAME\}\}/g,   () => (task.input_brand_name || '').trim() || 'Нет данных')
    .replace('{{BRAND_FACTS}}',       () => brandFacts)
    .replace('{{TFIDF_WEIGHTS}}',     () => tfIdfWeightsStr);

  log(
    `Stage 7: Глобальный аудит — промпт ${s7prompt.length} символов, ` +
    `HTML ${fullHTML.length} символов, LSI ${allLSI.length} слов, TF-IDF терминов ${tfIdfArr.length}...`,
    'info'
  );

  const s7Result = await callLLM(
    'deepseek',
    '',
    s7prompt,
    { retries: 3, taskId, stageName: 'stage7', callLabel: '7 Global Audit', temperature: 0.2, log, onTokens }
  ).catch(e => {
    log(`Stage 7 ОШИБКА: ${e.message}`, 'error');
    return null;
  });

  log(`Stage 7: ответ получен. Ключи: [${Object.keys(s7Result || {}).join(', ')}]`, 'success');

  // Финальный E-E-A-T score — из breakdown (сумма по критериям) или из page_quality_score
  let globalEEATScore = 0;
  const eeatBreakdown = s7Result?.eeat_criteria_breakdown;
  if (eeatBreakdown && typeof eeatBreakdown === 'object' && !Array.isArray(eeatBreakdown)) {
    // Новый формат — объект с ключами experience/expertise/authoritativeness/trustworthiness/content_quality
    const scores = ['experience', 'expertise', 'authoritativeness', 'trustworthiness', 'content_quality']
      .map(k => parseFloat(eeatBreakdown[k]?.score) || 0);
    globalEEATScore = parseFloat(scores.reduce((a, b) => a + b, 0).toFixed(1));
  } else if (s7Result?.global_audit?.page_quality_score) {
    globalEEATScore = parseFloat(Number(s7Result.global_audit.page_quality_score).toFixed(1));
  }

  // Финальное LSI-покрытие всей страницы
  const finalCov = calculateCoverage(fullHTML, allLSI);
  const globalLSICoverage = finalCov.percent;

  // BM25 score для всей страницы
  const bm25 = calculateBM25(allLSI.join(' '), fullHTML);

  // TF-IDF density — программный подсчёт (точный, не LLM)
  const tfIdfDensity = computeTfIdfDensity(fullHTML, tfIdfArr);
  const tfIdfOveruse  = tfIdfDensity.filter(t => t.status === 'overuse').length;
  const tfIdfUnderuse = tfIdfDensity.filter(t => t.status === 'underuse').length;

  log(
    `Stage 7: E-E-A-T score=${globalEEATScore}, LSI coverage=${globalLSICoverage}%, ` +
    `BM25=${bm25.score.toFixed(2)} (${bm25.interpretation}), ` +
    `TF-IDF: ${tfIdfDensity.length} терминов, overuse=${tfIdfOveruse}, underuse=${tfIdfUnderuse}`,
    'success'
  );

  // Обогащаем s7Result программными данными (более точные чем LLM-оценка)
  const enrichedResult = {
    ...(s7Result || {}),
    computed_tfidf_density: tfIdfDensity,
    computed_lsi_coverage:  { percent: globalLSICoverage, covered: finalCov.covered, missing: finalCov.missing },
    computed_bm25:          bm25,
  };

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

  // Обновляем tasks: сохраняем финальный HTML и отчёт Stage 7 (с программными данными)
  await db.query(
    `UPDATE tasks SET
       stage7_result = $1,
       full_html     = $2,
       updated_at    = NOW()
     WHERE id = $3`,
    [JSON.stringify(enrichedResult), fullHTML, taskId]
  );

  log('<strong>Генерация и аудит полностью завершены!</strong>', 'success');
  progress(98, 'stage7');

  return {
    globalAudit:       enrichedResult,
    finalHTML:         fullHTML,
    globalLSICoverage,
    globalEEATScore,
    bm25,
    tfIdfDensity,
    eeatBreakdown:     eeatBreakdown || null,
  };
}

module.exports = { runStage7, computeTfIdfDensity };
