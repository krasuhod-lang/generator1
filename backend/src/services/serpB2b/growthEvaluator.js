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
 * dynamics.yandex/.google у строки останутся null, парсинг контактов не
 * страдает. Но причина отсутствия данных больше НЕ проглатывается: она
 * сохраняется в dynamics.errors.{yandex,google} ('not_found' | 'no_history' |
 * 'rate_limited' | 'network' | ...) и агрегируется в статистику задачи,
 * чтобы было видно, почему у конкретного сайта нет динамики.
 *
 * Fallback покрытия: если регион задачи ≠ Москва и в региональной базе
 * keys.so домена нет (или истории < 2 точек) — повторяем запрос по
 * общероссийской базе 'msk'. Малые B2B-сайты часто отсутствуют в
 * региональных базах, но есть в msk — это главная причина «динамика
 * отобразилась не у всех».
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

/** Машиночитаемая причина отсутствия динамики из ошибки keys.so-клиента. */
function _reasonFromError(err) {
  const code = err && err.code;
  const status = err && err.status;
  if (code === 'not_found') return 'not_found';          // домена нет в базе keys.so
  if (code === 'unauthorized') return 'unauthorized';    // невалидный API-ключ
  if (code === 'plan_restriction') return 'plan_restriction'; // тариф не позволяет
  if (code === 'no_api_key') return 'no_api_key';
  if (status === 429) return 'rate_limited';
  return 'network';
}

/**
 * Динамика одного домена в одной поисковой системе (одна база keys.so),
 * с fallback на общероссийскую базу 'msk': малые региональные B2B-сайты
 * часто отсутствуют в региональной базе, но присутствуют в msk.
 *
 * @returns {Promise<{result:object|null, reason:string|null}>}
 */
async function _evaluateOneEngine(domain, base, { fallbackBase = null } = {}) {
  let reason = null;
  try {
    const { history } = await getDomainDashboard(domain, { base });
    const result = _evaluateHistory(history, base);
    if (result) return { result, reason: null };
    reason = 'no_history'; // домен есть, но истории < 2 точек / нет метрик
  } catch (err) {
    reason = _reasonFromError(err);
  }
  // Fallback: причины, при которых имеет смысл попробовать другую базу.
  const retriable = reason === 'not_found' || reason === 'no_history';
  if (fallbackBase && fallbackBase !== base && retriable) {
    await _sleep(REQUEST_INTERVAL_MS);
    try {
      const { history } = await getDomainDashboard(domain, { base: fallbackBase });
      const result = _evaluateHistory(history, fallbackBase);
      if (result) return { result, reason: null };
    } catch (_) { /* остаёмся с первичной причиной */ }
  }
  return { result: null, reason };
}

/**
 * evaluateDomainDynamics — динамика одного домена, Яндекс и Google отдельно.
 * Всегда возвращает объект (не null), чтобы причины отсутствия данных
 * были видны на фронте и в статистике.
 * @returns {Promise<{yandex:object|null, google:object|null, errors:object, evaluated_at:string}|null>}
 */
async function evaluateDomainDynamics(domain, { region } = {}) {
  if (!isKeysSoConfigured() || !domain) return null;
  const yandexBase = baseFromRegion(region);
  const googleBase = getGoogleBase(yandexBase);

  const ya = await _evaluateOneEngine(domain, yandexBase, {
    fallbackBase: yandexBase !== 'msk' ? 'msk' : null,
  });

  let go = { result: null, reason: googleBase ? null : 'no_google_base' };
  if (googleBase) {
    await _sleep(REQUEST_INTERVAL_MS);
    go = await _evaluateOneEngine(domain, googleBase, {
      fallbackBase: googleBase !== 'gru' ? 'gru' : null,
    });
  }

  const errors = {};
  if (!ya.result && ya.reason) errors.yandex = ya.reason;
  if (!go.result && go.reason) errors.google = go.reason;

  return {
    yandex: ya.result,
    google: go.result,
    ...(Object.keys(errors).length ? { errors } : {}),
    evaluated_at: new Date().toISOString(),
  };
}

/**
 * enrichResultsWithDynamics — обогащает массив result-строк B2B-задачи
 * полем `dynamics`. Последовательно (лимит keys.so 10 req/10s), c
 * onProgress-колбэком для инкрементального сохранения. Собирает
 * статистику покрытия и причин отсутствия данных.
 *
 * @param {Array}  rows       — результаты задачи ({url, status, ...})
 * @param {object} opts       — { region, onProgress(rows, doneCount) }
 * @returns {Promise<{rows:Array, stats:object}>} rows мутируются in-place
 */
async function enrichResultsWithDynamics(rows, { region, onProgress } = {}) {
  const stats = {
    total: Array.isArray(rows) ? rows.length : 0,
    evaluated: 0,       // есть динамика хотя бы по одной ПС
    with_yandex: 0,
    with_google: 0,
    no_data: 0,         // ни Яндекс, ни Google
    skipped: 0,         // error-строки / невалидный URL
    reasons: {},        // 'not_found' → count, 'no_history' → count, ...
  };
  if (!Array.isArray(rows) || !rows.length || !isKeysSoConfigured()) {
    return { rows: rows || [], stats };
  }
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
      const d = row.dynamics;
      if (d && (d.yandex || d.google)) {
        stats.evaluated += 1;
        if (d.yandex) stats.with_yandex += 1;
        if (d.google) stats.with_google += 1;
      } else {
        stats.no_data += 1;
      }
      const errs = (d && d.errors) || {};
      for (const reason of Object.values(errs)) {
        stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
      }
      // Rate-limit backoff: keys.so ответил 429 — притормаживаем сильнее.
      const hitRateLimit = Object.values(errs).includes('rate_limited');
      await _sleep(hitRateLimit ? REQUEST_INTERVAL_MS * 5 : REQUEST_INTERVAL_MS);
    } else {
      row.dynamics = null;
      stats.skipped += 1;
    }
    done += 1;
    if (typeof onProgress === 'function') {
      try { await onProgress(rows, done); } catch (_) { /* не валим цикл */ }
    }
  }
  return { rows, stats };
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
  _reasonFromError,
  _evaluateOneEngine,
};
