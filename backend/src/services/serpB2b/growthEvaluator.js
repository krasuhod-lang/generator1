'use strict';

/**
 * serpB2b/growthEvaluator.js — оценка динамики (рост/падение/стагнация)
 * сайтов из B2B-парсинга через keys.so.
 *
 * Бизнес-требование: «мы получили список сайтов, далее их просканировали в
 * keys.so по апи и получили динамику сайта видимости по топ50, оцениваем
 * первую и последнюю точку: если отклонение показателя видимости по топ-50
 * сайта ±10% — это стагнация, если минус процент — падение, если плюс
 * процент — рост. Яндекс и Google оцениваются отдельно, так как в разных
 * поисковых системах сайты себя по-разному ведут».
 *
 * Как работает:
 *   • Для каждого домена дергаем keys.so domain_dashboard дважды:
 *     Яндекс-база (по региону задачи) и соответствующая Google-база.
 *   • Из history берём первую и последнюю точки метрики keywords_top50
 *     (кол-во запросов сайта в ТОП-50 = «видимость по топ-50»).
 *   • deviation = (last - first) / first * 100:
 *       |deviation| ≤ 10%  → stagnation
 *       deviation  < -10%  → decline
 *       deviation  > +10%  → growth
 *
 * Полностью graceful: нет API-ключа / ошибка сети / домен не найден —
 * dynamics у строки останется null, парсинг контактов не страдает.
 */

const { getDomainDashboard, getGoogleBase } = require('../reports/keysSoClient');

// Порог стагнации: ±10% (бизнес-требование).
const STAGNATION_THRESHOLD_PCT = 10;

// Троттлинг под лимит keys.so (10 запросов / 10 секунд).
const REQUEST_INTERVAL_MS = 1100;

// Яндекс lr-код региона → база keys.so. Только уверенные соответствия;
// всё остальное — default 'msk' (общероссийская база).
const LR_TO_KEYSSO_BASE = {
  '213': 'msk', '1': 'msk',      // Москва и область
  '2': 'spb',                    // Санкт-Петербург
  '54': 'ekb',                   // Екатеринбург
  '65': 'nsk',                   // Новосибирск
  '43': 'kzn',                   // Казань
  '47': 'nnv',                   // Нижний Новгород
  '39': 'rnd',                   // Ростов-на-Дону
  '172': 'ufa',                  // Уфа
  '51': 'sam',                   // Самара
  '35': 'krr',                   // Краснодар
  '50': 'prm',                   // Пермь
  '66': 'oms',                   // Омск
  '56': 'che',                   // Челябинск
  '193': 'vrn',                  // Воронеж
  '38': 'vlg',                   // Волгоград
  '62': 'kry',                   // Красноярск
  '157': 'mns',                  // Минск
};

function isKeysSoConfigured() {
  return Boolean(process.env.KEYS_SO_API_KEY || process.env.KEYSSO_API_KEY);
}

function baseFromRegion(lr) {
  return LR_TO_KEYSSO_BASE[String(lr || '').trim()] || 'msk';
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * classifyTrend — чистая функция классификации первой/последней точки.
 * @returns {{trend:('growth'|'decline'|'stagnation'|null), deviation_pct:(number|null)}}
 */
function classifyTrend(first, last, thresholdPct = STAGNATION_THRESHOLD_PCT) {
  if (first == null || last == null) return { trend: null, deviation_pct: null };
  const f = Number(first);
  const l = Number(last);
  if (!Number.isFinite(f) || !Number.isFinite(l)) return { trend: null, deviation_pct: null };
  if (f === 0 && l === 0) return { trend: 'stagnation', deviation_pct: 0 };
  if (f === 0) return { trend: 'growth', deviation_pct: null }; // с нуля — любой плюс это рост
  const dev = Math.round(((l - f) / f) * 1000) / 10;
  if (dev > thresholdPct) return { trend: 'growth', deviation_pct: dev };
  if (dev < -thresholdPct) return { trend: 'decline', deviation_pct: dev };
  return { trend: 'stagnation', deviation_pct: dev };
}

function _pickMetric(point) {
  // «Видимость по топ-50» — количество запросов сайта в ТОП-50 (it50).
  // Если keys.so не отдал it50 — используем visibility как fallback.
  const t50 = Number(point?.keywords_top50);
  if (Number.isFinite(t50)) return { value: t50, metric: 'keywords_top50' };
  const vis = Number(point?.visibility);
  if (Number.isFinite(vis)) return { value: vis, metric: 'visibility' };
  return null;
}

function _evaluateHistory(history, base) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const firstPoint = history[0];
  const lastPoint = history[history.length - 1];
  const first = _pickMetric(firstPoint);
  const last = _pickMetric(lastPoint);
  if (!first || !last) return null;
  const { trend, deviation_pct } = classifyTrend(first.value, last.value);
  if (!trend) return null;
  return {
    base,
    metric: first.metric,
    trend,
    deviation_pct,
    first_point: { date: firstPoint.date, value: first.value },
    last_point: { date: lastPoint.date, value: last.value },
    months_tracked: history.length,
  };
}

/**
 * evaluateDomainDynamics — динамика одного домена, Яндекс и Google отдельно.
 * @returns {Promise<{yandex:object|null, google:object|null, evaluated_at:string}|null>}
 */
async function evaluateDomainDynamics(domain, { region } = {}) {
  if (!isKeysSoConfigured() || !domain) return null;
  const yandexBase = baseFromRegion(region);
  const googleBase = getGoogleBase(yandexBase);

  let yandex = null;
  let google = null;

  try {
    const { history } = await getDomainDashboard(domain, { base: yandexBase });
    yandex = _evaluateHistory(history, yandexBase);
  } catch (_) { /* graceful: нет данных по домену / сеть */ }

  if (googleBase) {
    await _sleep(REQUEST_INTERVAL_MS);
    try {
      const { history } = await getDomainDashboard(domain, { base: googleBase });
      google = _evaluateHistory(history, googleBase);
    } catch (_) { /* graceful */ }
  }

  if (!yandex && !google) return null;
  return { yandex, google, evaluated_at: new Date().toISOString() };
}

/**
 * enrichResultsWithDynamics — обогащает массив result-строк B2B-задачи
 * полем `dynamics`. Последовательно (лимит keys.so 10 req/10s), c
 * onProgress-колбэком для инкрементального сохранения.
 *
 * @param {Array}  rows       — результаты задачи ({url, status, ...})
 * @param {object} opts       — { region, onProgress(rows, doneCount) }
 * @returns {Promise<Array>}  — те же rows (мутируются in-place)
 */
async function enrichResultsWithDynamics(rows, { region, onProgress } = {}) {
  if (!Array.isArray(rows) || !rows.length || !isKeysSoConfigured()) return rows;
  let done = 0;
  for (const row of rows) {
    let domain = null;
    try { domain = new URL(row.url).hostname.replace(/^www\./i, ''); } catch (_) { /* skip */ }
    if (domain && row.status !== 'error') {
      try {
        row.dynamics = await evaluateDomainDynamics(domain, { region });
      } catch (_) {
        row.dynamics = null;
      }
      await _sleep(REQUEST_INTERVAL_MS);
    } else {
      row.dynamics = null;
    }
    done += 1;
    if (typeof onProgress === 'function') {
      try { await onProgress(rows, done); } catch (_) { /* не валим цикл */ }
    }
  }
  return rows;
}

module.exports = {
  classifyTrend,
  evaluateDomainDynamics,
  enrichResultsWithDynamics,
  isKeysSoConfigured,
  baseFromRegion,
  STAGNATION_THRESHOLD_PCT,
  // exposed for tests
  _evaluateHistory,
};
