'use strict';

/**
 * modelSelector — лёгкий «бандит»-селектор Gemini-модели.
 *
 * Если оператор НЕ выбрал явно gemini-модель для задачи, селектор
 * предлагает ту модель, у которой выше скользящее среднее quality_score
 * за последние N завершённых задач в той же нише.
 *
 * Режим: по умолчанию ВЫКЛЮЧЕН (flag enabled=false). Включается через
 * прямую правку CONFIG.enabled в этом файле (см. memory «env configuration» —
 * новых ENV-переменных не добавляем).
 *
 * Безопасность: при ошибке / недостатке данных всегда возвращает
 * `defaultModel` — пайплайн никогда не падает из-за селектора.
 *
 * Не делает LLM-вызовов; единственная зависимость — БД.
 */

const db = require('../../config/db');
const { DEFAULT_GEMINI_COPYWRITING_MODEL, GEMINI_COPYWRITING_MODELS } =
  require('./geminiModels');

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    for (const k of Object.keys(o)) deepFreeze(o[k]);
    Object.freeze(o);
  }
  return o;
}

const CONFIG = deepFreeze({
  // По умолчанию OFF. Включать ручной правкой кода.
  enabled: false,
  // Размер окна для скользящего среднего.
  windowSize: 50,
  // Минимум задач на модель для участия в выборе.
  minSampleSize: 5,
  // Если разница средних score < tieBreakDelta — берём дефолт (избегаем шумовых решений).
  tieBreakDelta: 2.0,
  // Источник: 'info_article' | 'link_article'.
  source: 'info_article',
});

/**
 * computeRollingAverages({ niche, source, windowSize })
 *   → Map<model_used, { avg, n }>
 */
async function computeRollingAverages({
  niche,
  source = CONFIG.source,
  windowSize = CONFIG.windowSize,
} = {}) {
  const table = source === 'link_article' ? 'link_article_tasks' : 'info_article_tasks';
  const sql = `
    SELECT model_used, ROUND(AVG(overall)::numeric, 2) AS avg, COUNT(*)::int AS n
      FROM (
        SELECT
          COALESCE(quality_score->>'model_used', gemini_model) AS model_used,
          (quality_score->>'overall')::float AS overall,
          completed_at
        FROM ${table}
        WHERE quality_score IS NOT NULL
          AND ($1::text IS NULL OR COALESCE(niche, '') = $1)
        ORDER BY completed_at DESC
        LIMIT $2
      ) AS recent
     WHERE overall IS NOT NULL AND model_used IS NOT NULL
     GROUP BY model_used
  `;
  const { rows } = await db.query(sql, [niche || null, windowSize]);
  const out = new Map();
  for (const r of rows) {
    out.set(r.model_used, { avg: Number(r.avg), n: r.n });
  }
  return out;
}

/**
 * selectModel({ niche, defaultModel })
 *
 * @returns {Promise<{ model, reason, candidates }>}
 *   model — выбранная модель;
 *   reason — почему выбрана: 'disabled' | 'no_default_override'
 *            | 'insufficient_data' | 'tie' | 'best_avg';
 *   candidates — { [model]: { avg, n } } для прозрачности.
 */
async function selectModel({
  niche,
  defaultModel = DEFAULT_GEMINI_COPYWRITING_MODEL,
} = {}) {
  if (!CONFIG.enabled) {
    return { model: defaultModel, reason: 'disabled', candidates: {} };
  }
  try {
    const stats = await computeRollingAverages({ niche });
    const candidates = {};
    // Допускаем только зарегистрированные модели.
    for (const { value } of GEMINI_COPYWRITING_MODELS) {
      const s = stats.get(value);
      if (s) candidates[value] = s;
    }
    const eligible = Object.entries(candidates).filter(([, s]) => s.n >= CONFIG.minSampleSize);
    if (eligible.length === 0) {
      return { model: defaultModel, reason: 'insufficient_data', candidates };
    }
    eligible.sort((a, b) => b[1].avg - a[1].avg);
    const [best, second] = eligible;
    if (second && (best[1].avg - second[1].avg) < CONFIG.tieBreakDelta) {
      return { model: defaultModel, reason: 'tie', candidates };
    }
    return { model: best[0], reason: 'best_avg', candidates };
  } catch (err) {
    // При любой ошибке — мягкий фолбэк на дефолт.
    console.warn(`[modelSelector] error: ${err.message}`);
    return { model: defaultModel, reason: 'error', candidates: {} };
  }
}

module.exports = {
  selectModel,
  computeRollingAverages,
  CONFIG,
};
