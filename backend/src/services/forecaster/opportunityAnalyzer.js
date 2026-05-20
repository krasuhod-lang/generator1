'use strict';

/**
 * forecaster/opportunityAnalyzer.js — детектор «точечных просадок» и
 * генератор ранжированных «точек усиления».
 *
 * Назначение: вместо одного сводного прогноза по ядру дать клиенту
 * конкретный список «что именно подняли бы, и сколько трафика/заявок
 * это даст». Использует advancedMath (logistic + log-returns + recovery)
 * и keysso_signals (если есть).
 *
 * Алгоритм:
 *   1. Берём фразу-кандидаты (после junk-фильтра).
 *   2. Для каждой считаем:
 *        • baseline — медиана demand за все месяцы (или прошлый год),
 *        • current  — среднее по 3 последним месяцам,
 *        • drop_pct = (baseline − current) / baseline,
 *        • current_position — из keys.so (или null),
 *        • competition      — из keys.so (или null),
 *        • momentum_delta   — из keys.so (или null).
 *   3. Если phrase имеет drop_pct >= opportunity.minGapPct ИЛИ
 *      current_position > 10 при demand > P50 ядра — phrase = opportunity.
 *   4. Для каждого effort_level (low/mid/high) считаем:
 *        • target_pos via logisticPosition (с calibrateLogistic),
 *        • expected_ctr via ctrAtPosition(target_pos),
 *        • expected_traffic_per_month = baseline_demand × expected_ctr,
 *        • expected_traffic_recovery   via recoveryPotential
 *          (для просевших фраз),
 *        • expected_leads_per_month = expected_traffic × CR.
 *   5. composite_score = w_gap·gap_share + w_vol·log(1+demand)/log_norm +
 *        w_comp·(1−competition) + w_mom·momentum_penalty.
 *      Сортируем по composite_score desc, берём top-N global и top-N
 *      кластеров.
 *
 * Возвращает структуру (всё в виде объёмных метрик, никакой выручки):
 *   {
 *     verdict: 'ok'|'skipped',
 *     opportunities: [...],   // top-N global
 *     clusters: [...],        // top-N кластеров (group by char-bigram)
 *     summary: { total, high_priority, ... },
 *     calibration: { ... }    // используемые параметры
 *   }
 */

const { getForecasterConfig } = require('./config');
const {
  logisticPosition, calibrateLogistic,
  momentumRampUp, calibrateMomentumLambda,
  logReturns,
  ctrAtPosition,
  recoveryPotential,
  lognormalCompose,
  _clamp,
} = require('./advancedMath');

// ── Helpers ───────────────────────────────────────────────────────────

function _median(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function _normPhrase(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Char-bigram cosine cluster key. Группирует семантически близкие фразы
 * (например, "купить пластиковые окна" + "пластиковые окна цена" → один
 * кластер). Используется тот же подход, что в cocoon_planner.
 */
function _charBigrams(s) {
  const t = '  ' + _normPhrase(s) + '  ';
  const out = new Map();
  for (let i = 0; i < t.length - 1; i++) {
    const bi = t.slice(i, i + 2);
    out.set(bi, (out.get(bi) || 0) + 1);
  }
  return out;
}

function _bigramCosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [k, v] of a) {
    na += v * v;
    const vb = b.get(k);
    if (vb) dot += v * vb;
  }
  for (const [, v] of b) nb += v * v;
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Извлекает per-phrase сигналы из keys.so Map (см. keyssoClient.fetchPhraseSignals).
 */
function _signalsFor(phrase, keyssoSignalsMap) {
  if (!keyssoSignalsMap || typeof keyssoSignalsMap.get !== 'function') return null;
  const sig = keyssoSignalsMap.get(_normPhrase(phrase));
  return sig || null;
}

// ── Per-phrase opportunity scoring ────────────────────────────────────

/**
 * Считает baseline/current/drop для одной фразы по её помесячному ряду.
 * row: { phrase, total, [month_period]: value, ... }
 * monthCols: ['2024-01', '2024-02', ...]
 */
function _phraseDynamics(row, monthCols, tailWindow = 3) {
  const series = [];
  for (const m of monthCols) {
    const v = Number(row[m] || 0);
    series.push(v);
  }
  const baseline = Math.round(_median(series));
  const tail = series.slice(-tailWindow);
  const current = tail.length > 0
    ? Math.round(tail.reduce((a, b) => a + b, 0) / tail.length)
    : 0;
  const dropPct = baseline > 0 ? Math.max(0, (baseline - current) / baseline) : 0;
  // Тренд за последние 6 точек (упрощённый OLS-slope per month).
  const recent = series.slice(-6);
  let trendPerMonth = 0;
  if (recent.length >= 3) {
    const n = recent.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sx += i; sy += recent[i]; sxx += i*i; sxy += i*recent[i]; }
    const denom = n * sxx - sx * sx;
    trendPerMonth = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  }
  return {
    baseline,
    current,
    drop_pct: Math.round(dropPct * 1000) / 1000,
    trend_per_month: Math.round(trendPerMonth),
    series_length: series.length,
  };
}

/**
 * Оценивает ожидаемый ежемесячный трафик при выходе на target_pos.
 *
 * @param {Object} args
 * @param {number} args.demand       месячный спрос фразы (baseline).
 * @param {number} args.targetPos    целевая позиция (например, 3 или 5).
 * @param {number} args.competition  0..1 (если есть; иначе 0.5 — нейтральная).
 * @param {number} args.effort       0..1 (low/mid/high).
 * @param {number} args.posNow       текущая позиция; null/0 → 100.
 * @returns {Object}
 */
function _projectScenario({ demand, targetPos, competition, effort, posNow, horizonMonths }) {
  const cfgAdv = getForecasterConfig().advanced;
  const cfgTraffic = getForecasterConfig().traffic;
  const { k, t0 } = calibrateLogistic({ competition, effort });
  // Ожидаемая позиция через horizon мес.
  const eventualPos = logisticPosition({ posNow, posFloor: targetPos, t: horizonMonths, k, t0 });
  // CTR при этой позиции (power-law аппроксимация дискретной таблицы).
  const ctr = ctrAtPosition(eventualPos);
  // Конкуренция домножает realisticShare (как в trafficModel).
  let competitionFactor = 1.0;
  if (competition != null) {
    const adj = cfgTraffic.competitionAdjustment;
    if (competition >= adj.thresholdHigh) competitionFactor = adj.factorHigh;
    else if (competition >= adj.thresholdMid) competitionFactor = adj.factorMid;
    else competitionFactor = adj.factorLow;
  }
  // ramp-up: за horizon мес не выходим сразу на пиковую позицию;
  // momentumRampUp оценивает долю эффекта, фактически усреднённую за период.
  // Используем (1 − e^(−λt))/λt — средняя доля от пика при экспо-разгоне.
  // Берём упрощение: половина horizon → ramp_avg.
  const lambda = calibrateMomentumLambda(effort);
  const rampAvg = lambda * horizonMonths > 0
    ? (1 - Math.exp(-lambda * (horizonMonths / 2)))
    : 1;
  const expectedTrafficMonthly = Math.round(demand * ctr * competitionFactor * rampAvg);
  return {
    target_pos:        targetPos,
    eventual_pos:      eventualPos,
    expected_ctr:      Math.round(ctr * 10000) / 10000,
    competition_factor: Math.round(competitionFactor * 100) / 100,
    ramp_avg:          Math.round(rampAvg * 100) / 100,
    expected_traffic_monthly: expectedTrafficMonthly,
    expected_traffic_annual:  expectedTrafficMonthly * 12,
    calibration: { k, t0, lambda },
  };
}

/**
 * Главный вход. Возвращает структуру opportunities (см. шапку файла).
 *
 * @param {Object} args
 * @param {Array<Object>} args.parsedRows  — строки из parser.js, после junk-фильтра.
 * @param {Array<string>} args.monthCols
 * @param {Map<string,Object>} [args.keyssoSignalsMap]  — Map<normPhrase, signals>
 * @param {number} [args.conversionRate]
 * @param {string} [args.intent]
 * @returns {Object}
 */
function analyzeOpportunities({
  parsedRows,
  monthCols,
  keyssoSignalsMap = null,
  conversionRate = null,
  intent = null,
} = {}) {
  const cfg = getForecasterConfig();
  const adv = cfg.advanced;
  if (!adv || !adv.enabled) {
    return { verdict: 'skipped', reason: 'feature_disabled', opportunities: [], clusters: [], summary: null };
  }
  const oppCfg = adv.opportunity;
  if (!Array.isArray(parsedRows) || parsedRows.length === 0) {
    return { verdict: 'skipped', reason: 'no_rows', opportunities: [], clusters: [], summary: null };
  }
  if (!Array.isArray(monthCols) || monthCols.length < 3) {
    return { verdict: 'skipped', reason: 'too_few_months', opportunities: [], clusters: [], summary: null };
  }

  // Resolve conversion rate (тот же приоритет, что в trafficModel).
  const cfgLeads = cfg.leads;
  let cr;
  if (Number(conversionRate) > 0 && Number(conversionRate) <= cfgLeads.maxCr) {
    cr = Number(conversionRate);
  } else if (intent && cfgLeads.intentPresets[intent] != null) {
    cr = cfgLeads.intentPresets[intent];
  } else {
    cr = cfgLeads.defaultConversionRate;
  }

  // Готовим демографию ядра — для нормирования composite_score.
  const demands = parsedRows.map((r) => Number(r.total || 0)).filter((x) => x > 0);
  const demandP50 = _median(demands);
  const demandLogNorm = demands.length > 0 ? Math.log(1 + Math.max(...demands)) : 1;

  const horizon = oppCfg.horizonMonths;
  const efforts = oppCfg.effortLevels;
  const w = oppCfg.weights;

  const items = [];

  for (const row of parsedRows) {
    const phrase = String(row.phrase || '').trim();
    if (!phrase) continue;
    const demand = Number(row.total || 0);
    if (demand <= 0) continue;
    const dyn = _phraseDynamics(row, monthCols, 3);
    const sig = _signalsFor(phrase, keyssoSignalsMap);
    const posNow = sig && sig.current_position > 0 ? sig.current_position : null;
    const competition = sig && sig.top10_competition != null ? sig.top10_competition : null;
    const momentumDelta = sig ? Number(sig.position_3m_delta || 0) : 0;

    // Условие «возможность»:
    //   а) drop_pct >= minGapPct — точечная просадка демпинга/трафика, либо
    //   б) phrase крупная (demand > P50), и сейчас вне топ-10 (или позиция неизвестна).
    const hasDrop = dyn.drop_pct >= oppCfg.minGapPct;
    const isBigOffTop = demand > demandP50 && (posNow == null || posNow > 10);
    if (!hasDrop && !isBigOffTop) continue;

    // Recovery (только для просевших, по demand-просадке).
    // effort here = средний (mid), отдельный per-effort расчёт ниже.
    const recoveryMid = recoveryPotential({
      baseline: dyn.baseline,
      current:  dyn.current,
      effort:   efforts.mid,
    });

    // Сценарии по позициям + усилиям.
    // Для каждой комбинации (effort × targetPos) считаем expected_traffic
    // и expected_leads. UI покажет таблицу.
    const scenarios = {};
    for (const [effortName, effortVal] of Object.entries(efforts)) {
      scenarios[effortName] = {};
      for (const targetPos of [3, 5, 10]) {
        const sc = _projectScenario({
          demand: dyn.baseline > 0 ? dyn.baseline : demand,
          targetPos,
          competition: competition != null ? competition : 0.5,
          effort: effortVal,
          posNow,
          horizonMonths: horizon,
        });
        sc.expected_leads_monthly = Math.round(sc.expected_traffic_monthly * cr);
        sc.expected_leads_annual  = sc.expected_leads_monthly * 12;
        scenarios[effortName][`top${targetPos}`] = sc;
      }
    }

    // Composite score (для приоритизации).
    const gapShare        = _clamp(dyn.drop_pct, 0, 1);
    const volumeScore     = demandLogNorm > 0 ? Math.log(1 + demand) / demandLogNorm : 0;
    const competitionEase = competition != null ? (1 - _clamp(competition, 0, 1)) : 0.5;
    // momentum_delta > 0 — позиция РОСЛА (better), < 0 — падала.
    // Считаем штраф 0..1 за негативный momentum:
    //   delta >=  1 → penalty=0  (растём)
    //   delta <= -3 → penalty=1  (сильно падаем)
    const momentumPenalty = _clamp(0.5 - momentumDelta * 0.25, 0, 1);

    const composite =
      w.gapShare        * gapShare        +
      w.currentVolume   * volumeScore     +
      w.competitionEase * competitionEase +
      w.momentumPenalty * momentumPenalty;

    items.push({
      phrase,
      demand_monthly:    demand,
      baseline_monthly:  dyn.baseline,
      current_monthly:   dyn.current,
      drop_pct:          dyn.drop_pct,
      trend_per_month:   dyn.trend_per_month,
      current_position:  posNow,
      competition,
      momentum_delta:    momentumDelta,
      recovery_potential_mid: recoveryMid,
      composite_score:   Math.round(composite * 1000) / 1000,
      score_breakdown: {
        gap_share:         Math.round(gapShare * 100) / 100,
        volume_score:      Math.round(volumeScore * 100) / 100,
        competition_ease:  Math.round(competitionEase * 100) / 100,
        momentum_penalty:  Math.round(momentumPenalty * 100) / 100,
      },
      scenarios,
      // Удобство для UI: best-case (top3, high effort) и conservative (top10, low).
      headline: {
        best_traffic_monthly: scenarios.high.top3.expected_traffic_monthly,
        best_leads_monthly:   scenarios.high.top3.expected_leads_monthly,
        safe_traffic_monthly: scenarios.low.top10.expected_traffic_monthly,
        safe_leads_monthly:   scenarios.low.top10.expected_leads_monthly,
      },
    });
  }

  // Сортируем по composite_score desc, берём top-N.
  items.sort((a, b) => b.composite_score - a.composite_score);
  const topGlobal = items.slice(0, oppCfg.topNGlobal);

  // Кластеризация (greedy, char-bigram cosine threshold ≈ 0.45).
  const clusters = _clusterPhrases(items, 0.45, oppCfg.topNClusters);

  // Сводный портфельный прогноз (log-normal композиция факторов).
  // Берём только top-N фраз для аккуратности.
  const portfolioBest = topGlobal.reduce(
    (acc, it) => acc + (it.scenarios.high.top3.expected_traffic_monthly * 12),
    0,
  );
  const portfolioSafe = topGlobal.reduce(
    (acc, it) => acc + (it.scenarios.low.top10.expected_traffic_monthly * 12),
    0,
  );
  // Лог-нормальный CI: σ зависит от длины ряда (короче → шире).
  const sigma = monthCols.length < 12
    ? adv.lognormal.sigmaShort
    : (monthCols.length >= 24 ? adv.lognormal.sigmaLong : adv.lognormal.sigmaDefault);
  const portfolioCI = portfolioBest > 0
    ? lognormalCompose({ factors: [portfolioBest], sigmaLog: sigma })
    : null;

  const summary = {
    total_phrases_evaluated: parsedRows.length,
    opportunities_total:     items.length,
    opportunities_returned:  topGlobal.length,
    high_priority_count:     items.filter((x) => x.composite_score >= 0.55).length,
    drop_count:              items.filter((x) => x.drop_pct >= oppCfg.minGapPct).length,
    off_top10_count:         items.filter((x) => x.current_position == null || x.current_position > 10).length,
    portfolio_best_annual_traffic: portfolioBest,
    portfolio_safe_annual_traffic: portfolioSafe,
    portfolio_best_annual_leads:   Math.round(portfolioBest * cr),
    portfolio_safe_annual_leads:   Math.round(portfolioSafe * cr),
    portfolio_ci: portfolioCI ? {
      p10: Math.round(portfolioCI.p10),
      p50: Math.round(portfolioCI.p50),
      p90: Math.round(portfolioCI.p90),
      sigma_log: portfolioCI.sigma,
    } : null,
  };

  return {
    verdict: 'ok',
    opportunities: topGlobal,
    clusters,
    summary,
    calibration: {
      conversion_rate: Math.round(cr * 100000) / 100000,
      conversion_rate_pct: Math.round(cr * 10000) / 100,
      horizon_months: horizon,
      effort_levels: efforts,
      weights: w,
      sigma_log: sigma,
      explanation:
        'Сценарии: для каждой просевшей/недо-ранжированной фразы считаем ожидаемый ' +
        'трафик при выходе на позицию 3/5/10 c усилием low/mid/high. ' +
        'Позиция оценивается логистической кривой (Verhulst) от текущей, ' +
        'с учётом конкуренции и effort. CTR — power-law аппроксимация ctrByPosition. ' +
        'Заявки = трафик × conversion_rate. Маржу/выручку модуль не считает.',
    },
  };
}

/**
 * Greedy-кластеризация по char-bigram cosine. Возвращает top-N кластеров
 * с агрегированными метриками. Каждой phrase назначаем cluster_id (для
 * UI-фильтрации) — мутируем входной items.
 */
function _clusterPhrases(items, simThreshold = 0.45, topN = 10) {
  const groups = []; // [{ centroid, bigrams, members:[idx], total_demand, ... }]
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const bi = _charBigrams(it.phrase);
    let assigned = -1;
    let bestSim = 0;
    for (let g = 0; g < groups.length; g++) {
      const sim = _bigramCosine(bi, groups[g].bigrams);
      if (sim >= simThreshold && sim > bestSim) {
        bestSim = sim;
        assigned = g;
      }
    }
    if (assigned >= 0) {
      groups[assigned].members.push(i);
      groups[assigned].total_demand += it.demand_monthly;
      groups[assigned].total_drop_volume += Math.max(0, it.baseline_monthly - it.current_monthly);
      groups[assigned].best_traffic_monthly += it.headline.best_traffic_monthly;
      groups[assigned].best_leads_monthly   += it.headline.best_leads_monthly;
      // Не «перетягиваем» центроид — keep first phrase as anchor.
    } else {
      groups.push({
        centroid: it.phrase,
        bigrams:  bi,
        members:  [i],
        total_demand: it.demand_monthly,
        total_drop_volume: Math.max(0, it.baseline_monthly - it.current_monthly),
        best_traffic_monthly: it.headline.best_traffic_monthly,
        best_leads_monthly:   it.headline.best_leads_monthly,
      });
    }
  }
  for (let g = 0; g < groups.length; g++) {
    for (const idx of groups[g].members) {
      items[idx].cluster_id = g;
      items[idx].cluster_centroid = groups[g].centroid;
    }
  }
  // Top-N кластеров по best_traffic_monthly (без bigrams в выдаче).
  return groups
    .map((g, idx) => ({
      cluster_id:    idx,
      centroid:      g.centroid,
      members_count: g.members.length,
      total_demand_monthly: g.total_demand,
      total_drop_volume:    g.total_drop_volume,
      best_traffic_monthly: g.best_traffic_monthly,
      best_leads_monthly:   g.best_leads_monthly,
      best_traffic_annual:  g.best_traffic_monthly * 12,
      best_leads_annual:    g.best_leads_monthly * 12,
      member_phrases: g.members.slice(0, 5).map((i) => items[i].phrase),
    }))
    .sort((a, b) => b.best_traffic_monthly - a.best_traffic_monthly)
    .slice(0, topN);
}

module.exports = {
  analyzeOpportunities,
  // internals (для тестов)
  _phraseDynamics,
  _projectScenario,
  _clusterPhrases,
  _bigramCosine,
  _charBigrams,
  _median,
};
