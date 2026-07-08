'use strict';

/**
 * forecaster/sovForecast.js — детерминированная модель SOV (доли рынка).
 *
 * Без внешних зависимостей: входом служат история спроса, готовые точки прогноза
 * и параметры коммерциализации/SERP. Результат сохраняется в JSONB snake_case.
 */

function _clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function _periodToIndex(period) {
  const m = String(period || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 12 + Number(m[2]) - 1;
}

function _indexToPeriod(idx) {
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

function _nextPeriods(monthly, forecastPoints, hMax) {
  const periods = [];
  for (const p of (forecastPoints || [])) {
    if (periods.length >= hMax) break;
    if (p && p.period) periods.push(String(p.period));
  }
  if (periods.length >= hMax) return periods;
  const last = periods[periods.length - 1]
    || (monthly && monthly.length ? monthly[monthly.length - 1].period : null);
  const lastIdx = _periodToIndex(last);
  if (lastIdx == null) {
    while (periods.length < hMax) periods.push(`m+${periods.length + 1}`);
    return periods;
  }
  let nextIdx = lastIdx + 1;
  while (periods.length < hMax) periods.push(_indexToPeriod(nextIdx++));
  return periods;
}

function _extendDemand(monthly, forecastPoints, hMax) {
  const out = (forecastPoints || [])
    .slice(0, hMax)
    .map((p) => Math.max(0, Number(p && p.value) || 0));
  if (out.length >= hMax) return out;

  // Если buildForecast вернул меньше точек, повторяем последний сезонный цикл
  // из прогноза, а если его нет — из исторического спроса. Так сохраняем форму
  // сезонности без догадок о параметрах исходной модели.
  const seasonalSource = out.length > 0
    ? out
    : (monthly || []).map((p) => Math.max(0, Number(p && p.demand) || 0));
  const cycle = seasonalSource.slice(-12);
  const fallback = cycle.length ? cycle : [0];
  while (out.length < hMax) out.push(fallback[out.length % fallback.length]);
  return out;
}

function _serpCoefficient(serpElements, weights) {
  let penalty = 0;
  for (const el of (Array.isArray(serpElements) ? serpElements : [])) {
    if (!el || typeof el !== 'object') continue;
    const type = String(el.type || 'other');
    const count = Math.max(0, Number(el.count) || 0);
    penalty += (Number(weights[type]) || Number(weights.other) || 0) * count;
  }
  return Math.max(0.1, 1.0 - penalty);
}

function buildSovForecast({
  monthly,
  forecastPoints,
  vCurrent = 0,
  hMax = 12,
  crBase = 0,
  commPercent = 1,
  serpElements = [],
  clusterVolume = 0,
  mainQueryVolume = 0,
  cfg = {},
  unifiedForecast = null,
  startMonth = null,
}) {
  const sovCfg = cfg.sov || cfg || {};
  const scenariosCfg = sovCfg.scenarios || {
    pessimistic: { pTarget: 7, k: 0.15 },
    realistic:   { pTarget: 3, k: 0.25 },
    optimistic:  { pTarget: 1, k: 0.40 },
  };
  const ctr = sovCfg.ctrByPosition || sovCfg.ctr_by_position || { 1: 0.28, 3: 0.11, 7: 0.03 };
  const weights = sovCfg.serpWeights || sovCfg.serp_weights || { direct: 0.10, maps: 0.15, market: 0.12, goods_gallery: 0.12, other: 0.05 };
  const limit = Math.max(1, Number(sovCfg.hMaxLimit || sovCfg.h_max_limit) || 24);
  const horizon = Math.max(1, Math.min(limit, Number(hMax) || Number(sovCfg.hMaxDefault || sovCfg.h_max_default) || 12));

  let lambda = Number(clusterVolume) / Number(mainQueryVolume);
  if (!Number.isFinite(lambda) || lambda < 1) lambda = 1.5;
  lambda = Math.round(lambda * 10000) / 10000;

  // G — минимальный гарантированный рост SOV (алгоритмическая защита от
  // падения): цель сценария не может быть ниже текущей доли × (1+G).
  const minGrowth = Math.max(0, Number(sovCfg.minGrowth ?? sovCfg.min_growth ?? 0.2) || 0);

  const cSerp = Math.round(_serpCoefficient(serpElements, weights) * 10000) / 10000;
  const comm = _clamp(commPercent == null ? 1 : commPercent, 0, 1);
  const crFinal = Math.round(Math.max(0, Number(crBase) || 0) * comm * 100000) / 100000;
  const d0 = (monthly && monthly.length) ? Math.max(0, Number(monthly[monthly.length - 1].demand) || 0) : 0;
  const currentTraffic = Math.max(0, Number(vCurrent) || 0);
  const sovCurrent = d0 > 0 ? _clamp(currentTraffic / d0, 0, 1) : 0;

  const demands = _extendDemand(monthly || [], forecastPoints || [], horizon);
  // Периоды берём в приоритете из единой модели (если она есть) — тогда обе
  // диаграммы (Прогноз трафика и SOV) идут по одной и той же оси времени
  // (с учётом start_month). Иначе — из forecastPoints/monthly.
  let periods;
  const unifiedFc = unifiedForecast && Array.isArray(unifiedForecast.forecast)
    ? unifiedForecast.forecast.slice(0, horizon)
    : null;
  if (unifiedFc && unifiedFc.length) {
    periods = unifiedFc.map((p) => String(p.period));
    // Добираем оставшиеся месяцы календарно (если h_max > длины unified.forecast).
    if (periods.length < horizon) {
      const tail = _nextPeriods(monthly || [], forecastPoints || [], horizon);
      periods = periods.concat(tail.slice(periods.length));
    }
  } else if (startMonth && /^\d{4}-\d{2}$/.test(String(startMonth))) {
    // Отсчёт от месяца старта работ.
    const startIdx = _periodToIndex(String(startMonth));
    periods = [];
    let idx = startIdx;
    while (periods.length < horizon) periods.push(_indexToPeriod(idx++));
  } else {
    periods = _nextPeriods(monthly || [], forecastPoints || [], horizon);
  }
  const scenarios = {};

  for (const name of ['pessimistic', 'realistic', 'optimistic']) {
    const sc = scenariosCfg[name] || {};
    const pTarget = Math.max(1, Math.round(Number(sc.pTarget ?? sc.p_target) || 1));
    const k = Math.max(0, Number(sc.k) || 0);
    const targetCtr = Number(ctr[pTarget]) || 0;
    // sov_target ≥ sov_current·(1+G): прогнозируемая доля рынка никогда не
    // опускается ниже текущей (защита от падения).
    const sovTarget = _clamp(Math.max(targetCtr * cSerp * lambda, sovCurrent * (1 + minGrowth)), 0, 1);
    const traffic = [];
    const leads = [];
    const sov = [];
    for (let h = 1; h <= horizon; h++) {
      const sovH = sovTarget + (sovCurrent - sovTarget) * Math.exp(-k * h);
      const v = Math.round(demands[h - 1] * sovH);
      traffic.push(v);
      leads.push(Math.round(v * crFinal * 10) / 10);
      sov.push(Math.round(sovH * 10000) / 10000);
    }
    scenarios[name] = {
      p_target: pTarget,
      k,
      sov_target: Math.round(sovTarget * 10000) / 10000,
      sov,
      traffic,
      leads,
    };
  }

  // Синхронизация с единой моделью: «реалистичный» сценарий должен показывать
  // тот же трафик, что и график «🚀 Прогноз трафика». Раньше два графика
  // считали трафик независимо (SOV не учитывал C_yield и логистику захвата),
  // отсюда «на 2-м месяце трафик совершенно другой». Теперь realistic-линия и
  // capture берутся из unifiedForecast, а пессимистичный/оптимистичный
  // сохраняют роль коридора (перерасчёт трафика от новых SOV-таргетов).
  if (unifiedFc && unifiedFc.length) {
    const realTraffic = [];
    const realLeads = [];
    const realSov = [];
    for (let h = 0; h < horizon; h++) {
      const u = unifiedFc[h];
      if (u) {
        const v = Math.max(0, Math.round(Number(u.value) || 0));
        realTraffic.push(v);
        realLeads.push(Math.round(v * crFinal * 10) / 10);
        realSov.push(_clamp(Number(u.capture) || 0, 0, 1));
      } else {
        // Хвост за пределом unified: fallback на прежний расчёт.
        realTraffic.push(scenarios.realistic.traffic[h] || 0);
        realLeads.push(scenarios.realistic.leads[h] || 0);
        realSov.push((scenarios.realistic.sov[h] || 0) / 1);
      }
    }
    const realSovTarget = realSov.length
      ? _clamp(realSov[realSov.length - 1], 0, 1)
      : scenarios.realistic.sov_target;
    scenarios.realistic = {
      p_target: scenarios.realistic.p_target,
      k: scenarios.realistic.k,
      sov_target: Math.round(realSovTarget * 10000) / 10000,
      sov: realSov.map((v) => Math.round(v * 10000) / 10000),
      traffic: realTraffic,
      leads: realLeads,
      source: 'unified',
    };
    // Пессимистичный ≤ реалистичный ≤ оптимистичный на каждом месяце
    // (коридор не должен пересекать реалистичную линию).
    for (let h = 0; h < horizon; h++) {
      const rv = realTraffic[h];
      if (scenarios.pessimistic.traffic[h] > rv) scenarios.pessimistic.traffic[h] = rv;
      if (scenarios.optimistic.traffic[h] < rv) scenarios.optimistic.traffic[h] = rv;
    }
  }

  const real = scenarios.realistic;
  const lastIdx = horizon - 1;
  return {
    constants: {
      lambda,
      c_serp: cSerp,
      cr_final: crFinal,
      min_growth: minGrowth,
      sov_current: Math.round(sovCurrent * 10000) / 10000,
      d0,
    },
    h_max: horizon,
    periods,
    scenarios,
    summary: {
      sov: {
        current: Math.round(sovCurrent * 10000) / 10000,
        target: real.sov_target,
      },
      traffic: {
        current: currentTraffic,
        at_h: real.traffic[lastIdx] || 0,
        total: real.traffic.reduce((a, b) => a + b, 0),
      },
      leads: {
        current: Math.round(currentTraffic * crFinal * 10) / 10,
        at_h: real.leads[lastIdx] || 0,
        total: Math.round(real.leads.reduce((a, b) => a + b, 0) * 10) / 10,
      },
    },
  };
}

module.exports = { buildSovForecast };
