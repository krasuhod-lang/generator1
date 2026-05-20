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
const { runDeepSeekAnalysis, runDeepSeekJunkRefine } = require('./deepseekAnalyzer');
const { classifyJunkPhrases, REASON_LABELS } = require('./junkClassifier');
const { fetchPhraseSignals, aggregateSignals } = require('./keyssoClient');
const { getForecasterConfig } = require('./config');

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
  const filename = task.source_filename || '';

  await db.query(
    `UPDATE forecaster_tasks SET status='running', started_at=NOW(), updated_at=NOW() WHERE id=$1`,
    [taskId],
  );

  try {
    // 2. Парсер
    let parsed;
    if (Array.isArray(rawTable)) {
      parsed = parseForecasterInput({ rows: rawTable }, { filename });
    } else if (typeof rawCsv === 'string' && rawCsv.length > 0) {
      parsed = parseForecasterInput(rawCsv, { filename });
    } else {
      throw new Error('Файл не передан или пустой');
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
    const junkRaw = classifyJunkPhrases({
      parsedRows: parsed.rows,
      monthCols:  parsed.monthCols,
      targetUrl,
    });
    const excludeSet = new Set();
    for (const f of junkRaw.flagged) {
      if (f.exclude_from_forecast) {
        excludeSet.add(String(f.phrase || '').trim().toLowerCase().replace(/\s+/g, ' '));
      }
    }

    // 4. Агрегация (с учётом исключённых фраз)
    const seriesData = aggregateMonthlySeries(parsed, { excludePhrases: excludeSet });
    if (seriesData.monthly.length < 3) {
      throw new Error('После агрегации меньше 3 месяцев данных — недостаточно для анализа');
    }

    // 5. Аномалии
    const anomalies = detectAnomalies(seriesData.monthly);

    // 6. Прогноз
    const forecast = buildForecast(seriesData.monthly);

    // 6b. Keys.so signals (graceful skip без ключа). Шлём top-N фраз по total
    // (после фильтрации исключённых) — чтобы экономить квоту.
    let keyssoSignalsReport = null;
    try {
      const remainingRows = parsed.rows.filter((r) => {
        const norm = String(r.phrase || '').trim().toLowerCase().replace(/\s+/g, ' ');
        return norm && !excludeSet.has(norm);
      });
      const topPhrases = [...remainingRows]
        .sort((a, b) => Number(b.total || 0) - Number(a.total || 0))
        .map((r) => String(r.phrase || '').trim())
        .filter(Boolean);

      const ksResp = await fetchPhraseSignals({
        phrases: topPhrases,
        domain:  targetUrl,
        region:  options.region,
      });
      if (ksResp.verdict === 'ok') {
        const agg = aggregateSignals(ksResp.signals, ksResp.requested);
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

    // 7. Трафик (с калибровкой по keys.so, если есть)
    const trafficEstimate = estimateTraffic({
      historicalMonthly: seriesData.monthly,
      forecastPoints:    forecast.points,
      currentTrafficPerMonth: currentTraffic,
      keyssoAggregate:   keyssoSignalsReport?.verdict === 'ok' ? keyssoSignalsReport.aggregate : null,
    });

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
    const sourceMeta = {
      phrase_col: parsed.phraseCol,
      total_col:  parsed.totalCol,
      month_cols: parsed.monthCols,
      warnings:   parsed.warnings,
      target_url: targetUrl,
    };
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
      ],
    );

    // 8. DeepSeek — graceful (анализ + junk refinement)
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

    // 9. Финал
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
    console.log(`[Forecaster] task ${taskId} done (rows=${parsed.rowsCount}, months=${seriesData.monthly.length}, ds=${ds.verdict}, junk=${junkReport.counts.junk_count}, ds_junk=${junkRefine?.verdict || 'n/a'})`);
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    console.error(`[Forecaster] task ${taskId} failed: ${msg}`);
    await db.query(
      `UPDATE forecaster_tasks SET status='error', error_message=$2, completed_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [taskId, msg.slice(0, 2000)],
    );
  }
}

module.exports = { processForecasterTask };
