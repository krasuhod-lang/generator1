'use strict';

/**
 * forecaster/unifiedForecast.js — единая («перепрошитая») модель прогноза
 * трафика. Детерминированная, без внешних зависимостей.
 *
 * Итоговый прогноз трафика на месяц t (t = 1..H) считается по формуле:
 *
 *   V̂(t) = [(L0 + t·T)·S(t mod 12)]·C_yield·(1 + r·t)          ← Ёмкость рынка (TAC)
 *          · [SOV_start + (SOV_max − SOV_start)/(1 + e^(−k(t−t0)))]  ← Функция захвата (S-кривая)
 *
 * Блоки:
 *   1. Динамика базового спроса: L0 (уровень на старте), T (тренд рынка),
 *      S (мультипликативная сезонность месяца), C_yield (Zero-click поправка).
 *   2. Расширение семантики: множитель (1 + r·t) — каждый месяц открываем новые
 *      страницы/кластеры.
 *   3. Ограничение рынка: SOV_max = max(target_ctr · C_serp, SOV_start·(1+G)) —
 *      потолок доли, алгоритмически защищённый от падения ниже стартовой доли;
 *      SOV_start = текущий трафик / текущий спрос.
 *   4. Плавность роста: логистика с крутизной k и точкой перегиба t0.
 *
 * Коридор погрешности (дисперсия растёт ∝ √t):
 *   V_upper(t) = V̂(t)·(1 + δ·√t)
 *   V_lower(t) = V̂(t)·max(0, 1 − δ·√t)
 *
 * L0/T/S восстанавливаются из истории спроса. Прочие параметры —
 * пользовательские (options.*) с дефолтами из config.unified.
 */

const { _periodToIndex, _indexToPeriod } = require('./series');

function _clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function _round(n, d = 4) {
  const f = Math.pow(10, d);
  return Math.round((Number(n) || 0) * f) / f;
}

// OLS-тренд y = a + b·i по индексам 0..n-1.
function _olsTrend(values) {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: values[0] || 0 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i; sy += values[i]; sxx += i * i; sxy += i * values[i];
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { slope: 0, intercept: sy / n };
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
}

/**
 * Мультипликативная сезонность по календарному месяцу (1..12).
 * ratio_i = demand_i / trend_i, усредняем по месяцу, нормируем к среднему 1.0,
 * клэмпим в [seasonalMin, seasonalMax]. Индекс массива 0 = январь.
 */
function _seasonalFactors(monthly, trend, cfg) {
  const acc = new Array(12).fill(0);
  const cnt = new Array(12).fill(0);
  for (let i = 0; i < monthly.length; i++) {
    const idx = _periodToIndex(monthly[i].period);
    if (idx == null) continue;
    const cm = idx % 12; // 0=январь
    const t = trend.intercept + trend.slope * i;
    if (t <= 0) continue;
    const ratio = monthly[i].demand / t;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    acc[cm] += ratio;
    cnt[cm] += 1;
  }
  const raw = acc.map((s, i) => (cnt[i] > 0 ? s / cnt[i] : null));
  // Заполняем пропущенные месяцы средним по известным (или 1.0).
  const known = raw.filter((v) => v != null);
  const meanKnown = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
  const filled = raw.map((v) => (v == null ? meanKnown : v));
  // Нормируем к среднему = 1.0, чтобы сезонность не сдвигала уровень.
  const mean = filled.reduce((a, b) => a + b, 0) / 12 || 1;
  return filled.map((v) => _clamp(v / mean, cfg.seasonalMin, cfg.seasonalMax));
}

// Штраф за агрессивность SERP-фичей: C_serp = 1 − Σ w_i·count_i (нижняя граница 0.1).
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

function _resolveParam(userVal, def, min, max) {
  const n = Number(userVal);
  if (!Number.isFinite(n)) return def;
  return _clamp(n, min, max);
}

function _periodToDateIndex(period) {
  // "YYYY-MM" → absolute month index (используется для start_month)
  const m = String(period || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 12 + (Number(m[2]) - 1);
}

/**
 * @param {Object} args
 * @param {Array<{period:string,demand:number}>} args.monthly — история спроса (после junk-фильтра)
 * @param {Array<{period:string,value:number}>} [args.forecastPoints] — точки прогноза спроса (для сверки периодов)
 * @param {Object} args.options — пользовательские параметры (c_yield/target_ctr/…)
 * @param {number} [args.currentTrafficPerMonth]
 * @param {Array<{type,count}>} [args.serpElements]
 * @param {number} [args.commPercent] — доля коммерческих запросов 0..1
 * @param {number} [args.crFinal] — итоговая конверсия (для лидов)
 * @param {Object} args.cfg — полный forecaster config
 */
function buildUnifiedForecast({
  monthly,
  forecastPoints = [],
  options = {},
  currentTrafficPerMonth = 0,
  serpElements = [],
  commPercent = 1,
  crFinal = 0,
  cfg = {},
}) {
  const uCfg = (cfg.unified) || {};
  const sovCfg = cfg.sov || {};
  const weights = sovCfg.serpWeights || { direct: 0.10, maps: 0.15, market: 0.12, goods_gallery: 0.12, other: 0.05 };

  const series = (monthly || []).filter((p) => p && p.period);
  const values = series.map((p) => Math.max(0, Number(p.demand) || 0));
  const n = values.length;

  if (n < 3) {
    return {
      verdict: 'insufficient_data',
      reason: `Нужно минимум 3 месяца истории, получено ${n}`,
      params: null,
      retro: series.map((p) => ({ period: p.period, demand: Math.max(0, Number(p.demand) || 0), traffic: 0 })),
      forecast: [],
    };
  }

  // ── Блок 1: динамика базового спроса ────────────────────────────
  const trend = _olsTrend(values);
  const seasonal = _seasonalFactors(series, trend, uCfg);
  // L0 — десезонализированный уровень спроса на последнем месяце истории (старт).
  const L0 = Math.max(0, trend.intercept + trend.slope * (n - 1));
  const T = trend.slope; // тренд рынка (клики/мес)
  const cYield = _resolveParam(options.c_yield, uCfg.cYieldDefault, uCfg.cYieldMin, uCfg.cYieldMax);

  // ── Блок 2: расширение семантики ────────────────────────────────
  const r = _resolveParam(options.semantic_expansion_rate, uCfg.expansionRateDefault, uCfg.expansionRateMin, uCfg.expansionRateMax);

  // ── Блок 3: ограничение рынка (SOV) ─────────────────────────────
  const targetCtr = _resolveParam(options.target_ctr, uCfg.targetCtrDefault, uCfg.targetCtrMin, uCfg.targetCtrMax);
  const cSerp = _round(_serpCoefficient(serpElements, weights), 4);
  const comm = _clamp(commPercent == null ? 1 : commPercent, 0, 1);
  // SOV_start — текущий захват (трафик сейчас / спрос сейчас). Новый сайт = 0.
  const dNow = values[n - 1] > 0 ? values[n - 1] : (values.reduce((a, b) => a + b, 0) / n);
  const curTraffic = Math.max(0, Number(currentTrafficPerMonth) || 0);
  const sovStart = dNow > 0 ? _clamp(curTraffic / dNow, 0, 1) : 0;
  // G — минимальный гарантированный рост доли рынка. Алгоритмическая защита
  // от падения: SOV_max = max(CTR_target·C_serp, SOV_start·(1+G)), поэтому
  // прогнозируемая доля НИКОГДА не опускается ниже стартовой.
  const minGrowth = _resolveParam(options.min_growth, uCfg.minGrowthDefault ?? 0.2, uCfg.minGrowthMin ?? 0, uCfg.minGrowthMax ?? 1);
  const sovMax = _clamp(Math.max(targetCtr * cSerp, sovStart * (1 + minGrowth)), 0, 1);
  // CTR_new — кликабельность «свежей» семантики (страницы из «песочницы»).
  // Взвешенное размытие: CTR_avg(t) = (CTR_core(t) + CTR_new·r·t)/(1 + r·t).
  const ctrNew = _resolveParam(options.ctr_new, uCfg.ctrNewDefault ?? 0.005, uCfg.ctrNewMin ?? 0, uCfg.ctrNewMax ?? 0.05);
  const sovNew = _clamp(ctrNew * cSerp, 0, 1);

  // ── Блок 4: логистика роста ─────────────────────────────────────
  const k = _resolveParam(options.growth_k, uCfg.kDefault, uCfg.kMin, uCfg.kMax);
  const t0 = _resolveParam(options.breakthrough_month, uCfg.t0Default, uCfg.t0Min, uCfg.t0Max);

  // ── Коридор погрешности ─────────────────────────────────────────
  const delta = _resolveParam(options.uncertainty_delta, uCfg.deltaDefault, uCfg.deltaMin, uCfg.deltaMax);

  // ── Конверсионная воронка: показы → визиты → лиды ────────────────
  // impressionCtr — средний CTR «показ → визит». Объём показов считаем
  // как визиты / impressionCtr (с потолком по объёму спроса).
  const impressionCtr = _resolveParam(options.impression_ctr, uCfg.impressionCtr ?? 0.22, uCfg.impressionCtrMin ?? 0.05, uCfg.impressionCtrMax ?? 0.60);

  // ── Горизонт и периоды ──────────────────────────────────────────
  const hMaxLimit = Math.max(1, Number(sovCfg.hMaxLimit) || 24);
  const horizon = _clamp(Math.floor(Number(options.h_max) || sovCfg.hMaxDefault || 12), 1, hMaxLimit);
  const lastIdx = _periodToIndex(series[n - 1].period);

  // «Месяц старта работ»: пользовательский якорь, от которого t=1..H. Если
  // не задан, берём следующий календарный месяц после последней истории
  // (совместимо с прежним поведением). Если задан ранее последней истории,
  // клэмпим к последнему историческому месяцу.
  const startMonthRaw = (options && (options.start_month || options.startMonth)) || null;
  const startMonthAbs = _periodToDateIndex(String(startMonthRaw || ''));
  // Переведём абсолютный индекс (YYYY·12+M) в «локальный» относительно 2000.
  // _periodToIndex/_indexToPeriod из series.js используют базу 2000-01, поэтому
  // startAnchor рассчитываем как относительный от той же базы.
  let startAnchor = null;
  if (startMonthAbs != null) {
    startAnchor = startMonthAbs - 2000 * 12; // «локальный» индекс от 2000-01
  }
  // Дефолтная точка отсчёта t=0: последняя историческая точка.
  const t0AnchorIdx = startAnchor != null ? startAnchor - 1 : lastIdx;
  const startPeriod = startAnchor != null ? _indexToPeriod(startAnchor) : null;

  // Ретроданные: исторический трафик при ТЕКУЩЕМ захвате (demand·SOV_start).
  // На последнем месяце ≈ текущий трафик → бесшовный стык с прогнозом.
  const retro = series.map((p) => ({
    period: p.period,
    demand: Math.max(0, Number(p.demand) || 0),
    traffic: Math.round(Math.max(0, Number(p.demand) || 0) * sovStart),
  }));

  // Индексация исторического спроса по абсолютному month-index (для YoY —
  // диагностический множитель demand_yoy «этот месяц год назад»).
  const retroDemandByIdx = new Map();
  for (let i = 0; i < series.length; i++) {
    const idx = _periodToIndex(series[i].period);
    if (idx != null) {
      retroDemandByIdx.set(idx, retro[i].demand);
    }
  }

  // Стартовое (десезонализированное) ядро трафика на t=0 — это РОВНО текущий
  // трафик пользователя (curTraffic). Мы калибруем модель так, чтобы прогноз
  // начинался именно с этого значения (см. `start` в результате).
  //   base0  — «естественный» уровень модели на старте (без калибровки);
  //   calib  — множитель, притягивающий модель к введённому curTraffic.
  // Для нового сайта (curTraffic=0) калибровка не нужна: работает абсолютная
  // формула TAC × capture, трафик растёт с нуля.
  const startCore = curTraffic; // десезонализированный уровень трафика на старте
  const base0 = Math.max(0, L0) * cYield * sovStart;
  const calib = (curTraffic > 0 && base0 > 0) ? curTraffic / base0 : 1;

  // Показы (impressions) на старте: визиты / impressionCtr, но не больше
  // текущего спроса (нельзя показаться чаще, чем нас ищут).
  const _impressions = (visits, demandCap) => {
    let imp = impressionCtr > 0 ? Math.round(visits / impressionCtr) : Math.round(visits);
    if (imp < Math.round(visits)) imp = Math.round(visits);        // показов ≥ визитов
    if (demandCap > 0 && imp > demandCap) imp = Math.round(demandCap); // ≤ объёма спроса
    return Math.max(0, imp);
  };

  // Прогноз: перебираем t = 1..horizon от t0AnchorIdx (по умолчанию —
  // последний месяц истории; при заданном options.start_month — предыдущий
  // месяц старта работ). Логика роста:
  //   1. Доля рынка (capture) монотонно не убывает — позиции только растут
  //      (SOV_max ≥ SOV_start·(1+G)). Это «двигатель» роста трафика.
  //   2. Спрос — модификатор СКОРОСТИ: (L0 + t·T)·(1 + r·t). Если рынок
  //      растёт — трафик ускоряется; если проседает — рост замедляется и
  //      десезонализированное ядро может снижаться, НО не ниже стартового
  //      уровня (startCore floor) — общая динамика остаётся положительной.
  //   3. Сезонность применяется поверх ядра: реальный трафик месяца может
  //      проседать сезонно ниже старта (это нормально и наглядно).
  const fc = [];
  let prevCapture = sovStart;
  for (let t = 1; t <= horizon; t++) {
    const periodIdx = t0AnchorIdx != null ? t0AnchorIdx + t : null;
    const period = periodIdx != null ? _indexToPeriod(periodIdx) : `m+${t}`;
    const cm = periodIdx != null ? periodIdx % 12 : (t - 1) % 12;
    const s = seasonal[cm];
    // Индекс «того же месяца год назад» для YoY-сравнения (диагностика).
    const yoyIdx = periodIdx != null ? periodIdx - 12 : null;
    // Ёмкость рынка (TAC): деманд-потенциал → кликабельная ёмкость.
    const demandPotential = Math.max(0, (L0 + t * T) * s * (1 + r * t));
    const tac = demandPotential * cYield;
    // Функция захвата (S-кривая) — динамика основного (стартового) ядра.
    const captureCore = sovStart + (sovMax - sovStart) / (1 + Math.exp(-k * (t - t0)));
    // Взвешенное размытие: новая семантика (вес r·t) кликается хуже ядра.
    const captureBlend = (captureCore + sovNew * (r * t)) / (1 + r * t);
    // Монотонный floor: доля рынка не может упасть ниже уже достигнутой.
    const capture = Math.max(captureBlend, prevCapture);
    prevCapture = capture;
    // Десезонализированное ядро трафика: базовый спрос (без сезонности)
    // × живые клики × расширение ядра × захват × калибровка к старту.
    // Спрос (L0 + t·T) выступает модификатором скорости: падающий рынок
    // тормозит рост, растущий — ускоряет.
    const coreRaw = Math.max(0, (L0 + t * T)) * (1 + r * t) * cYield * capture * calib;
    // Soft-floor «не ниже уровня старта работ»: даже если спрос проседает,
    // десезонализированное ядро удерживает стартовый уровень (позиции растут).
    // Монотонность НЕ навязывается — при спаде спроса ядро может замедляться.
    const core = Math.max(coreRaw, startCore);
    // Итог: ядро × сезонность (сезонные просадки допустимы и закономерны).
    const value = Math.max(0, core * s);
    // Показы и лиды по воронке: показы → визиты (value) → лиды (× CR_final).
    const impressions = _impressions(value, Math.round(demandPotential));
    const leads = crFinal > 0 ? Math.round(value * crFinal * 10) / 10 : null;
    // Два множителя (спрос × позиции) — прозрачность для маркетолога.
    let demandYoy = null;
    let captureGrowth = null;
    if (yoyIdx != null && retroDemandByIdx.has(yoyIdx) && retroDemandByIdx.get(yoyIdx) > 0) {
      demandYoy = _round(demandPotential / retroDemandByIdx.get(yoyIdx), 3);
    }
    if (sovStart > 0) {
      captureGrowth = _round(capture / sovStart, 3);
    }
    const widen = Math.sqrt(t);
    const upper = value * (1 + delta * widen);
    const lower = value * Math.max(0, 1 - delta * widen);
    fc.push({
      period,
      t,
      demand: Math.round(demandPotential),
      demand_potential: Math.round(demandPotential),
      tac: Math.round(tac),
      capture: _round(capture, 4),
      capture_growth: captureGrowth, // capture(t) / SOV_start
      demand_yoy: demandYoy,          // demand(t) / demand(t-12)
      core: Math.round(core),
      seasonal: _round(s, 3),
      value: Math.round(value),
      impressions,
      lower: Math.round(lower),
      upper: Math.round(upper),
      leads,
    });
  }

  const annualValue = fc.reduce((a, p) => a + p.value, 0);
  const annualLower = fc.reduce((a, p) => a + p.lower, 0);
  const annualUpper = fc.reduce((a, p) => a + p.upper, 0);
  const annualImpressions = fc.reduce((a, p) => a + (p.impressions || 0), 0);
  const annualLeads = crFinal > 0 ? fc.reduce((a, p) => a + (p.leads || 0), 0) : null;
  const lastFc = fc[fc.length - 1] || null;

  // Явная стартовая точка (t=0): месяц перед началом прогноза. Трафик здесь —
  // РОВНО введённое пользователем текущее значение, от него стартует график.
  const startPointPeriod = t0AnchorIdx != null ? _indexToPeriod(t0AnchorIdx) : null;
  const startImpressions = _impressions(curTraffic, Math.round(dNow));
  const start = {
    period: startPointPeriod,
    demand: Math.round(dNow),
    traffic: Math.round(curTraffic),
    impressions: startImpressions,
    capture: _round(sovStart, 4),
    leads: crFinal > 0 ? Math.round(curTraffic * crFinal * 10) / 10 : null,
  };

  return {
    verdict: 'ok',
    today_period: series[n - 1].period,
    start_period: startPeriod || (lastIdx != null ? _indexToPeriod(lastIdx + 1) : null),
    horizon,
    params: {
      L0: Math.round(L0),
      T: _round(T, 2),
      c_yield: _round(cYield, 3),
      r: _round(r, 4),
      target_ctr: _round(targetCtr, 4),
      c_serp: cSerp,
      comm_percent: _round(comm, 3),
      min_growth: _round(minGrowth, 3),
      ctr_new: _round(ctrNew, 4),
      sov_new: _round(sovNew, 4),
      sov_max: _round(sovMax, 4),
      sov_start: _round(sovStart, 4),
      k: _round(k, 3),
      t0,
      delta: _round(delta, 3),
      cr_final: _round(crFinal, 5),
      impression_ctr: _round(impressionCtr, 4),
      seasonal, // 12 множителей, индекс 0 = январь
    },
    retro,
    start,
    forecast: fc,
    summary: {
      current_traffic: curTraffic,
      start,
      annual: { value: annualValue, lower: annualLower, upper: annualUpper },
      annual_impressions: annualImpressions,
      at_horizon: lastFc ? { period: lastFc.period, value: lastFc.value, lower: lastFc.lower, upper: lastFc.upper } : null,
      leads_annual: annualLeads != null ? Math.round(annualLeads) : (crFinal > 0 ? Math.round(annualValue * crFinal) : null),
    },
    // Пояснения «человеческим языком» для бизнесмена/маркетолога.
    explain: _buildExplain({
      L0, T, cYield, r, targetCtr, cSerp, sovMax, sovStart, minGrowth, k, t0, delta, horizon, lastFc, curTraffic,
    }),
  };
}

// Пояснения простым языком: что за число, откуда и почему.
function _buildExplain({ L0, T, cYield, r, targetCtr, cSerp, sovMax, sovStart, minGrowth, k, t0, delta, horizon, lastFc, curTraffic }) {
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const trendWord = T > 0.5 ? 'рынок растёт' : T < -0.5 ? 'рынок проседает' : 'рынок стабилен';
  return {
    summary:
      `Берём спрос из Wordstat, оставляем только тех, кто реально кликает (${pct(cYield)}), ` +
      `и умножаем на вашу растущую долю рынка. За ${horizon} мес доля поднимается ` +
      `с ${pct(sovStart)} до потолка ${pct(sovMax)} по S-образной кривой.`,
    factors: [
      { key: 'L0', label: 'Базовый спрос сейчас', value: Math.round(L0),
        plain: `Сколько людей в среднем ищут ваши запросы в месяц (очищено от сезонных всплесков). ${trendWord}.` },
      { key: 'T', label: 'Тренд рынка', value: Math.round(T * 10) / 10,
        plain: 'На столько запросов рынок растёт или падает КАЖДЫЙ месяц сам по себе, без вашего участия.' },
      { key: 'c_yield', label: 'Живые клики (Zero-click)', value: pct(cYield),
        plain: 'Не все, кто ищет, кликают: часть читает готовый ответ Яндекса. Учитываем только реальные переходы.' },
      { key: 'r', label: 'Расширение семантики', value: pct(r) + '/мес',
        plain: r > 0
          ? 'Каждый месяц вы добавляете новые страницы/темы и охватываете больше запросов — потолок растёт.'
          : 'Расширение ядра не заложено (0%). Если планируете писать новые статьи — поднимите этот параметр.' },
      { key: 'sov_max', label: 'Потолок доли рынка', value: pct(sovMax),
        plain: `Максимум трафика, который реально забрать: max(целевой CTR ${pct(targetCtr)} × штраф за «умную» выдачу ${cSerp}, текущая доля × ${(1 + minGrowth).toFixed(2)}). Потолок математически защищён от падения ниже вашей текущей доли.` },
      { key: 'sov_start', label: 'Доля рынка сейчас', value: pct(sovStart),
        plain: curTraffic > 0
          ? 'Какую часть спроса вы забираете уже сегодня (ваш трафик ÷ весь спрос).'
          : 'Стартуете почти с нуля — новый сайт или нет текущего трафика.' },
      { key: 'k', label: 'Скорость роста', value: k,
        plain: 'Насколько агрессивно продвигаетесь. Больше — быстрее выходите к потолку.' },
      { key: 't0', label: 'Месяц прорыва', value: t0,
        plain: `Примерно на ${t0}-м месяце рост становится самым бурным (перегиб кривой): SEO «разгоняется».` },
      { key: 'delta', label: 'Погрешность', value: pct(delta) + ' × √мес',
        plain: `Чем дальше прогноз — тем шире «вилка». В 1-й месяц ±${pct(delta)}, к ${horizon}-му ±${pct(delta * Math.sqrt(horizon))}. Это честно: будущее неточно.` },
    ],
    horizon_line: lastFc
      ? `Через ${horizon} мес: ~${lastFc.value.toLocaleString('ru-RU')} визитов/мес ` +
        `(от ${lastFc.lower.toLocaleString('ru-RU')} до ${lastFc.upper.toLocaleString('ru-RU')}).`
      : null,
  };
}

module.exports = { buildUnifiedForecast, _seasonalFactors, _serpCoefficient };
