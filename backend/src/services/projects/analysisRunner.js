'use strict';

/**
 * projects/analysisRunner.js — фоновое выполнение AI-аналитики проекта.
 *
 * Запускается контроллером без await (long-running, 30–60 c+). Собирает срез
 * данных GSC за выбранный период, вызывает DeepSeek («Senior SEO-аналитик»)
 * и сохраняет markdown-отчёт в строку project_analyses. Фронт поллит статус.
 */

const db = require('../../config/db');
const { fetchPerformanceSeries, fetchTopDimensions, resolveRange } = require('./gscService');
const { runProjectAnalysis } = require('./deepseekAnalyzer');

async function _setError(analysisId, message) {
  await db.query(
    `UPDATE project_analyses
        SET status = 'error', error_message = $2, completed_at = NOW()
      WHERE id = $1`,
    [analysisId, String(message || 'unknown').slice(0, 1000)],
  );
}

/**
 * @param {string} analysisId  id строки project_analyses (status='queued')
 */
async function processAnalysis(analysisId) {
  let project;
  let range;
  try {
    const { rows } = await db.query(
      `SELECT a.id, a.project_id, a.period_from, a.period_to, a.range_key,
              p.name, p.url, p.audience_description,
              p.gsc_connected, p.gsc_site_url, p.gsc_access_token_enc,
              p.gsc_refresh_token_enc, p.gsc_token_expiry
         FROM project_analyses a
         JOIN projects p ON p.id = a.project_id
        WHERE a.id = $1`,
      [analysisId],
    );
    if (rows.length === 0) return;
    const row = rows[0];
    project = {
      id: row.project_id,
      name: row.name,
      url: row.url,
      audience_description: row.audience_description,
      gsc_connected: row.gsc_connected,
      gsc_site_url: row.gsc_site_url,
      gsc_access_token_enc: row.gsc_access_token_enc,
      gsc_refresh_token_enc: row.gsc_refresh_token_enc,
      gsc_token_expiry: row.gsc_token_expiry,
    };
    range = (row.period_from && row.period_to)
      ? { from: _isoDate(row.period_from), to: _isoDate(row.period_to) }
      : { days: _daysForKey(row.range_key) };

    await db.query(
      `UPDATE project_analyses SET status = 'running', started_at = NOW() WHERE id = $1`,
      [analysisId],
    );

    const performance = await fetchPerformanceSeries(project, range);
    const top = await fetchTopDimensions(project, range);
    const resolved = resolveRange(range);

    const result = await runProjectAnalysis({
      project, range: resolved, performance, top,
    });

    if (result.verdict !== 'ok') {
      await _setError(analysisId, `DeepSeek ${result.verdict}: ${result.reason || ''}`);
      return;
    }

    const snapshot = {
      range: resolved,
      totals: performance.totals,
      series: performance.series,
      top_queries: top.topQueries,
      top_pages: top.topPages,
    };

    await db.query(
      `UPDATE project_analyses
          SET status = 'done',
              report_markdown = $2,
              gsc_snapshot = $3,
              llm_model = $4,
              tokens_in = $5,
              tokens_out = $6,
              cost_usd = $7,
              completed_at = NOW()
        WHERE id = $1`,
      [
        analysisId,
        result.markdown,
        JSON.stringify(snapshot),
        result.model,
        result.tokens_in,
        result.tokens_out,
        result.cost_usd,
      ],
    );
  } catch (err) {
    await _setError(analysisId, err.message).catch(() => {});
  }
}

function _isoDate(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  return dt.toISOString().slice(0, 10);
}

function _daysForKey(key) {
  switch (key) {
    case '7d': return 7;
    case '3m': return 90;
    case '6m': return 180;
    case '28d':
    default: return 28;
  }
}

module.exports = { processAnalysis };
