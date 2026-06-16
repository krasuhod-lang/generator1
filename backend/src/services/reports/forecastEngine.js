'use strict';

/**
 * reports/forecastEngine.js — полиномиальная регрессия степени 2 без зависимостей.
 *
 * Алгоритм: метод наименьших квадратов через нормальные уравнения для
 * y = a + b·x + c·x². Решение системы 3×3 — ручное по правилу Крамера,
 * чтобы не тащить numeric-зависимости.
 *
 * Контракт:
 *   forecastMetric(series, horizon) -> { historical, forecast, method, basis }
 *     • series  — массив чисел, исторические значения по месяцам (index = месяц).
 *     • horizon — сколько месяцев вперёд предсказать (1..12).
 *   Возвращает прогноз ≥ 0 (clamp), округление до 2 знаков. Если данных < 2 —
 *   возвращает массив нулей и method='insufficient'. При 2 точках — линейная
 *   экстраполяция (method='linear'). При ≥3 — полиномиальная (method='poly2').
 */

function _round(n, p = 2) {
  if (!Number.isFinite(n)) return 0;
  const f = Math.pow(10, p);
  return Math.round(n * f) / f;
}

/** Решает систему 3×3 Ax=b методом Крамера. Возвращает [a,b,c] или null при det≈0. */
function _solve3(A, b) {
  const det = (m) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  if (!Number.isFinite(D) || Math.abs(D) < 1e-12) return null;
  const replace = (idx) => A.map((row, r) => row.map((v, c) => (c === idx ? b[r] : v)));
  return [det(replace(0)), det(replace(1)), det(replace(2))].map((v) => v / D);
}

/** Простая линейная регрессия для серий из 2+ точек. */
function _linearForecast(series, horizon) {
  const n = series.length;
  const xs = series.map((_, i) => i);
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = series.reduce((s, v) => s + v, 0) / n;
  let num = 0; let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (series[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = meanY - slope * meanX;
  const out = [];
  for (let i = 0; i < horizon; i++) {
    out.push(_round(Math.max(0, intercept + slope * (n + i))));
  }
  return out;
}

/**
 * Полиномиальная регрессия степени 2 на нормализованной x ∈ [0,1].
 * Возвращает массив прогнозных значений длины horizon (clamp ≥ 0, round 2).
 */
function _polyForecast(series, horizon) {
  const n = series.length;
  const xs = series.map((_, i) => i / Math.max(1, n - 1)); // [0..1]
  const ys = series.slice();

  let s0 = n, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
  let t0 = 0, t1 = 0, t2 = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i]; const y = ys[i];
    const x2 = x * x; const x3 = x2 * x; const x4 = x2 * x2;
    s1 += x; s2 += x2; s3 += x3; s4 += x4;
    t0 += y; t1 += y * x; t2 += y * x2;
  }
  const A = [[s0, s1, s2], [s1, s2, s3], [s2, s3, s4]];
  const b = [t0, t1, t2];
  const coef = _solve3(A, b);
  if (!coef) return _linearForecast(series, horizon);
  const [a, bb, c] = coef;
  const out = [];
  // Для будущих точек продолжаем тот же шаг нормализации.
  for (let i = 0; i < horizon; i++) {
    const x = (n + i) / Math.max(1, n - 1);
    out.push(_round(Math.max(0, a + bb * x + c * x * x)));
  }
  return out;
}

/**
 * Главная точка входа. series — массив чисел (любых конечных), horizon ∈ [1..12].
 */
function forecastMetric(series, horizon = 3) {
  const h = Math.max(1, Math.min(12, Math.round(Number(horizon) || 3)));
  const clean = (Array.isArray(series) ? series : [])
    .map((v) => Number(v))
    .map((v) => (Number.isFinite(v) ? v : 0));
  if (clean.length < 2) {
    return {
      historical: clean.map((v) => _round(v)),
      forecast: new Array(h).fill(0),
      method: 'insufficient',
      basis: clean.length,
    };
  }
  if (clean.length === 2) {
    return {
      historical: clean.map((v) => _round(v)),
      forecast: _linearForecast(clean, h),
      method: 'linear',
      basis: 2,
    };
  }
  return {
    historical: clean.map((v) => _round(v)),
    forecast: _polyForecast(clean, h),
    method: 'poly2',
    basis: clean.length,
  };
}

module.exports = { forecastMetric };
