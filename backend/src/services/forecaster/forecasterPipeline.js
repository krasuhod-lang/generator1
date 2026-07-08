'use strict';

/**
 * forecaster/forecasterPipeline.js — главный оркестратор задачи.
 *
 * Шаги:
 *   0. status='running', started_at=NOW
 *   1. parse(source) → строки + monthCols
 *   2. aggregate → monthlySeries
 *   3. detectAnomalies → drops
 *   4. buildForecast → 12 мес + trend + CI
 *   5. estimateTraffic → top3/5/10
 *   6. runDeepSeekAnalysis (graceful skip / error → продолжаем)
 *   7. сохраняем всё в forecaster_tasks, status='done'
 *
 * При исключении на любом из шагов 1–5 — status='error' с сообщением.
 * DeepSeek-ошибки не считаются фатальными.
 */

const db = require('../../config/db');
const { parseForecasterInput } = require('./parser');
const { aggregateMonthlySeries } = require('./series');
const { detectAnomalies } = require('./anomalyDetector');
const { buildForecast } = require('./forecast');
const { estimateTraffic } = require('./trafficModel');
const { runDeepSeekAnalysis, runDeepSeekJunkRefine, runNicheStrategist, runOpportunityHunter, runClusterPlanner } = require('./deepseekAnalyzer');
const { classifyJunkPhrases, REASON_LABELS } = require('./junkClassifier');
const { fetchPhraseSignals, aggregateSignals } = require('./keyssoClient');
const { collectSeasonality, collectCommercialization, collectSerpFeatures } = require('./arsenkinClient');
const { filterKeywords } = require('./stopWordFilter');
const { analyzeOpportunities } = require('./opportunityAnalyzer');
const { getForecasterConfig } = require('./config');
const { buildSovForecast } = require('./sovForecast');
const { buildUnifiedForecast } = require('./unifiedForecast');
const { createFunnelTracker } = require('../aegis/funnelTracker');


/**
 * Прогресс выполнения задачи («ползунок» в UI). Fire-and-forget UPDATE —
 * сбой записи прогресса не должен ломать пайплайн.
 * @param {string} taskId
 * @param {{stage:string, percent:number, label:string, detail?:string|null}} p
 */
async function _setProgress(taskId, { stage, percent, label, detail = null }) {
  const payload = {
    stage,
    percent: Math.max(0, Math.min(100, Math.round(Number(percent) || 0))),
    label,
    detail,
    updated_at: new Date().toISOString(),
  };
  try {
    await db.query(
      `UPDATE forecaster_tasks SET progress=$2::jsonb, updated_at=NOW() WHERE id=$1`,
      [taskId, JSON.stringify(payload)],
    );
  } catch (err) {
    console.warn(`[Forecaster] task ${taskId}: не удалось записать прогресс (${err.message})`);
  }
}

// Проценты «ползунка» по шагам пайплайна. Сбор сезонности Арсенкина —
// самый долгий этап, ему отведён диапазон 5..45 % (детализируется по батчам).
const PROGRESS_STEPS = {
  parse:                { percent: 3,   label: 'Чтение исходных данных' },
  arsenkin_seasonality: { percent: 5,   label: 'Сбор сезонности (Вордстат)' },
  junk_classify:        { percent: 48,  label: 'Фильтрация шлак-запросов' },
  aggregate:            { percent: 52,  label: 'Агрегация помесячного спроса' },
  anomalies:            { percent: 55,  label: 'Поиск аномалий' },
  forecast:             { percent: 58,  label: 'Прогноз спроса' },
  sov_forecast:         { percent: 66,  label: 'Прогноз доли рынка (SOV)' },
  unified_forecast:     { percent: 62,  label: 'Единая модель трафика' },
  keysso_signals:       { percent: 70,  label: 'Сигналы keys.so' },
  traffic_estimate:     { percent: 78,  label: 'Оценка трафика' },
  persist_partial:      { percent: 82,  label: 'Сохранение результатов' },
  deepseek_analysis:    { percent: 86,  label: 'AI-аналитика' },
  finalize:             { percent: 97,  label: 'Финализация' },
};

function _normPhrase(v) {
  return String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function _clampInt(v, def, min, max) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function _sanitizeUnit(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function _sanitizeSerpElements(v) {
  if (!Array.isArray(v)) return null;
  const allowed = new Set(['direct', 'maps', 'market', 'goods_gallery', 'other']);
  const out = [];
  for (const it of v) {
    if (!it || typeof it !== 'object') continue;
    const type = allowed.has(String(it.type)) ? String(it.type) : 'other';
    const count = Math.max(0, Math.floor(Number(it.count) || 0));
    if (count > 0) out.push({ type, count });
  }
  return out;
}

function _resolveCrBase(options, cfg) {
  const userCr = Number(options.conversion_rate);
  if (Number.isFinite(userCr) && userCr >= cfg.leads.minCr && userCr <= cfg.leads.maxCr) return userCr;
  const intent = options.intent ? String(options.intent).trim() : null;
  if (intent && cfg.leads.intentPresets[intent] != null) return cfg.leads.intentPresets[intent];
  return cfg.leads.defaultConversionRate;
}

function _phraseVolumes(rows, mainQuery) {
  let clusterVolume = 0;
  let maxTotal = 0;
  let mainQueryVolume = 0;
  const mainNorm = _normPhrase(mainQuery);
  for (const r of rows || []) {
    const total = Math.max(0, Number(r.total) || 0);
    clusterVolume += total;
    if (total > maxTotal) maxTotal = total;
    if (mainNorm && _normPhrase(r.phrase) === mainNorm) mainQueryVolume = total;
  }
  return {
    clusterVolume,
    mainQueryVolume: mainQueryVolume > 0 ? mainQueryVolume : maxTotal,
  };
}

/**
 * Конвертирует rows Арсенкина ({phrase,total,byPeriod}) в структуру,
 * совместимую с выходом parseForecasterInput (monthCols = union периодов).
 */
function _parsedFromArsenkinRows(rows) {
  const periods = new Set();
  for (const r of rows) {
    for (const p of Object.keys(r.byPeriod || {})) periods.add(p);
  }
  const monthCols = [...periods].sort().map((p, i) => ({ index: i + 1, header: p, period: p }));
  const normRows = rows.map((r) => {
    const byPeriod = {};
    for (const mc of monthCols) {
      const v = Number((r.byPeriod || {})[mc.period]);
      byPeriod[mc.period] = Number.isFinite(v) ? v : 0;
    }
    const total = Number(r.total) || Object.values(byPeriod).reduce((a, b) => a + b, 0);
    return { phrase: String(r.phrase || '').trim(), total, byPeriod };
  }).filter((r) => r.phrase);
  return {
    filename: 'arsenkin-seasonality',
    rowsCount: normRows.length,
    phraseCol: 0,
    totalCol: null,
    monthCols,
    rows: normRows,
    warnings: [],
  };
}

async function processForecasterTask(taskId) {
  if (!taskId) throw new Error('processForecasterTask: taskId required');

  // 1. Загружаем задачу
  const { rows } = await db.query(
    `SELECT id, user_id, name, options, source_columns, source_filename
       FROM forecaster_tasks
      WHERE id = $1`,
    [taskId],
  );
  if (rows.length === 0) {
    console.error(`[Forecaster] task ${taskId} not found`);
    return;
  }
  const task = rows[0];
  const options = task.options || {};
  const sourceColumns = task.source_columns || {};
  const rawTable = sourceColumns.raw_rows; // массив массивов строк (передан фронтом)
  const rawCsv   = sourceColumns.raw_csv;  // или CSV-строка
  const rawKeywords = sourceColumns.keywords; // режим «список ключей» → сезонность через Арсенкин
  const filename = task.source_filename || '';

  await db.query(
    `UPDATE forecaster_tasks SET status='running', started_at=NOW(), updated_at=NOW() WHERE id=$1`,
    [taskId],
  );

  const funnel = createFunnelTracker({ kind: 'forecaster', taskRef: taskId, userId: task.user_id });

  // Шаг воронки + обновление «ползунка» прогресса (fire-and-forget).
  const step = (name) => {
    funnel.step(name);
    const p = PROGRESS_STEPS[name];
    if (p) void _setProgress(taskId, { stage: name, ...p });
  };
  await _setProgress(taskId, { stage: 'start', percent: 1, label: 'Задача запущена' });

  try {
    step('parse');
    // 2. Источник данных: список ключей (сезонность через Арсенкин) либо файл
    let parsed;
    let arsenkinReport = null;
    if (Array.isArray(rawKeywords) && rawKeywords.length > 0) {
      // 2a. Режим «список ключей»: ПЕРЕД сбором сезонности исключаем
      // фразы со стоп-словами (бесплатно/скачать/авито/… — см. ТЗ),
      // затем через Арсенкин снимаем помесячную частотность за год.
      step('arsenkin_seasonality');
      const { kept, excluded } = filterKeywords(rawKeywords);
      if (kept.length === 0) {
        arsenkinReport = {
          verdict: 'error',
          reason: 'Все ключевые запросы отфильтрованы стоп-словами',
          keywords_input: rawKeywords.length,
          keywords_kept: 0,
          stop_words_excluded: excluded,
        };
        await db.query(
          `UPDATE forecaster_tasks SET arsenkin_report=$2::jsonb, updated_at=NOW() WHERE id=$1`,
          [taskId, JSON.stringify(arsenkinReport)],
        );
        throw new Error('Все ключевые запросы попали под стоп-слова — собирать сезонность не по чему');
      }
      const ars = await collectSeasonality({
        phrases: kept,
        regionLabel: options.region,
        regionLr: options.region_lr,
        // Детализация «ползунка» внутри самого долгого этапа: диапазон 5..45 %
        // пропорционально числу уже собранных фраз.
        onProgress: ({ done, total }) => {
          const frac = total > 0 ? done / total : 0;
          void _setProgress(taskId, {
            stage: 'arsenkin_seasonality',
            percent: 5 + Math.round(frac * 40),
            label: 'Сбор сезонности (Вордстат)',
            detail: `Получены данные по ${done} из ${total} фраз`,
          });
        },
      });
      arsenkinReport = {
        verdict:     ars.verdict,
        reason:      ars.reason || null,
        requested:   ars.requested ?? kept.length,
        matched:     ars.matched ?? 0,
        region_lr:   ars.region_lr ?? null,
        duration_ms: ars.duration_ms ?? null,
        tasks:       ars.tasks || [],
        keywords_input: rawKeywords.length,
        keywords_kept:  kept.length,
        stop_words_excluded: excluded,
      };
      // Сохраняем отчёт сразу — чтобы UI видел диагностику даже при ошибке.
      await db.query(
        `UPDATE forecaster_tasks SET arsenkin_report=$2::jsonb, updated_at=NOW() WHERE id=$1`,
        [taskId, JSON.stringify(arsenkinReport)],
      );
      if (ars.verdict === 'skipped') {
        throw new Error(ars.reason === 'no_api_key'
          ? 'Не задан токен API Арсенкина (env ARSENKIN_API_TOKEN)'
          : `Сбор сезонности пропущен: ${ars.reason}`);
      }
      if (ars.verdict !== 'ok' || !Array.isArray(ars.rows) || ars.rows.length === 0) {
        throw new Error(`Сбор сезонности через Арсенкин не удался: ${ars.reason || 'пустой результат'}`);
      }
      parsed = _parsedFromArsenkinRows(ars.rows);
    } else if (Array.isArray(rawTable)) {
      parsed = parseForecasterInput({ rows: rawTable }, { filename });
    } else if (typeof rawCsv === 'string' && rawCsv.length > 0) {
      parsed = parseForecasterInput(rawCsv, { filename });
    } else {
      throw new Error('Не переданы данные: нужен файл (rows/csv) или список ключевых запросов (keywords)');
    }
    if (parsed.rowsCount === 0) {
      throw new Error('Не удалось извлечь ни одной строки из файла');
    }
    if (parsed.monthCols.length < 3) {
      throw new Error(`Найдено только ${parsed.monthCols.length} помесячных колонок (нужно минимум 3). Проверьте заголовки.`);
    }

    // Текущий трафик и URL продвигаемого сайта — нужны и junk-классификатору
    // (для foreign_brand), и trafficEstimate, и keys.so.
    const currentTraffic = Number(options.current_traffic_per_month) || 0;
    const targetUrl = String(options.target_url || '').trim() || null;

    // 3. Junk-классификатор фраз (детерминированный) — выполняется ДО
    //    агрегации, чтобы из суммы спроса вычесть однословные ВЧ /
    //    мёртвые / чужие бренды (см. cfg.junk.excludeFromForecastReasons).
    step('junk_classify');
    const junkRaw = classifyJunkPhrases({
      parsedRows: parsed.rows,
      monthCols:  parsed.monthCols,
      targetUrl,
    });
    const excludeSet = new Set();
    for (const f of junkRaw.flagged) {
      if (f.exclude_from_forecast) {
        excludeSet.add(_normPhrase(f.phrase));
      }
    }

    // 4. Агрегация (с учётом исключённых фраз)
    step('aggregate');
    const seriesData = aggregateMonthlySeries(parsed, { excludePhrases: excludeSet });
    if (seriesData.monthly.length < 3) {
      throw new Error('После агрегации меньше 3 месяцев данных — недостаточно для анализа');
    }

    const remainingRows = parsed.rows.filter((r) => {
      const norm = _normPhrase(r.phrase);
      return norm && !excludeSet.has(norm);
    });
    const topPhrases = [...remainingRows]
      .sort((a, b) => Number(b.total || 0) - Number(a.total || 0))
      .map((r) => String(r.phrase || '').trim())
      .filter(Boolean);

    // 5. Аномалии
    step('anomalies');
    const anomalies = detectAnomalies(seriesData.monthly);

    // 6. Прогноз
    step('forecast');
    const forecast = buildForecast(seriesData.monthly);

    // 6a. Единая («перепрошитая») модель прогноза трафика: считаем ПЕРВОЙ,
    // чтобы SOV-прогноз мог взять её realistic-трафик как эталон и оба
    // графика (Прогноз трафика и Прогноз SOV) показывали ОДИН И ТОТ ЖЕ трафик.
    step('unified_forecast');
    const cfgAll = getForecasterConfig();
    const hMax = _clampInt(options.h_max, cfgAll.sov.hMaxDefault, 1, cfgAll.sov.hMaxLimit);
    const { clusterVolume, mainQueryVolume } = _phraseVolumes(remainingRows, options.main_query);
    let commPercent = _sanitizeUnit(options.comm_percent);
    let serpElements = _sanitizeSerpElements(options.serp_elements);
    try {
      if (commPercent == null) {
        const collectedComm = await collectCommercialization({ phrases: topPhrases.slice(0, 50), regionLabel: options.region, regionLr: options.region_lr });
        commPercent = _sanitizeUnit(collectedComm);
      }
    } catch (_) { commPercent = null; }
    try {
      if (serpElements == null) {
        const collectedSerp = await collectSerpFeatures({ phrases: topPhrases.slice(0, 50), regionLabel: options.region, regionLr: options.region_lr });
        serpElements = _sanitizeSerpElements(collectedSerp);
      }
    } catch (_) { serpElements = null; }
    if (commPercent == null) commPercent = 1.0;
    if (!Array.isArray(serpElements)) serpElements = [];

    let unifiedForecast = null;
    try {
      const crFinalUnified = Math.round(
        _resolveCrBase(options, cfgAll) * Math.max(0, Math.min(1, Number(commPercent) || 0)) * 100000,
      ) / 100000;
      unifiedForecast = buildUnifiedForecast({
        monthly: seriesData.monthly,
        forecastPoints: forecast.points,
        options: { ...options, h_max: hMax },
        currentTrafficPerMonth: currentTraffic,
        serpElements,
        commPercent,
        crFinal: crFinalUnified,
        cfg: cfgAll,
      });
    } catch (err) {
      unifiedForecast = { verdict: 'error', reason: (err && err.message) || String(err) };
    }

    // 6b. SOV-прогноз: доля рынка строится на том же прогнозе спроса,
    // а cluster/main объёмы временно берём из строк Wordstat.
    // «Реалистичный» сценарий берёт трафик и capture из unifiedForecast
    // (устраняет расхождение «на 2-м месяце трафик совершенно другой»).
    step('sov_forecast');
    const sovForecast = buildSovForecast({
      monthly: seriesData.monthly,
      forecastPoints: forecast.points,
      vCurrent: currentTraffic,
      hMax,
      crBase: _resolveCrBase(options, cfgAll),
      commPercent,
      serpElements,
      clusterVolume,
      mainQueryVolume,
      cfg: cfgAll,
      unifiedForecast,
      startMonth: options.start_month || null,
    });

    // 6b. Keys.so signals (graceful skip без ключа). Шлём top-N фраз по total
    // (после фильтрации исключённых) — чтобы экономить квоту.
    step('keysso_signals');
    let keyssoSignalsReport = null;
    let keyssoSignalsMap    = null; // Map<normPhrase, signals> для opportunityAnalyzer
    try {
      const ksResp = await fetchPhraseSignals({
        phrases: topPhrases,
        domain:  targetUrl,
        region:  options.region,
      });
      if (ksResp.verdict === 'ok') {
        const agg = aggregateSignals(ksResp.signals, ksResp.requested);
        keyssoSignalsMap = ksResp.signals;
        keyssoSignalsReport = {
          verdict:      'ok',
          requested:    ksResp.requested,
          matched:      ksResp.matched,
          cache_hits:   ksResp.cache_hits,
          duration_ms:  ksResp.duration_ms,
          domain:       ksResp.domain,
          region:       ksResp.region,
          engine:       ksResp.engine,
          aggregate:    agg,
        };
      } else {
        keyssoSignalsReport = {
          verdict: ksResp.verdict,
          reason:  ksResp.reason || null,
        };
      }
    } catch (err) {
      keyssoSignalsReport = { verdict: 'error', reason: (err && err.message) || String(err) };
    }

    // Conversion rate + intent — задаются пользователем при создании задачи.
    // Считаем ТОЛЬКО объём заявок (= traffic × CR); никакой выручки/маржи
    // (см. memory «env configuration» + требование владельца продукта).
    const conversionRate = Number(options.conversion_rate) || null;
    const intent = options.intent ? String(options.intent).trim() : null;

    // 7. Трафик (с калибровкой по keys.so + лиды по CR)
    step('traffic_estimate');
    const trafficEstimate = estimateTraffic({
      historicalMonthly: seriesData.monthly,
      forecastPoints:    forecast.points,
      currentTrafficPerMonth: currentTraffic,
      keyssoAggregate:   keyssoSignalsReport?.verdict === 'ok' ? keyssoSignalsReport.aggregate : null,
      conversionRate,
      intent,
    });

    // 7c. Advanced analytics: opportunityAnalyzer (точечные просадки + ранжированные «точки усиления»).
    // Работает только на фразах, оставшихся после junk-фильтра. Гейт — advanced.enabled.
    let opportunitiesReport = null;
    const advCfg = getForecasterConfig().advanced;
    if (advCfg && advCfg.enabled) {
      try {
        const remainingRowsForOpp = parsed.rows.filter((r) => {
          const norm = String(r.phrase || '').trim().toLowerCase().replace(/\s+/g, ' ');
          return norm && !excludeSet.has(norm);
        });
        opportunitiesReport = analyzeOpportunities({
          parsedRows: remainingRowsForOpp,
          monthCols:  parsed.monthCols,
          keyssoSignalsMap,
          conversionRate,
          intent,
        });
      } catch (err) {
        opportunitiesReport = { verdict: 'error', reason: (err && err.message) || String(err) };
      }
    } else {
      opportunitiesReport = { verdict: 'skipped', reason: 'advanced_disabled' };
    }

    // 7b. Финализируем junkReport (он построен ранее, но сохраним вместе со всем)
    // Ограничиваем payload в БД: храним top-N помеченных фраз, остальное —
    // сводно. По умолчанию хватит 500 для UI; флаг overflow подсветит факт обрезки.
    const JUNK_STORE_LIMIT = 500;
    const flaggedTrimmed = junkRaw.flagged.slice(0, JUNK_STORE_LIMIT);
    const junkReport = {
      flagged: flaggedTrimmed,
      counts:  junkRaw.counts,
      summary: junkRaw.summary,
      reason_labels: REASON_LABELS,
      overflow: junkRaw.flagged.length > JUNK_STORE_LIMIT
        ? { stored: JUNK_STORE_LIMIT, total: junkRaw.flagged.length }
        : null,
    };

    // 7. Сохраняем «полу-готовое» состояние, чтобы UI мог показать
    // данные даже если DeepSeek потом упадёт.
    step('persist_partial');
    const sourceMeta = {
      phrase_col: parsed.phraseCol,
      total_col:  parsed.totalCol,
      month_cols: parsed.monthCols,
      warnings:   parsed.warnings,
      target_url: targetUrl,
      source_kind: arsenkinReport ? 'arsenkin_keywords' : 'file',
    };
    // Компактная leads_summary — то, что фронт сможет показать без копания
    // в traffic_estimate.* (для шапки страницы результата).
    const leadsSummary = trafficEstimate && trafficEstimate.leads_model ? {
      conversion_rate:          trafficEstimate.leads_model.conversion_rate,
      conversion_rate_pct:      trafficEstimate.leads_model.conversion_rate_pct,
      conversion_rate_source:   trafficEstimate.leads_model.conversion_rate_source,
      intent:                   trafficEstimate.leads_model.intent,
      current_leads_per_month:  trafficEstimate.leads_model.current_leads_per_month,
      current_leads_annual:     trafficEstimate.leads_model.current_leads_annual,
      top3_annual:              trafficEstimate.top3?.leads?.annual,
      top5_annual:              trafficEstimate.top5?.leads?.annual,
      top10_annual:             trafficEstimate.top10?.leads?.annual,
      // Главная цифра новой (единой) модели — для шапки результата.
      unified_annual:           unifiedForecast?.summary?.annual?.value ?? null,
      unified_annual_lower:     unifiedForecast?.summary?.annual?.lower ?? null,
      unified_annual_upper:     unifiedForecast?.summary?.annual?.upper ?? null,
      unified_leads_annual:     unifiedForecast?.summary?.leads_annual ?? null,
    } : null;

    await db.query(
      `UPDATE forecaster_tasks SET
         source_rows_count=$2,
         source_columns=$3::jsonb,
         monthly_series=$4::jsonb,
         anomalies=$5::jsonb,
         forecast=$6::jsonb,
         trend=$7::jsonb,
         traffic_estimate=$8::jsonb,
         target_url=$9,
         junk_phrases=$10::jsonb,
         keysso_signals=$11::jsonb,
         opportunities=$12::jsonb,
         leads_summary=$13::jsonb,
         sov_forecast=$14::jsonb,
         unified_forecast=$15::jsonb,
         updated_at=NOW()
       WHERE id=$1`,
      [
        taskId,
        parsed.rowsCount,
        JSON.stringify(sourceMeta),
        JSON.stringify(seriesData),
        JSON.stringify(anomalies),
        JSON.stringify({ ...forecast, trend: undefined }),
        JSON.stringify(forecast.trend),
        JSON.stringify(trafficEstimate),
        targetUrl,
        JSON.stringify(junkReport),
        keyssoSignalsReport ? JSON.stringify(keyssoSignalsReport) : null,
        opportunitiesReport ? JSON.stringify(opportunitiesReport) : null,
        leadsSummary ? JSON.stringify(leadsSummary) : null,
        JSON.stringify(sovForecast),
        JSON.stringify(unifiedForecast),
      ],
    );

    // 8. DeepSeek — graceful (анализ + junk refinement)
    step('deepseek_analysis');
    const ds = await runDeepSeekAnalysis({
      sourceInfo: { filename, rowsCount: parsed.rowsCount },
      monthlySeries: seriesData.monthly,
      anomalies,
      forecast,
      trend: forecast.trend,
      trafficEstimate,
      targetUrl,
      junkSummary: junkReport,
      keyssoSignals: keyssoSignalsReport,
      unifiedForecast,
    });

    // 8b. Junk refinement — берём top-K кандидатов и просим DS дать verdict + reason
    const cfgJunk = getForecasterConfig().junk;
    const candidates = flaggedTrimmed.slice(0, cfgJunk.deepseekTopK);
    const junkRefine = await runDeepSeekJunkRefine({ candidates, targetUrl });
    // Прокидываем annotations обратно в flagged (если ok)
    if (junkRefine && junkRefine.verdict === 'ok' && junkRefine.annotations) {
      for (const f of junkReport.flagged) {
        const ann = junkRefine.annotations[String(f.phrase || '').toLowerCase()];
        if (ann) {
          f.ai_verdict = ann.verdict;
          f.ai_reason  = ann.reason;
        }
      }
      junkReport.deepseek = {
        verdict: 'ok',
        items_count: junkRefine.items_count,
        tokens_in: junkRefine.tokens_in,
        tokens_out: junkRefine.tokens_out,
        cost_usd: junkRefine.cost_usd,
        model: junkRefine.model,
      };
      // пере-сохраним junk_phrases с обогащением
      await db.query(
        `UPDATE forecaster_tasks SET junk_phrases=$2::jsonb, updated_at=NOW() WHERE id=$1`,
        [taskId, JSON.stringify(junkReport)],
      );
    } else if (junkRefine) {
      junkReport.deepseek = { verdict: junkRefine.verdict, reason: junkRefine.reason || null };
      await db.query(
        `UPDATE forecaster_tasks SET junk_phrases=$2::jsonb, updated_at=NOW() WHERE id=$1`,
        [taskId, JSON.stringify(junkReport)],
      );
    }

    // 8c. DSPy-style эксперты (NicheStrategist / OpportunityHunter / ClusterPlanner).
    // Все три graceful: skipped без ключа или если advanced.enabled=false.
    // Запускаем последовательно — на типовом ядре все три уложатся в ~2-3 мин
    // и расходуют умеренный бюджет токенов (max ~5k tokens out суммарно).
    let expertReports = null;
    if (advCfg && advCfg.enabled) {
      // monthly_summary — короткий контекст для NicheStrategist.
      const monthlySummary = {
        months_count: seriesData.monthly.length,
        annual_total_forecast: forecast.annual_total,
        trend_direction: forecast.trend?.direction,
        trend_slope_per_month: forecast.trend?.slope_per_month,
        anomalies_count: anomalies?.summary?.count || 0,
        max_severity:    anomalies?.summary?.max_severity || null,
      };
      const niche = await runNicheStrategist({
        keyssoAggregate: keyssoSignalsReport?.verdict === 'ok' ? keyssoSignalsReport.aggregate : null,
        junkSummary:     junkReport,
        trafficRealism:  trafficEstimate?.realism || null,
        monthlySummary,
        targetUrl,
        mainQuery:     options.main_query || null,
        samplePhrases: topPhrases,
      });
      const hunter = (opportunitiesReport && opportunitiesReport.verdict === 'ok')
        ? await runOpportunityHunter({
            opportunities: opportunitiesReport.opportunities,
            calibration:   opportunitiesReport.calibration,
            targetUrl,
          })
        : { verdict: 'skipped', reason: 'no_opportunities' };
      const planner = (opportunitiesReport && opportunitiesReport.verdict === 'ok'
                       && opportunitiesReport.clusters && opportunitiesReport.clusters.length > 0)
        ? await runClusterPlanner({
            clusters:    opportunitiesReport.clusters,
            calibration: opportunitiesReport.calibration,
            targetUrl,
          })
        : { verdict: 'skipped', reason: 'no_clusters' };
      expertReports = { niche_strategist: niche, opportunity_hunter: hunter, cluster_planner: planner };

      const expCost = (niche.cost_usd || 0) + (hunter.cost_usd || 0) + (planner.cost_usd || 0);
      const expIn   = (niche.tokens_in  || 0) + (hunter.tokens_in  || 0) + (planner.tokens_in  || 0);
      const expOut  = (niche.tokens_out || 0) + (hunter.tokens_out || 0) + (planner.tokens_out || 0);
      await db.query(
        `UPDATE forecaster_tasks SET
           expert_reports=$2::jsonb,
           tokens_in=tokens_in+$3,
           tokens_out=tokens_out+$4,
           cost_usd=cost_usd+$5,
           updated_at=NOW()
         WHERE id=$1`,
        [taskId, JSON.stringify(expertReports), expIn, expOut, expCost],
      );
    } else {
      expertReports = {
        niche_strategist:   { verdict: 'skipped', reason: 'advanced_disabled' },
        opportunity_hunter: { verdict: 'skipped', reason: 'advanced_disabled' },
        cluster_planner:    { verdict: 'skipped', reason: 'advanced_disabled' },
      };
    }

    // 9. Финал
    step('finalize');
    const dsCost     = ds.verdict === 'ok' ? (ds.cost_usd || 0) : 0;
    const refineCost = junkRefine && junkRefine.verdict === 'ok' ? (junkRefine.cost_usd || 0) : 0;
    const dsIn       = ds.verdict === 'ok' ? (ds.tokens_in || 0) : 0;
    const refineIn   = junkRefine && junkRefine.verdict === 'ok' ? (junkRefine.tokens_in || 0) : 0;
    const dsOut      = ds.verdict === 'ok' ? (ds.tokens_out || 0) : 0;
    const refineOut  = junkRefine && junkRefine.verdict === 'ok' ? (junkRefine.tokens_out || 0) : 0;
    await db.query(
      `UPDATE forecaster_tasks SET
         status='done',
         completed_at=NOW(),
         updated_at=NOW(),
         deepseek_summary=$2::jsonb,
         llm_model=$3,
         tokens_in=tokens_in+$4,
         tokens_out=tokens_out+$5,
         cost_usd=cost_usd+$6
       WHERE id=$1`,
      [
        taskId,
        JSON.stringify(ds),
        ds.verdict === 'ok' ? (ds.model || 'deepseek') : null,
        dsIn + refineIn,
        dsOut + refineOut,
        dsCost + refineCost,
      ],
    );
    await _setProgress(taskId, { stage: 'done', percent: 100, label: 'Готово' });
    console.log(`[Forecaster] task ${taskId} done (rows=${parsed.rowsCount}, months=${seriesData.monthly.length}, ds=${ds.verdict}, junk=${junkReport.counts.junk_count}, ds_junk=${junkRefine?.verdict || 'n/a'}, opp=${opportunitiesReport?.verdict || 'n/a'}, niche=${expertReports?.niche_strategist?.verdict || 'n/a'}, hunter=${expertReports?.opportunity_hunter?.verdict || 'n/a'}, planner=${expertReports?.cluster_planner?.verdict || 'n/a'})`);
    try { await funnel.finish({ status: 'completed' }); } catch (_e) { /* analytics must not break generation */ }
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    console.error(`[Forecaster] task ${taskId} failed: ${msg}`);
    await db.query(
      `UPDATE forecaster_tasks SET status='error', error_message=$2, completed_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [taskId, msg.slice(0, 2000)],
    );
    try { await funnel.finish({ status: 'failed', error: err }); } catch (_e) { /* no-op */ }
  }
}

module.exports = { processForecasterTask };
