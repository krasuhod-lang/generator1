'use strict';

/**
 * forecaster/forecast.js — прогноз на 12 месяцев и линия тренда.
 *
 * Содержит:
 *   • holtWintersAdditive(series, opts) — Holt-Winters additive model
 *     (level + trend + seasonality). Грид-серч α/β/γ по MSE на in-sample,
 *     минимизирует сумму квадратов остатков.
 *   • olsTrend(series) — линейная регрессия y = a + b·t (Ordinary Least
 *     Squares), R².
 *   • buildForecast(monthly) — главный вход: выбирает модель в зависимости
 *     от длины ряда, возвращает прогноз с 95 % CI и trend-линией.
 *
 * Все вычисления — детерминированные, без зависимостей.
 */

const { getForecasterConfig } = require('./config');
const { _periodToIndex, _indexToPeriod } = require('./series');

// ─── OLS-тренд y = a + b*t ─────────────────────────────────────────
function olsTrend(values) {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: values[0] || 0, r_squared: 0 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += values[i];
    sxx += i * i;
    sxy += i * values[i];
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { slope: 0, intercept: sy / n, r_squared: 0 };
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  // R²
  const meanY = sy / n;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    const pred = intercept + slope * i;
    ssRes += (values[i] - pred) ** 2;
    ssTot += (values[i] - meanY) ** 2;
  }
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  return { slope, intercept, r_squared: r2 };
}

// ─── Holt-Winters additive (Roberts, 1959) ─────────────────────────
// y_hat_{t+h} = L_t + h*T_t + S_{t+h-m}
function _initSeasonal(values, m) {
  // среднее по сезону для первых полных циклов
  const seasons = Math.max(1, Math.floor(values.length / m));
  const seasonAvg = [];
  for (let s = 0; s < seasons; s++) {
    const slice = values.slice(s * m, (s + 1) * m);
    const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
    seasonAvg.push(avg);
  }
  const overallAvg = seasonAvg.reduce((a, b) => a + b, 0) / seasonAvg.length;
  // S_i = mean_over_seasons(y_{s*m+i}) - overallAvg
  const S = new Array(m).fill(0);
  for (let i = 0; i < m; i++) {
    let acc = 0, cnt = 0;
    for (let s = 0; s < seasons; s++) {
      const idx = s * m + i;
      if (idx < values.length) { acc += values[idx] - overallAvg; cnt += 1; }
    }
    S[i] = cnt > 0 ? acc / cnt : 0;
  }
  return { L0: overallAvg, T0: 0, S };
}

function holtWintersAdditive(values, m, alpha, beta, gamma) {
  const n = values.length;
  if (n < m * 2) return null; // нужно хотя бы 2 полных сезона
  const { L0, T0, S } = _initSeasonal(values, m);
  let L = L0;
  let T = T0;
  const Sarr = [...S];
  const residuals = [];
  for (let t = 0; t < n; t++) {
    const sIdx = t % m;
    const Lprev = L;
    const Tprev = T;
    L = alpha * (values[t] - Sarr[sIdx]) + (1 - alpha) * (Lprev + Tprev);
    T = beta  * (L - Lprev)              + (1 - beta)  * Tprev;
    Sarr[sIdx] = gamma * (values[t] - L) + (1 - gamma) * Sarr[sIdx];
    const pred = Lprev + Tprev + S[sIdx]; // одношаговый прогноз на t (использует исходные сезонные коэф.)
    residuals.push(values[t] - pred);
  }
  // MSE in-sample (для grid-search), исключая первые m точек (warm-up)
  const warm = Math.min(m, residuals.length);
  let sse = 0, cnt = 0;
  for (let i = warm; i < residuals.length; i++) {
    sse += residuals[i] ** 2;
    cnt += 1;
  }
  const mse = cnt > 0 ? sse / cnt : Infinity;
  // std остатков (для CI)
  const stdRes = cnt > 0 ? Math.sqrt(sse / cnt) : 0;
  return { L, T, S: Sarr, mse, stdRes, residuals };
}

function _gridSearchHW(values, m, cfg) {
  let best = null;
  for (const a of cfg.gridAlpha) {
    for (const b of cfg.gridBeta) {
      for (const g of cfg.gridGamma) {
        const fit = holtWintersAdditive(values, m, a, b, g);
        if (!fit) return null;
        if (!best || fit.mse < best.mse) {
          best = { ...fit, alpha: a, beta: b, gamma: g };
        }
      }
    }
  }
  return best;
}

function _forecastFromHW(fit, m, horizon) {
  const out = [];
  for (let h = 1; h <= horizon; h++) {
    const sIdx = (fit.S.length + (h - 1)) % m; // циклический индекс сезонных коэф.
    const v = fit.L + h * fit.T + fit.S[sIdx];
    out.push(Math.max(0, v));
  }
  return out;
}

// ─── EMA для красивой trend-линии ──────────────────────────────────
function ema(values, alpha) {
  if (!values.length) return [];
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(alpha * values[i] + (1 - alpha) * out[i - 1]);
  }
  return out;
}

// ─── главный API ───────────────────────────────────────────────────
/**
 * @param {Array<{period:string, demand:number}>} monthly
 * @returns {{
 *   horizon: number,
 *   method: string,
 *   points: Array<{period:string, value:number, lo:number, hi:number}>,
 *   trend: {slope_per_month, intercept, direction, r_squared, ema:number[]},
 *   annual_total: number,
 *   residual_std: number,
 *   params?: object,
 *   fallback_reason?: string,
 * }}
 */
function buildForecast(monthly) {
  const cfg = getForecasterConfig().forecast;
  const values = monthly.map((p) => p.demand);
  const n = values.length;

  // OLS-тренд на полных данных (всегда, для UI)
  const tr = olsTrend(values);
  const direction = tr.slope > 0.0001 * (Math.max(...values, 1)) ? 'up'
                  : tr.slope < -0.0001 * (Math.max(...values, 1)) ? 'down'
                  : 'flat';
  const emaSeries = ema(values, 0.3);

  if (n < cfg.minPointsForAnyModel) {
    return {
      horizon: cfg.horizonMonths,
      method: 'insufficient_data',
      points: [],
      trend: {
        slope_per_month: tr.slope,
        intercept: tr.intercept,
        direction,
        r_squared: tr.r_squared,
        ema: emaSeries,
      },
      annual_total: 0,
      residual_std: 0,
      fallback_reason: `Нужно минимум ${cfg.minPointsForAnyModel} точек, получено ${n}`,
    };
  }

  const lastIdx = _periodToIndex(monthly[n - 1].period);

  // Holt-Winters путь (предпочтительный)
  let method = 'holt_winters_additive';
  let fcstValues = null;
  let stdRes = 0;
  let params = null;
  let fallbackReason = null;

  if (n >= cfg.minPointsForHoltWinters) {
    const fit = _gridSearchHW(values, cfg.season, cfg);
    if (fit) {
      fcstValues = _forecastFromHW(fit, cfg.season, cfg.horizonMonths);
      stdRes = fit.stdRes;
      params = { alpha: fit.alpha, beta: fit.beta, gamma: fit.gamma, mse: Math.round(fit.mse * 100) / 100 };
    } else {
      fallbackReason = 'Holt-Winters не сходится — используем трендовую модель';
    }
  } else {
    fallbackReason = `Меньше ${cfg.minPointsForHoltWinters} точек — Holt-Winters не применим, fallback на трендовую модель`;
  }

  if (!fcstValues) {
    // Fallback: OLS-тренд + аддитивная средняя сезонность по доступным точкам
    method = 'trend_with_seasonal_means';
    const seasonalDelta = new Array(cfg.season).fill(0);
    const meanY = values.reduce((a, b) => a + b, 0) / n;
    const seasonalCount = new Array(cfg.season).fill(0);
    for (let i = 0; i < n; i++) {
      const pred = tr.intercept + tr.slope * i;
      const monthOfYear = (_periodToIndex(monthly[i].period)) % cfg.season;
      seasonalDelta[monthOfYear] += values[i] - pred;
      seasonalCount[monthOfYear] += 1;
    }
    for (let i = 0; i < cfg.season; i++) {
      seasonalDelta[i] = seasonalCount[i] > 0 ? seasonalDelta[i] / seasonalCount[i] : 0;
    }
    fcstValues = [];
    let ssRes = 0;
    for (let i = 0; i < n; i++) {
      const moy = (_periodToIndex(monthly[i].period)) % cfg.season;
      const pred = tr.intercept + tr.slope * i + seasonalDelta[moy];
      ssRes += (values[i] - pred) ** 2;
    }
    stdRes = Math.sqrt(ssRes / Math.max(1, n - 2));
    for (let h = 1; h <= cfg.horizonMonths; h++) {
      const t = n - 1 + h;
      const moy = (lastIdx + h) % cfg.season;
      const v = tr.intercept + tr.slope * t + seasonalDelta[moy];
      fcstValues.push(Math.max(0, v));
    }
    // если "n" слишком мал — на меньше чем m+2 точек, ещё гарантируем что
    // фолбэк хоть какой-то даёт; для совсем коротких рядов sin-сезонности
    // не будет, что ожидаемо.
    if (Math.abs(meanY) < 1e-9 && n < cfg.season) {
      fallbackReason = (fallbackReason || '') + ' (короткий ряд: сезонность не выявлена)';
    }
  }

  // 95 % CI
  const z = cfg.confidenceZ;
  const points = fcstValues.map((v, h) => {
    // расширяем CI с шагом √h (классический подход для модели с независимыми остатками)
    const widen = Math.sqrt(h + 1);
    return {
      period: _indexToPeriod(lastIdx + h + 1),
      value: Math.round(v),
      lo: Math.max(0, Math.round(v - z * stdRes * widen)),
      hi: Math.round(v + z * stdRes * widen),
    };
  });
  const annualTotal = Math.round(points.reduce((a, p) => a + p.value, 0));

  return {
    horizon: cfg.horizonMonths,
    method,
    points,
    trend: {
      slope_per_month: tr.slope,
      intercept: tr.intercept,
      direction,
      r_squared: Math.round(tr.r_squared * 1000) / 1000,
      ema: emaSeries.map((v) => Math.round(v)),
    },
    annual_total: annualTotal,
    residual_std: Math.round(stdRes * 100) / 100,
    params,
    fallback_reason: fallbackReason,
  };
}

module.exports = {
  buildForecast,
  olsTrend,
  holtWintersAdditive,
  ema,
};
