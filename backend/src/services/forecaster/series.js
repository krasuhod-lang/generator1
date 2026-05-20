'use strict';

/**
 * forecaster/series.js — агрегация помесячного спроса по всем фразам.
 *
 * Берёт результат `parseForecasterInput` и собирает суммарный ряд
 * demand[t] = Σ phrase_i.byPeriod[t].
 *
 * Заполняет пропуски (если в периоде нет ни одной фразы — там 0) и
 * формирует сплошной диапазон от minPeriod до maxPeriod, чтобы прогноз
 * работал на регулярной сетке.
 */

function _periodToIndex(period) {
  // "YYYY-MM" → число месяцев с эпохи 2000-01
  const [y, m] = period.split('-').map(Number);
  return (y - 2000) * 12 + (m - 1);
}
function _indexToPeriod(idx) {
  const y = 2000 + Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

/**
 * @param {ReturnType<import('./parser').parseForecasterInput>} parsed
 * @param {Object} [opts]
 * @param {Set<string>|Array<string>} [opts.excludePhrases] — нормализованные
 *   (lowercase, trimmed) фразы, которые НЕ должны участвовать в агрегации
 *   monthly demand. Используется pipeline-ом, чтобы вычесть однословные ВЧ /
 *   мёртвые / чужие бренды из суммы спроса (см. junkClassifier).
 *   Без аргумента поведение полностью BC.
 * @returns {{
 *   monthly: Array<{period:string, demand:number, phrases_count:number}>,
 *   minPeriod: string|null,
 *   maxPeriod: string|null,
 *   totalDemand: number,
 *   phrasesCount: number,
 *   excludedSummary?: { phrases:number, total_demand:number, sample_phrases:string[] },
 * }}
 */
function aggregateMonthlySeries(parsed, opts = {}) {
  const all = [];
  for (const mc of parsed.monthCols) all.push(mc.period);
  if (all.length === 0 || parsed.rows.length === 0) {
    return {
      monthly: [],
      minPeriod: null,
      maxPeriod: null,
      totalDemand: 0,
      phrasesCount: parsed.rows.length,
    };
  }
  // Нормализуем set исключений (lowercase, trimmed) — устойчиво к регистру.
  let exclude = null;
  if (opts.excludePhrases) {
    exclude = new Set();
    const src = opts.excludePhrases instanceof Set
      ? opts.excludePhrases : Array.from(opts.excludePhrases);
    for (const p of src) {
      const n = String(p || '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (n) exclude.add(n);
    }
    if (exclude.size === 0) exclude = null;
  }

  // суммируем по периодам
  const sumByPeriod = new Map();
  const countByPeriod = new Map();
  let excludedPhrases = 0;
  let excludedDemand  = 0;
  const sampleExcluded = [];
  for (const row of parsed.rows) {
    if (exclude) {
      const norm = String(row.phrase || '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (norm && exclude.has(norm)) {
        excludedPhrases += 1;
        excludedDemand  += Number(row.total || 0);
        if (sampleExcluded.length < 5) sampleExcluded.push(row.phrase);
        continue;
      }
    }
    for (const [p, v] of Object.entries(row.byPeriod)) {
      sumByPeriod.set(p, (sumByPeriod.get(p) || 0) + v);
      if (v > 0) {
        countByPeriod.set(p, (countByPeriod.get(p) || 0) + 1);
      }
    }
  }
  const sortedPeriods = [...sumByPeriod.keys()].sort();
  const minP = sortedPeriods[0];
  const maxP = sortedPeriods[sortedPeriods.length - 1];
  // сплошной ряд
  const minIdx = _periodToIndex(minP);
  const maxIdx = _periodToIndex(maxP);
  const monthly = [];
  let total = 0;
  for (let i = minIdx; i <= maxIdx; i++) {
    const p = _indexToPeriod(i);
    const d = Math.round(sumByPeriod.get(p) || 0);
    total += d;
    monthly.push({
      period: p,
      demand: d,
      phrases_count: countByPeriod.get(p) || 0,
    });
  }
  const result = {
    monthly,
    minPeriod: minP,
    maxPeriod: maxP,
    totalDemand: total,
    phrasesCount: parsed.rows.length - excludedPhrases,
  };
  if (exclude) {
    result.excludedSummary = {
      phrases: excludedPhrases,
      total_demand: excludedDemand,
      sample_phrases: sampleExcluded,
    };
  }
  return result;
}

module.exports = {
  aggregateMonthlySeries,
  _periodToIndex,
  _indexToPeriod,
};
