'use strict';

/**
 * forecaster/trafficModel.js — оценка трафика при росте в ТОП-3 / 5 / 10.
 *
 * РЕАЛИСТИЧНАЯ МОДЕЛЬ (по требованию владельца):
 *   Нельзя считать так, будто сайт встанет в ТОП-N сразу ПО ВСЕМ запросам
 *   из выгрузки. Реальный сайт по крупному ядру выходит в ТОП-3 примерно
 *   по 10-20 % фраз, в ТОП-5 — по ~28 %, в ТОП-10 — по ~55 % (cfg.realisticShareTopN).
 *
 *   Поэтому для каждого сценария считаем:
 *     1) optimistic = demand × avgCtrTopN    (потолок «идеальной выдачи»)
 *     2) realistic  = demand × avgCtrTopN × realisticShareTopN
 *     3) clamp(realistic) — если задан current_traffic, проекция не может
 *        превышать current × maxUpliftTopN (защита от фантастики).
 *
 * Возвращаем оба числа: UI показывает realistic как основной, optimistic —
 * как «теоретический потолок при идеальной выдаче».
 *
 * Если current_traffic указан — implied_ctr_now = current/current_demand,
 * uplift_x = realistic_ctr / implied_ctr_now, и применяется maxUplift cap.
 */

const { getForecasterConfig } = require('./config');

function _clampUplift(annualRealistic, currentAnnual, maxX) {
  if (currentAnnual <= 0 || !(maxX > 0)) return { annual: annualRealistic, capped: false };
  const cap = currentAnnual * maxX;
  if (annualRealistic > cap) return { annual: Math.round(cap), capped: true };
  return { annual: annualRealistic, capped: false };
}

/**
 * @param {Object} args
 * @param {Array<{period:string,demand:number}>} args.historicalMonthly
 * @param {Array<{period:string,value:number}>} args.forecastPoints
 * @param {number} [args.currentTrafficPerMonth]
 * @param {number} [args.currentDemandWindow]
 * @param {Object} [args.keyssoAggregate] — сводка из keyssoClient.aggregateSignals
 *   (см. keyssoClient.js). Если передана и непуста, используется для:
 *     • замены defaultCurrentCtr на CTR по средней реальной позиции,
 *     • домножения realisticShareTopN на competition_factor (≤ 1.0),
 *     • сжатия верхней границы CI прогноза при negative momentum
 *       (только для UI-полей optimistic/уплифт-капов).
 */
function estimateTraffic({
  historicalMonthly,
  forecastPoints,
  currentTrafficPerMonth = 0,
  currentDemandWindow = 3,
  keyssoAggregate = null,
}) {
  const cfg = getForecasterConfig().traffic;

  // Оценка текущего спроса (среднее по последним N мес)
  const tail = (historicalMonthly || []).slice(-Math.max(1, currentDemandWindow));
  const currentDemand = tail.length > 0
    ? tail.reduce((a, p) => a + p.demand, 0) / tail.length
    : 0;

  // Неявный текущий CTR.
  // Приоритет: user_input > keys.so avg_position → ctr_by_position > default.
  const explicitCtr = currentTrafficPerMonth > 0 && currentDemand > 0
    ? currentTrafficPerMonth / currentDemand
    : null;
  let implied_ctr_now;
  let implied_ctr_now_source;
  if (explicitCtr != null) {
    implied_ctr_now = explicitCtr;
    implied_ctr_now_source = 'user_input';
  } else if (keyssoAggregate && keyssoAggregate.avg_current_position) {
    const pos = Math.max(1, Math.round(keyssoAggregate.avg_current_position));
    const ctr = cfg.ctrByPosition[pos];
    if (ctr != null && ctr > 0) {
      implied_ctr_now = ctr;
      implied_ctr_now_source = `keysso_avg_position_${pos}`;
    } else {
      // Позиция вне топ-10 → ctr ≈ defaultCurrentCtr (плоский «хвост»).
      implied_ctr_now = cfg.defaultCurrentCtr;
      implied_ctr_now_source = 'keysso_position_off_top10';
    }
  } else {
    implied_ctr_now = cfg.defaultCurrentCtr;
    implied_ctr_now_source = 'default_position_20+';
  }

  // Множитель конкуренции по medain_competition (только ≤1.0).
  let competitionFactor = 1.0;
  let competitionLabel  = 'unknown';
  if (keyssoAggregate && keyssoAggregate.median_competition != null) {
    const adj = cfg.competitionAdjustment;
    const mc  = Number(keyssoAggregate.median_competition);
    if (mc >= adj.thresholdHigh) {
      competitionFactor = adj.factorHigh;
      competitionLabel  = 'high';
    } else if (mc >= adj.thresholdMid) {
      competitionFactor = adj.factorMid;
      competitionLabel  = 'mid';
    } else {
      competitionFactor = adj.factorLow;
      competitionLabel  = 'low';
    }
  }

  const scenarios = {
    top3:  { ctr: cfg.avgCtrTop3,  share: cfg.realisticShareTop3,  maxX: cfg.maxUpliftTop3  },
    top5:  { ctr: cfg.avgCtrTop5,  share: cfg.realisticShareTop5,  maxX: cfg.maxUpliftTop5  },
    top10: { ctr: cfg.avgCtrTop10, share: cfg.realisticShareTop10, maxX: cfg.maxUpliftTop10 },
  };

  const currentAnnual = currentTrafficPerMonth > 0 ? currentTrafficPerMonth * 12 : 0;

  const result = {
    current_traffic_input:  currentTrafficPerMonth || 0,
    current_demand_avg:     Math.round(currentDemand),
    implied_ctr_now:        Math.round(implied_ctr_now * 10000) / 10000,
    implied_ctr_now_source: implied_ctr_now_source,
    keysso_calibration: keyssoAggregate ? {
      avg_current_position: keyssoAggregate.avg_current_position,
      median_competition:   keyssoAggregate.median_competition,
      competition_factor:   competitionFactor,
      competition_label:    competitionLabel,
      momentum:             keyssoAggregate.momentum,
      explanation:
        'CTR взят по avg_current_position из keys.so (вместо плоского default). ' +
        'realisticShareTopN домножен на competition_factor по medain_competition. ' +
        'competition_factor всегда ≤ 1.0 — никаких "boost" из keys.so быть не должно.',
    } : null,
    // Подсказка для UI/DeepSeek: реализм-факторы (что мы взяли).
    realism: {
      share_top3:  cfg.realisticShareTop3  * competitionFactor,
      share_top5:  cfg.realisticShareTop5  * competitionFactor,
      share_top10: cfg.realisticShareTop10 * competitionFactor,
      share_base_top3:  cfg.realisticShareTop3,
      share_base_top5:  cfg.realisticShareTop5,
      share_base_top10: cfg.realisticShareTop10,
      competition_factor: competitionFactor,
      max_uplift_top3:  cfg.maxUpliftTop3,
      max_uplift_top5:  cfg.maxUpliftTop5,
      max_uplift_top10: cfg.maxUpliftTop10,
      explanation:
        'realistic = demand × avgCtrTopN × realisticShareTopN × competition_factor. ' +
        'Доля учитывает, что в ТОП-N реально выходит лишь часть фраз ядра. ' +
        'competition_factor (≤ 1.0) учитывает конкуренцию по данным keys.so. ' +
        'Если указан current_traffic, проекция дополнительно ограничена current × maxUpliftTopN.',
    },
  };

  for (const [name, { ctr: targetCtr, share: baseShare, maxX }] of Object.entries(scenarios)) {
    // Применяем competition_factor: только ≤1.0, никогда не "бустим".
    const share = baseShare * competitionFactor;
    // realistic CTR = targetCtr × realisticShare (доля фраз, реально доходящих)
    const realisticCtr = targetCtr * share;

    const monthlyOptimistic = forecastPoints.map((p) => ({
      period: p.period,
      traffic: Math.round(p.value * targetCtr),
    }));
    const monthlyRealistic = forecastPoints.map((p) => ({
      period: p.period,
      traffic: Math.round(p.value * realisticCtr),
    }));
    const annualOptimistic = monthlyOptimistic.reduce((a, m) => a + m.traffic, 0);
    let annualRealistic    = monthlyRealistic.reduce((a, m) => a + m.traffic, 0);

    // Cap по «максимальному реалистичному росту» от текущего трафика.
    const capped = _clampUplift(annualRealistic, currentAnnual, maxX);
    annualRealistic = capped.annual;
    // Если cap сработал — пропорционально сжать помесячный ряд.
    if (capped.capped && annualRealistic > 0) {
      const k = capped.annual / monthlyRealistic.reduce((a, m) => a + m.traffic, 0);
      for (const m of monthlyRealistic) m.traffic = Math.round(m.traffic * k);
    }

    const uplift_x_realistic = explicitCtr != null && explicitCtr > 0 && currentAnnual > 0
      ? Math.round((annualRealistic / currentAnnual) * 100) / 100
      : (explicitCtr != null && explicitCtr > 0 ? Math.round((realisticCtr / explicitCtr) * 100) / 100 : null);
    const uplift_x_optimistic = explicitCtr != null && explicitCtr > 0
      ? Math.round((targetCtr / explicitCtr) * 100) / 100
      : null;
    const delta = currentAnnual > 0 ? annualRealistic - currentAnnual : null;

    result[name] = {
      // основной (реалистичный) сценарий
      target_ctr:        targetCtr,           // сохранено для обратной совместимости
      realistic_ctr:     Math.round(realisticCtr * 10000) / 10000,
      realistic_share:   share,
      monthly:           monthlyRealistic,    // helbreaker: monthly — это РЕАЛИСТИЧНЫЙ ряд
      annual:            annualRealistic,
      annual_vs_current: delta,
      uplift_x:          uplift_x_realistic,
      uplift_capped:     capped.capped,
      max_uplift_x:      maxX,
      // «потолок» при идеальной выдаче (legacy/optimistic)
      optimistic: {
        monthly:    monthlyOptimistic,
        annual:     annualOptimistic,
        uplift_x:   uplift_x_optimistic,
      },
    };
  }

  return result;
}

module.exports = { estimateTraffic };
