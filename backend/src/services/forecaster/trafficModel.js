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
 * @param {number} [args.conversionRate] — пользовательская конверсия сайта
 *   (0..0.5). Если задана и валидна, считаем `leads_*` поля = traffic × CR.
 *   Если не задана — берётся cfg.leads.defaultConversionRate. Маржу/выручку
 *   НЕ считаем (по требованию владельца — см. memory).
 * @param {string} [args.intent] — 'commercial'|'ecommerce'|'lead_gen'|'info'|'b2b'
 *   используется ТОЛЬКО когда conversionRate не задан, чтобы вместо
 *   defaultConversionRate взять более релевантный intentPreset.
 */
function estimateTraffic({
  historicalMonthly,
  forecastPoints,
  currentTrafficPerMonth = 0,
  currentDemandWindow = 3,
  keyssoAggregate = null,
  conversionRate = null,
  intent = null,
}) {
  const cfg = getForecasterConfig().traffic;
  const cfgLeads = getForecasterConfig().leads;

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

  // ── Conversion rate resolution ──────────────────────────────────
  // Приоритет: явное user input → intent preset → default.
  // НИКАКОЙ маржи/выручки/ROI не считаем — только объём заявок.
  let cr = null;
  let crSource = 'default';
  const userCr = Number(conversionRate);
  if (Number.isFinite(userCr) && userCr >= cfgLeads.minCr && userCr <= cfgLeads.maxCr) {
    cr = userCr;
    crSource = 'user_input';
  } else if (intent && cfgLeads.intentPresets[intent] != null) {
    cr = cfgLeads.intentPresets[intent];
    crSource = `intent_preset_${intent}`;
  } else {
    cr = cfgLeads.defaultConversionRate;
    crSource = 'default';
  }
  // Текущее число заявок/мес (по текущему трафику × CR), для baseline-leads.
  const currentLeadsPerMonth = currentTrafficPerMonth > 0
    ? Math.round(currentTrafficPerMonth * cr)
    : 0;
  const currentLeadsAnnual = currentLeadsPerMonth * 12;

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
    // ── Заявки (по конверсии сайта) ─────────────────────────────────
    // По требованию владельца: считаем ТОЛЬКО объём заявок (= traffic × CR),
    // никаких выручки/маржи/ROI. CR задаётся пользователем; intent — подсказка.
    leads_model: {
      conversion_rate:   Math.round(cr * 100000) / 100000, // 5 знаков (для CR=0.00012 и т.п.)
      conversion_rate_pct: Math.round(cr * 10000) / 100,    // в %, 2 знака
      conversion_rate_source: crSource,
      intent: intent || null,
      current_leads_per_month: currentLeadsPerMonth,
      current_leads_annual:    currentLeadsAnnual,
      explanation:
        'leads_per_month = traffic_per_month × conversion_rate. ' +
        'Маржу/выручку модуль не считает по требованию владельца — только объём заявок.',
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
      // ── Заявки (traffic × CR) — реалистичный сценарий ──────────
      // Считаем по уже clamped monthlyRealistic, чтобы лиды никогда не
      // превышали оценку трафика после cap-а. annual_vs_current_leads —
      // delta заявок год к году (если есть current_traffic).
      leads: {
        monthly: monthlyRealistic.map((m) => ({
          period: m.period,
          leads:  Math.round(m.traffic * cr),
        })),
        annual:        Math.round(annualRealistic * cr),
        annual_optimistic: Math.round(annualOptimistic * cr),
        annual_vs_current: currentLeadsAnnual > 0
          ? Math.round(annualRealistic * cr) - currentLeadsAnnual
          : null,
      },
    };
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────
// Граф охвата семантики — time-series распределения ключей по топам.
//
// Заменяет статичные карточки ТОП-3/5/10: по каждому месяцу прогноза
// считаем, сколько ключей (и какой объём спроса) находится в ТОП-3 /
// ТОП-10 / ТОП-20 / вне топа, плюс реалистичный и оптимистичный трафик.
//
// Модель детерминированная:
//   • стартовое распределение — из агрегатов keys.so (phrases_in_top10_pct
//     и phrases_in_top30_pct); без keys.so старт = 0 (новый сайт);
//   • целевые доли на горизонте — realisticShareTopN × competition_factor
//     (те же данные, что в realism-блоке estimateTraffic); для ТОП-20
//     отдельного конфига нет — share_top10 × cfg.semantic.top20Factor;
//   • прогресс от старта к цели — S-кривая захвата из unifiedForecast
//     (capture(t) нормированный), fallback — логистика по t.

const _MONTH_NAMES_RU = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

function _periodLabelRu(period) {
  const m = String(period || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return String(period || '');
  const mi = Number(m[2]) - 1;
  if (mi < 0 || mi > 11) return String(period);
  return `${_MONTH_NAMES_RU[mi]} ${m[1]}`;
}

function _clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * @param {Array<{phrase:string,total:number}>} keywords — ядро после
 *   junk-фильтра (total = суммарный спрос фразы за историю).
 * @param {Object} monthlyForecast — источники помесячного прогноза:
 * @param {Object} [monthlyForecast.unifiedForecast] — buildUnifiedForecast()
 * @param {Object} [monthlyForecast.trafficEstimate] — estimateTraffic()
 * @param {Object} [monthlyForecast.keyssoAggregate] — aggregateSignals()
 * @returns {Array|null} time-series для графика SemanticCoverageChart
 */
function buildSemanticDistribution(keywords, monthlyForecast = {}) {
  const cfgAll = getForecasterConfig();
  const semCfg = cfgAll.semantic || {};
  const { unifiedForecast, trafficEstimate, keyssoAggregate } = monthlyForecast;

  const rows = Array.isArray(keywords) ? keywords : [];
  const totalCount = rows.length;
  if (totalCount === 0) return null;
  let totalVolume = 0;
  for (const r of rows) totalVolume += Math.max(0, Number(r.total) || 0);

  // Месяцы прогноза: приоритет — unifiedForecast (там есть capture-кривая).
  const uf = (unifiedForecast && unifiedForecast.verdict === 'ok'
              && Array.isArray(unifiedForecast.forecast) && unifiedForecast.forecast.length > 0)
    ? unifiedForecast : null;
  const teTop10 = trafficEstimate?.top10 || null;
  const months = uf
    ? uf.forecast
    : (teTop10 && Array.isArray(teTop10.monthly) ? teTop10.monthly : []);
  if (months.length === 0) return null;

  // Стартовое распределение (доли ключей в топах сейчас).
  const top10Start = keyssoAggregate?.phrases_in_top10_pct != null
    ? _clamp01(Number(keyssoAggregate.phrases_in_top10_pct) / 100) : 0;
  const top30Start = keyssoAggregate?.phrases_in_top30_pct != null
    ? _clamp01(Number(keyssoAggregate.phrases_in_top30_pct) / 100) : top10Start;
  const top3Start  = top10Start * 0.3; // консервативная оценка: ~треть топ-10 — в топ-3
  const top20Start = Math.max(top10Start, top10Start + (top30Start - top10Start) * 0.5);

  // Целевые доли на горизонте — реализм-факторы трафик-модели.
  const realism = trafficEstimate?.realism || null;
  const trafficCfg = cfgAll.traffic;
  const share3  = realism ? Number(realism.share_top3)  : trafficCfg.realisticShareTop3;
  const share10 = realism ? Number(realism.share_top10) : trafficCfg.realisticShareTop10;
  const top20Factor = Number(semCfg.top20Factor) || 1.8;
  const top20Cap    = Number(semCfg.top20Cap) || 0.95;
  const top3Target  = Math.max(top3Start,  _clamp01(share3));
  const top10Target = Math.max(top10Start, _clamp01(share10));
  const top20Target = Math.max(top20Start, Math.min(top20Cap, _clamp01(share10) * top20Factor));

  // Прогресс к цели: нормированная S-кривая захвата из unified, иначе логистика.
  const capStart = uf ? Number(uf.params?.sov_start) : null;
  const capMax   = uf ? Number(uf.params?.sov_max)   : null;
  const useCapture = uf && Number.isFinite(capStart) && Number.isFinite(capMax) && capMax > capStart;
  const fallbackK = Number(semCfg.fallbackK) || 0.35;
  const H = months.length;

  const out = [];
  for (let i = 0; i < H; i++) {
    const p = months[i];
    const t = i + 1;
    let s;
    if (useCapture && p.capture != null) {
      s = _clamp01((Number(p.capture) - capStart) / (capMax - capStart));
    } else {
      s = 1 / (1 + Math.exp(-fallbackK * (t - H / 2)));
    }
    // Кумулятивные доли (монотонность топов: top3 ≤ top10 ≤ top20 ≤ 1).
    const c3  = _clamp01(top3Start  + (top3Target  - top3Start)  * s);
    const c10 = Math.max(c3,  _clamp01(top10Start + (top10Target - top10Start) * s));
    const c20 = Math.max(c10, _clamp01(top20Start + (top20Target - top20Start) * s));

    const cnt3  = Math.round(c3 * totalCount);
    const cnt10 = Math.round(c10 * totalCount);
    const cnt20 = Math.round(c20 * totalCount);
    const vol3  = Math.round(c3 * totalVolume);
    const vol10 = Math.round(c10 * totalVolume);
    const vol20 = Math.round(c20 * totalVolume);

    // Трафик: реалистичный = основной прогноз, оптимистичный = верхняя
    // граница коридора unified (или optimistic-ряд трафик-модели).
    let trafficRealistic = null;
    let trafficOptimistic = null;
    if (uf) {
      trafficRealistic  = Math.round(Number(p.value) || 0);
      trafficOptimistic = Math.round(Number(p.upper) || 0);
    } else if (teTop10) {
      trafficRealistic  = Math.round(Number(p.traffic) || 0);
      trafficOptimistic = Math.round(Number(teTop10.optimistic?.monthly?.[i]?.traffic) || 0) || null;
    }

    out.push({
      month:  `M${t}`,
      label:  _periodLabelRu(p.period),
      period: p.period || null,
      distribution: {
        top3:  { count: cnt3,               volume: vol3 },
        top10: { count: cnt10 - cnt3,        volume: vol10 - vol3 },
        top20: { count: cnt20 - cnt10,       volume: vol20 - vol10 },
        out:   { count: totalCount - cnt20,  volume: totalVolume - vol20 },
      },
      coverage: {
        top3:  Math.round(c3 * 1000) / 1000,
        top10: Math.round(c10 * 1000) / 1000,
        top20: Math.round(c20 * 1000) / 1000,
      },
      traffic_realistic:  trafficRealistic,
      traffic_optimistic: trafficOptimistic,
    });
  }
  return out;
}

module.exports = { estimateTraffic, buildSemanticDistribution };
