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
const { runDeepSeekAnalysis } = require('./deepseekAnalyzer');

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

    // 3. Агрегация
    const seriesData = aggregateMonthlySeries(parsed);
    if (seriesData.monthly.length < 3) {
      throw new Error('После агрегации меньше 3 месяцев данных — недостаточно для анализа');
    }

    // 4. Аномалии
    const anomalies = detectAnomalies(seriesData.monthly);

    // 5. Прогноз
    const forecast = buildForecast(seriesData.monthly);

    // 6. Трафик
    const currentTraffic = Number(options.current_traffic_per_month) || 0;
    const trafficEstimate = estimateTraffic({
      historicalMonthly: seriesData.monthly,
      forecastPoints:    forecast.points,
      currentTrafficPerMonth: currentTraffic,
    });

    // 7. Сохраняем «полу-готовое» состояние, чтобы UI мог показать
    // данные даже если DeepSeek потом упадёт.
    const sourceMeta = {
      phrase_col: parsed.phraseCol,
      total_col:  parsed.totalCol,
      month_cols: parsed.monthCols,
      warnings:   parsed.warnings,
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
      ],
    );

    // 8. DeepSeek — graceful
    const ds = await runDeepSeekAnalysis({
      sourceInfo: { filename, rowsCount: parsed.rowsCount },
      monthlySeries: seriesData.monthly,
      anomalies,
      forecast,
      trend: forecast.trend,
      trafficEstimate,
    });

    // 9. Финал
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
        ds.verdict === 'ok' ? (ds.tokens_in || 0) : 0,
        ds.verdict === 'ok' ? (ds.tokens_out || 0) : 0,
        ds.verdict === 'ok' ? (ds.cost_usd || 0) : 0,
      ],
    );
    console.log(`[Forecaster] task ${taskId} done (rows=${parsed.rowsCount}, months=${seriesData.monthly.length}, ds=${ds.verdict})`);
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
