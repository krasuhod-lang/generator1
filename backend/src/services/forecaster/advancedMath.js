'use strict';

/**
 * forecaster/advancedMath.js — нелинейная математика для «экспертного»
 * прогнозатора (см. opportunityAnalyzer.js и trafficModel.js).
 *
 * Все функции — детерминированные, без зависимостей, чистые. Считают
 * исключительно объёмные метрики (трафик, доли, ожидаемый прирост) —
 * никакой выручки, маржи или ROI (по требованию владельца продукта).
 *
 * Содержит четыре блока:
 *
 *   1. Логистический рост позиции (Verhulst).
 *      Используется, чтобы оценить ОЖИДАЕМУЮ позицию фразы через N
 *      месяцев работы при заданной конкуренции. Сигмоидная кривая
 *      между «pos_now» и «pos_floor» (нижний потолок, достижимый при
 *      данной нише): pos(t) = pos_floor + (pos_now − pos_floor) / (1+e^(k·(t−t₀))).
 *      В отличие от линейной экстраполяции, кривая корректно отражает,
 *      что в первые месяцы рост быстрый, а у потолка — замедляется.
 *
 *   2. Экспоненциальное затухание momentum.
 *      effect(t) = uplift_max · (1 − e^(−λ·t)). Используется для
 *      «realistic ramp-up» прогноза: если мы только начали работы, эффект
 *      проявляется не сразу, а накапливается. λ калибруется по effort_level.
 *
 *   3. Логарифмическая отдача от объёма работ.
 *      coverage_gain = α · ln(1 + units / scale). Закон убывающей
 *      предельной отдачи: первые 10 статей дают намного больше, чем
 *      следующие 10; в районе потолка эффект почти исчезает. Используется
 *      ClusterPlanner-экспертом для оценки «сколько контента нужно докинуть».
 *
 *   4. CTR-кривая степенного закона.
 *      CTR(p) = a · p^(−b). Гладкая аппроксимация дискретного
 *      ctrByPosition, нужна для оценки CTR при ДРОБНОЙ ожидаемой
 *      позиции (например, p̂ = 4.7). Параметры a, b калибруются один раз
 *      на табличных значениях config.traffic.ctrByPosition (см.
 *      calibratePowerLawCtr).
 *
 *   5. Log-normal композиция факторов.
 *      В лог-пространстве сумма независимых факторов даёт нормальное
 *      распределение → экспонента даёт лог-нормальное (всегда ≥ 0,
 *      длинный правый хвост). Это «честные» p10/p50/p90 для прогноза
 *      трафика: маленькая шумность даёт узкий доверительный интервал,
 *      большая — широкий. Симметричный CI (как в Holt-Winters) при
 *      этом систематически занижает верх и завышает низ.
 *
 *   6. Recovery potential.
 *      Для фразы/кластера, у которых сейчас просадка: ожидаемый прирост
 *      = (baseline − current) · sigmoid(effort/threshold). Сигмоида ставит
 *      порог «достаточности усилий»: ниже threshold — почти ноль, выше —
 *      почти полное восстановление. Используется в OpportunityHunter.
 *
 * Все границы (clamp, max-units, диапазон k и λ) — литеральные константы
 * с обоснованием в комментариях. Любая правка — через config.js (поля
 * forecaster.advanced.*).
 */

const { getForecasterConfig } = require('./config');

// ── Helpers ───────────────────────────────────────────────────────────

function _clamp(x, lo, hi) {
  if (!Number.isFinite(x)) return lo;
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

function _safeLn(x) {
  // защитное значение, чтобы не получать -Infinity
  if (!Number.isFinite(x) || x <= 0) return Math.log(1e-9);
  return Math.log(x);
}

function _erf(x) {
  // Abramowitz-Stegun 7.1.26 (макс. ошибка ~1.5e-7).
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1.0 / (1.0 + 0.3275911 * ax);
  const y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741)
    * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

function _normCdf(z) {
  return 0.5 * (1 + _erf(z / Math.SQRT2));
}

// ── 1. Logistic position growth (Verhulst) ────────────────────────────

/**
 * Логистическая траектория позиции по месяцам.
 *
 * pos(t) = pos_floor + (pos_now − pos_floor) / (1 + exp(k·(t − t0)))
 *
 * @param {Object} args
 * @param {number} args.posNow    текущая позиция (1..100+); 0/null → 100.
 * @param {number} args.posFloor  целевой потолок (например, 3 для top-3).
 * @param {number} args.t         месяцев работы прошло (0..horizon).
 * @param {number} [args.k]       крутизна; по умолчанию из config.
 * @param {number} [args.t0]      сдвиг точки перегиба; по умолчанию из config.
 *                                Зависит от competition: тяжёлая ниша → больший t0.
 * @returns {number} ожидаемая позиция (округлено до 0.1, в диапазоне [1, 200]).
 */
function logisticPosition({ posNow, posFloor, t, k, t0 } = {}) {
  const cfg = getForecasterConfig().advanced.logistic;
  const p0 = _clamp(Number(posNow) > 0 ? Number(posNow) : 100, 1, 200);
  const pf = _clamp(Number(posFloor) > 0 ? Number(posFloor) : 10, 1, 100);
  const tt = _clamp(Number(t) >= 0 ? Number(t) : 0, 0, 36);
  const kk = Number.isFinite(k) ? k : cfg.kDefault;
  const t0v = Number.isFinite(t0) ? t0 : cfg.t0Default;
  // Если уже в целевом коридоре — не «улучшаем искусственно».
  if (p0 <= pf) return Math.round(p0 * 10) / 10;
  const denom = 1 + Math.exp(kk * (tt - t0v));
  const pos = pf + (p0 - pf) / denom;
  return Math.round(_clamp(pos, 1, 200) * 10) / 10;
}

/**
 * Подбор k и t0 по силе конкуренции (0..1) и effort_level (0..1).
 * Высокая конкуренция → больший t0 (медленнее), меньший k (плавнее).
 * Высокий effort → меньший t0 (быстрее), больший k (резче).
 */
function calibrateLogistic({ competition = 0.5, effort = 0.5 } = {}) {
  const cfg = getForecasterConfig().advanced.logistic;
  const comp = _clamp(competition, 0, 1);
  const eff  = _clamp(effort, 0, 1);
  // t0: от t0Min (лёгкая ниша + сильное effort) до t0Max (тяжёлая ниша + слабое).
  // Линейная интерполяция: t0 = t0Min + (t0Max − t0Min) · (comp − eff/2 + 0.5).
  const tNorm = _clamp(comp - eff * 0.5 + 0.5, 0, 1);
  const t0    = cfg.t0Min + (cfg.t0Max - cfg.t0Min) * tNorm;
  // k растёт с effort, падает с конкуренцией.
  const kNorm = _clamp(eff - comp * 0.5 + 0.5, 0, 1);
  const k     = cfg.kMin + (cfg.kMax - cfg.kMin) * kNorm;
  return { k: Math.round(k * 1000) / 1000, t0: Math.round(t0 * 10) / 10 };
}

// ── 2. Exponential momentum decay ─────────────────────────────────────

/**
 * Накопление эффекта от работ: effect(t) = uplift_max · (1 − e^(−λ·t)).
 * Через t = ln(2)/λ месяцев достигается половина uplift; через 3/λ ≈ 95 %.
 *
 * @param {Object} args
 * @param {number} args.upliftMax  верхняя граница (например, реалистичный uplift).
 * @param {number} args.t          месяцев работы.
 * @param {number} [args.lambda]   скорость; по умолчанию из config.
 * @returns {number} текущий уровень эффекта.
 */
function momentumRampUp({ upliftMax, t, lambda } = {}) {
  const cfg = getForecasterConfig().advanced.momentum;
  const um = Number(upliftMax) || 0;
  const tt = _clamp(Number(t) >= 0 ? Number(t) : 0, 0, 36);
  const lm = Number.isFinite(lambda) ? lambda : cfg.lambdaDefault;
  const factor = 1 - Math.exp(-lm * tt);
  return um * _clamp(factor, 0, 1);
}

/**
 * Калибровка λ по effort_level (0..1). Сильнее effort → быстрее
 * выход на полную мощность.
 */
function calibrateMomentumLambda(effort = 0.5) {
  const cfg = getForecasterConfig().advanced.momentum;
  const e = _clamp(effort, 0, 1);
  const l = cfg.lambdaMin + (cfg.lambdaMax - cfg.lambdaMin) * e;
  return Math.round(l * 1000) / 1000;
}

// ── 3. Log-returns on content volume ──────────────────────────────────

/**
 * Закон убывающей предельной отдачи: gain = α · ln(1 + units / scale).
 *
 * Интерпретация: при units = scale получаем α · ln(2) ≈ 0.693·α;
 * чтобы удвоить gain, нужно умножить units примерно на e ≈ 2.72.
 *
 * @param {Object} args
 * @param {number} args.units    объём работ (статьи, лендинги, доработки).
 * @param {number} [args.alpha]  масштаб эффекта (по умолчанию из config).
 * @param {number} [args.scale]  «единичный» объём (по умолчанию из config).
 * @returns {number} ожидаемый coverage_gain (0..alpha·ln(units_max)).
 */
function logReturns({ units, alpha, scale } = {}) {
  const cfg = getForecasterConfig().advanced.logReturns;
  const u = Math.max(0, Number(units) || 0);
  const a = Number.isFinite(alpha) ? alpha : cfg.alphaDefault;
  const s = Number.isFinite(scale) && scale > 0 ? scale : cfg.scaleDefault;
  if (u === 0) return 0;
  return a * Math.log(1 + u / s);
}

/**
 * Обратная функция: сколько units нужно, чтобы достичь target_gain?
 * units = scale · (e^(target/α) − 1)
 */
function logReturnsUnitsFor(targetGain, { alpha, scale } = {}) {
  const cfg = getForecasterConfig().advanced.logReturns;
  const tg = Math.max(0, Number(targetGain) || 0);
  const a = Number.isFinite(alpha) ? alpha : cfg.alphaDefault;
  const s = Number.isFinite(scale) && scale > 0 ? scale : cfg.scaleDefault;
  if (tg === 0 || a <= 0) return 0;
  return Math.round(s * (Math.exp(tg / a) - 1));
}

// ── 4. Power-law CTR curve ────────────────────────────────────────────

/**
 * Одноразовая калибровка степенной кривой CTR по дискретной таблице
 * ctrByPosition. Аппроксимация: log(ctr) = log(a) + (−b) · log(p).
 *
 * Возвращает { a, b, r_squared }.
 */
function calibratePowerLawCtr(ctrByPosition) {
  const xs = [];
  const ys = [];
  for (const [pStr, c] of Object.entries(ctrByPosition || {})) {
    const p = Number(pStr);
    const cc = Number(c);
    if (p > 0 && cc > 0) {
      xs.push(Math.log(p));
      ys.push(Math.log(cc));
    }
  }
  const n = xs.length;
  if (n < 2) return { a: 0.281, b: 1.0, r_squared: 0 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i]*xs[i]; sxy += xs[i]*ys[i]; }
  const denom = n * sxx - sx * sx;
  const slope = denom === 0 ? -1 : (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const a = Math.exp(intercept);
  const b = -slope; // CTR ↓ с ростом p → slope отрицательный
  const meanY = sy / n;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    const pred = intercept + slope * xs[i];
    ssTot += (ys[i] - meanY) ** 2;
    ssRes += (ys[i] - pred)  ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { a: Math.round(a * 10000) / 10000, b: Math.round(b * 1000) / 1000, r_squared: Math.round(r2 * 1000) / 1000 };
}

/**
 * CTR при дробной позиции по power-law CTR(p) = a · p^(−b).
 * Если параметры не заданы — берутся из config.advanced.ctrPowerLaw
 * (откалиброванные на config.traffic.ctrByPosition в _bootstrapDefaults).
 */
function ctrAtPosition(p, { a, b } = {}) {
  const cfg = getForecasterConfig().advanced.ctrPowerLaw;
  const aa = Number.isFinite(a) ? a : cfg.a;
  const bb = Number.isFinite(b) ? b : cfg.b;
  const pp = _clamp(Number(p) > 0 ? Number(p) : 50, 0.5, 100);
  return aa * Math.pow(pp, -bb);
}

// ── 5. Log-normal composition (multi-factor CI) ───────────────────────

/**
 * Считает p10/p50/p90 (или произвольные percentile) от мультипликативной
 * композиции независимых факторов с лог-нормальным шумом.
 *
 * Идея: log(traffic) = Σ log(factor_i) + ε, где ε ~ N(0, σ²).
 * Тогда traffic ~ lognormal(μ, σ²), и:
 *   p_q = exp(μ + σ · z_q),
 * где z_q — q-квантиль стандартной нормали.
 *
 * @param {Object} args
 * @param {Array<number>} args.factors  список положительных множителей.
 * @param {number} [args.sigmaLog]      σ в лог-пространстве (по умолчанию из config).
 * @param {Array<number>} [args.quantiles] список квантилей (0..1).
 * @returns {{p50:number, p10:number, p90:number, mu:number, sigma:number}}
 */
function lognormalCompose({ factors, sigmaLog, quantiles } = {}) {
  const cfg = getForecasterConfig().advanced.lognormal;
  const fs = Array.isArray(factors) ? factors.filter((x) => Number(x) > 0) : [];
  if (fs.length === 0) {
    return { p50: 0, p10: 0, p90: 0, mu: 0, sigma: 0 };
  }
  const mu = fs.reduce((a, x) => a + _safeLn(x), 0);
  const sigma = Number.isFinite(sigmaLog) && sigmaLog >= 0 ? sigmaLog : cfg.sigmaDefault;
  const qList = Array.isArray(quantiles) && quantiles.length > 0 ? quantiles : [0.1, 0.5, 0.9];
  // Численная инверсия normCdf (бисекция, 50 итераций → точность ~1e-15).
  const _invNorm = (q) => {
    let lo = -8, hi = 8;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (_normCdf(mid) < q) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const out = {};
  for (const q of qList) {
    const z = _invNorm(q);
    out[`p${Math.round(q * 100)}`] = Math.exp(mu + sigma * z);
  }
  out.mu = Math.round(mu * 1000) / 1000;
  out.sigma = sigma;
  return out;
}

// ── 6. Recovery potential ─────────────────────────────────────────────

/**
 * Ожидаемое восстановление трафика для просевшей фразы/кластера.
 *
 *   gap = max(0, baseline − current)
 *   recovery = gap · σ((effort − threshold) / softness)
 *
 * Где σ — стандартная сигмоида. Ниже threshold — recovery почти ноль
 * (мало усилий), выше — почти полный gap.
 *
 * @param {Object} args
 * @param {number} args.baseline   медиана baseline-периода (до просадки).
 * @param {number} args.current    текущий уровень.
 * @param {number} args.effort     уровень усилий 0..1 (или интерпретация ClusterPlanner-а).
 * @param {number} [args.threshold] порог; default из config.
 * @param {number} [args.softness]  «крутизна» сигмоиды; default из config.
 * @returns {{gap:number, recovery:number, recovery_fraction:number}}
 */
function recoveryPotential({ baseline, current, effort, threshold, softness } = {}) {
  const cfg = getForecasterConfig().advanced.recovery;
  const b = Math.max(0, Number(baseline) || 0);
  const c = Math.max(0, Number(current)  || 0);
  const e = _clamp(Number(effort) || 0, 0, 1);
  const th = Number.isFinite(threshold) ? threshold : cfg.thresholdDefault;
  const sw = Number.isFinite(softness) && softness > 0 ? softness : cfg.softnessDefault;
  const gap = Math.max(0, b - c);
  if (gap === 0) return { gap: 0, recovery: 0, recovery_fraction: 0 };
  const z = (e - th) / sw;
  const sigmoid = 1 / (1 + Math.exp(-z));
  const rec = gap * sigmoid;
  return {
    gap: Math.round(gap),
    recovery: Math.round(rec),
    recovery_fraction: Math.round(sigmoid * 1000) / 1000,
  };
}

// ── Bootstrap power-law params from current ctrByPosition ─────────────
// Вызывается при require, чтобы a/b в config были согласованы с
// дискретной таблицей ctrByPosition. Не пишет ничего в config (deepFrozen),
// просто использует свой кэш.
let _ctrParamsCache = null;
function _bootstrapCtrParams() {
  if (_ctrParamsCache) return _ctrParamsCache;
  const cfg = getForecasterConfig();
  _ctrParamsCache = calibratePowerLawCtr(cfg.traffic.ctrByPosition);
  return _ctrParamsCache;
}

module.exports = {
  logisticPosition,
  calibrateLogistic,
  momentumRampUp,
  calibrateMomentumLambda,
  logReturns,
  logReturnsUnitsFor,
  calibratePowerLawCtr,
  ctrAtPosition,
  lognormalCompose,
  recoveryPotential,
  _bootstrapCtrParams,
  _clamp,
  _normCdf,
};
