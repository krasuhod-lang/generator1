'use strict';

/**
 * qualityFeedback — детерминированный feedback-loop по quality_score.
 *
 * Идея: после завершения задачи смотрим её overall quality_score и
 * сравниваем с историческим распределением по (model_used, niche).
 * Если статья попала в нижний 25-перцентиль (p25) — помечаем
 * `needs_review=true` и фиксируем «дефекты» (какие подметрики просели).
 *
 * Цель — дать оператору список задач, которые с высокой вероятностью
 * требуют ручной правки, не привлекая LLM.
 *
 * Этот модуль НЕ вызывается автоматически из пайплайна (отделимая
 * фича); он используется:
 *   • из скрипта `backend/scripts/report-quality-trends.js`;
 *   • опционально из cron-задачи, если оператор её настроит;
 *   • вручную через CLI/REPL для пост-аналитики корпуса.
 *
 * Нет env-зависимости (все пороги — в коде через deepFreeze, см.
 * memory «env configuration»).
 */

const db = require('../../config/db');

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    for (const k of Object.keys(o)) deepFreeze(o[k]);
    Object.freeze(o);
  }
  return o;
}

const CONFIG = deepFreeze({
  // Минимум задач, чтобы p25 имел смысл.
  minSampleSize: 10,
  // Перцентиль, ниже которого считаем «низкокачественной».
  lowPercentile: 25,
  // Сабметрики, по которым ищем «дефекты» (сильное отставание от среднего).
  defectSubmetrics: [
    'eeat', 'readability', 'fact_check', 'plagiarism',
    'intent', 'lsi', 'image_qa', 'validation',
  ],
  // Сколько баллов ниже среднего считается «дефектом».
  defectDeltaPoints: 15,
});

/**
 * percentile(arr, p) — простая non-interpolated p-перцентиль.
 * arr — массив чисел, p ∈ [0..100].
 */
function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const idx = Math.max(0, Math.min(sorted.length - 1,
    Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

function mean(arr) {
  const xs = arr.filter((x) => Number.isFinite(x));
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * fetchHistoricalScores(opts) — берёт quality_score объекты из БД по
 * фильтру (model_used, niche), для построения распределения.
 *
 * @param {object} opts
 * @param {string} opts.model_used
 * @param {string} [opts.niche]
 * @param {string} [opts.source='info_article']
 * @param {number} [opts.limit=200]
 * @returns {Promise<Array<object>>}
 */
async function fetchHistoricalScores({ model_used, niche, source = 'info_article', limit = 200 }) {
  const table = source === 'link_article' ? 'link_article_tasks' : 'info_article_tasks';
  // Колонка niche/topic существует в обеих таблицах через JSON inputs;
  // для безопасности оборачиваем фильтр в COALESCE и используем
  // параметризованные запросы.
  const sql = `
    SELECT id, quality_score, gemini_model, completed_at
      FROM ${table}
     WHERE quality_score IS NOT NULL
       AND quality_score->>'model_used' = $1
       AND ($2::text IS NULL OR COALESCE(niche, '') = $2)
       AND completed_at >= NOW() - INTERVAL '90 days'
     ORDER BY completed_at DESC
     LIMIT $3
  `;
  const { rows } = await db.query(sql, [model_used, niche || null, limit]);
  return rows;
}

/**
 * analyzeTaskFeedback({ taskQualityScore, history })
 *
 * @param {object} taskQualityScore — содержимое quality_score колонки
 * @param {Array<object>} history — массив объектов quality_score из БД
 * @returns {object} {
 *     needs_review: boolean,
 *     reason: 'below_p25' | 'insufficient_sample' | 'ok',
 *     overall: number,
 *     p25: number|null,
 *     mean: number|null,
 *     defects: Array<{ submetric, score, mean_score, delta }>
 *   }
 */
function analyzeTaskFeedback({ taskQualityScore, history }) {
  const rawOverall = taskQualityScore?.overall;
  if (rawOverall === null || rawOverall === undefined) {
    return { needs_review: false, reason: 'no_overall', overall: null, p25: null, mean: null, defects: [] };
  }
  const overall = Number(rawOverall);
  if (!Number.isFinite(overall)) {
    return { needs_review: false, reason: 'no_overall', overall: null, p25: null, mean: null, defects: [] };
  }

  const overalls = history
    .map((h) => Number(h?.quality_score?.overall))
    .filter((x) => Number.isFinite(x));

  if (overalls.length < CONFIG.minSampleSize) {
    return {
      needs_review: false,
      reason: 'insufficient_sample',
      overall,
      p25: null,
      mean: null,
      sample_size: overalls.length,
      defects: [],
    };
  }

  const p25Val   = percentile(overalls, CONFIG.lowPercentile);
  const meanVal  = mean(overalls);
  const isLow    = overall < p25Val;

  // Поиск «дефектов»: подметрики, у которых score сильно ниже среднего по корпусу.
  const defects = [];
  if (isLow) {
    for (const key of CONFIG.defectSubmetrics) {
      const taskScore = Number(taskQualityScore?.sub?.[key]);
      if (!Number.isFinite(taskScore)) continue;
      const hist = history
        .map((h) => Number(h?.quality_score?.sub?.[key]))
        .filter((x) => Number.isFinite(x));
      const meanS = mean(hist);
      if (meanS === null) continue;
      const delta = meanS - taskScore;
      if (delta >= CONFIG.defectDeltaPoints) {
        defects.push({
          submetric:  key,
          score:      Math.round(taskScore * 10) / 10,
          mean_score: Math.round(meanS    * 10) / 10,
          delta:      Math.round(delta    * 10) / 10,
        });
      }
    }
    defects.sort((a, b) => b.delta - a.delta);
  }

  return {
    needs_review: isLow,
    reason:       isLow ? 'below_p25' : 'ok',
    overall,
    p25:          p25Val,
    mean:         meanVal,
    sample_size:  overalls.length,
    defects,
  };
}

module.exports = {
  fetchHistoricalScores,
  analyzeTaskFeedback,
  percentile,
  mean,
  CONFIG,
};
