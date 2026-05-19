'use strict';

/**
 * forecaster/trafficModel.js — оценка трафика при росте в ТОП-3 / 5 / 10.
 *
 * Идея:
 *   • есть прогноз будущего спроса (показов) demand[h]
 *   • CTR по позициям задан в config (агрегированные данные RU)
 *   • если пользователь указал «текущий трафик в месяц» — мы калибруем
 *     модель: считаем неявный CTR_now = current_traffic / current_demand,
 *     и для каждой target-группы (top3/5/10) масштабируем будущий трафик
 *     как demand[h] * target_ctr, ВОЗВРАЩАЯ ТАКЖЕ uplift_x = target/current.
 *   • если current_traffic не указан — используем дефолтный CTR_now из
 *     config (≈ позиция 20-30).
 */

const { getForecasterConfig } = require('./config');

/**
 * @param {Object} args
 * @param {Array<{period:string,demand:number}>} args.historicalMonthly  -- последние месяцы (для оценки current_demand)
 * @param {Array<{period:string,value:number}>} args.forecastPoints     -- прогноз 12 мес
 * @param {number} [args.currentTrafficPerMonth]                         -- введённый пользователем трафик/мес
 * @param {number} [args.currentDemandWindow]                           -- сколько последних месяцев брать в качестве "текущего спроса"
 */
function estimateTraffic({
  historicalMonthly,
  forecastPoints,
  currentTrafficPerMonth = 0,
  currentDemandWindow = 3,
}) {
  const cfg = getForecasterConfig().traffic;

  // Оценка текущего спроса (среднее по последним N мес)
  const tail = (historicalMonthly || []).slice(-Math.max(1, currentDemandWindow));
  const currentDemand = tail.length > 0
    ? tail.reduce((a, p) => a + p.demand, 0) / tail.length
    : 0;

  // Неявный текущий CTR
  const explicitCtr = currentTrafficPerMonth > 0 && currentDemand > 0
    ? currentTrafficPerMonth / currentDemand
    : null;
  const implied_ctr_now = explicitCtr != null ? explicitCtr : cfg.defaultCurrentCtr;

  // Сценарии: top3 / top5 / top10
  const scenarios = {
    top3:  cfg.avgCtrTop3,
    top5:  cfg.avgCtrTop5,
    top10: cfg.avgCtrTop10,
  };

  const result = {
    current_traffic_input: currentTrafficPerMonth || 0,
    current_demand_avg:    Math.round(currentDemand),
    implied_ctr_now:       Math.round(implied_ctr_now * 10000) / 10000,
    implied_ctr_now_source: explicitCtr != null ? 'user_input' : 'default_position_20+',
  };

  for (const [name, targetCtr] of Object.entries(scenarios)) {
    const monthly = forecastPoints.map((p) => ({
      period: p.period,
      traffic: Math.round(p.value * targetCtr),
    }));
    const annual = monthly.reduce((a, m) => a + m.traffic, 0);
    const currentAnnual = currentTrafficPerMonth > 0 ? currentTrafficPerMonth * 12 : 0;
    const uplift_x = explicitCtr != null && explicitCtr > 0 ? (targetCtr / explicitCtr) : null;
    const delta = currentAnnual > 0 ? annual - currentAnnual : null;

    result[name] = {
      target_ctr: targetCtr,
      monthly,
      annual,
      annual_vs_current: delta,
      uplift_x: uplift_x != null ? Math.round(uplift_x * 100) / 100 : null,
    };
  }

  return result;
}

module.exports = { estimateTraffic };
