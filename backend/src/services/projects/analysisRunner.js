'use strict';

/**
 * projects/analysisRunner.js — фоновое выполнение AI-аналитики проекта.
 *
 * Запускается контроллером без await (long-running, 30–60 c+). Собирает срез
 * данных GSC за выбранный период, вызывает DeepSeek («Senior SEO-аналитик»)
 * и сохраняет markdown-отчёт в строку project_analyses. Фронт поллит статус.
 */

const db = require('../../config/db');
const {
  fetchPerformanceSeries, fetchTopDimensions, fetchQueryPageMatrix, resolveRange,
  fetchBreakdown, fetchPageDailySeries, fetchTopQueries, previousRange,
} = require('./gscService');
const { runProjectAnalysis, runProjectAnalysisBatched, estimateWorkload, shouldBatch } = require('./deepseekAnalyzer');
const { analyzeCommercial, deriveBrandTokens } = require('./commercialIntent');
const { verifyCannibalization } = require('./serpVerifier');
const { buildPeriodReport } = require('./periodComparison');
const { detectPageDecay } = require('./pageDecayDetector');
const { splitQueries: splitBrand } = require('./brandSplit');
const { getProjectsConfig } = require('./config');

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

    // Коммерческий срез (детерминированный, без LLM). Доп. запрос query×page
    // — graceful: при ошибке/выключенном флаге каннибализация просто пустая.
    const commercialCfg = getProjectsConfig().commercial;
    let commercial = null;
    let queryPage = [];
    if (commercialCfg.enabled) {
      try {
        queryPage = await fetchQueryPageMatrix(project, range);
      } catch (_) { queryPage = []; }
      const brandTokens = deriveBrandTokens({
        name: project.name, siteUrl: project.gsc_site_url, url: project.url,
      });
      commercial = analyzeCommercial({
        topQueries: top.topQueries,
        topPages: top.topPages,
        queryPage,
        brandTokens,
      });
    }

    // Верификация каннибализации по реальной топ-выдаче Google (graceful):
    // прежде чем LLM порекомендует слияние разделов, сверяем кейсы с выдачей.
    let serpVerification = null;
    const serpCfg = getProjectsConfig().serpVerification;
    if (serpCfg.enabled && commercial && Array.isArray(commercial.cannibalization)
      && commercial.cannibalization.length > 0) {
      try {
        serpVerification = await verifyCannibalization({
          candidates: commercial.cannibalization,
        });
      } catch (_) { serpVerification = null; }
    }

    // Большие наборы данных обрабатываем порционно (map-reduce), затем сводим
    // общий пул выводов и гипотез в единый отчёт.
    const batchCfg = getProjectsConfig().batch;
    const workload = estimateWorkload({
      topQueries: top.topQueries, topPages: top.topPages, queryPage,
    });
    const useBatch = shouldBatch(workload, batchCfg);

    // ── Расширенные срезы и аналитические слои (graceful) ─────────────
    const projectsCfg = getProjectsConfig();
    const breakdowns = await _fetchBreakdowns(project, range, projectsCfg.gscBreakdowns);
    const periodCompare = await _buildPeriodCompare(project, range, top, projectsCfg.periodCompare, performance);
    const pageDecay = await _buildPageDecay(project, range, top.topPages, projectsCfg.pageDecay);
    const brandSplit = await _buildBrandSplit(project, range, projectsCfg.brandSplit, project.gsc_site_url);

    const analysisPayload = {
      project, range: resolved, performance, top, commercial,
      serpVerification, queryPage,
      breakdowns, periodCompare, pageDecay, brandSplit,
    };
    const result = useBatch
      ? await runProjectAnalysisBatched(analysisPayload)
      : await runProjectAnalysis(analysisPayload);

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
      commercial,
      serp_verification: serpVerification,
      breakdowns,
      period_compare: periodCompare,
      page_decay: pageDecay,
      brand_split: brandSplit,
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

/**
 * Доп. срезы GSC (device / country / searchAppearance). Каждый — graceful:
 * при ошибке/выключенном флаге отдаёт null, остальной анализ продолжается.
 */
async function _fetchBreakdowns(project, range, cfg) {
  if (!cfg || !cfg.enabled) return null;
  const out = {};
  const tasks = [];
  if (cfg.device && cfg.device.enabled) {
    tasks.push(fetchBreakdown(project, range, 'device', { rowLimit: cfg.device.rowLimit })
      .then((r) => { out.device = r; }).catch(() => { out.device = []; }));
  }
  if (cfg.country && cfg.country.enabled) {
    tasks.push(fetchBreakdown(project, range, 'country', { rowLimit: cfg.country.rowLimit })
      .then((r) => { out.country = r; }).catch(() => { out.country = []; }));
  }
  if (cfg.searchAppearance && cfg.searchAppearance.enabled) {
    tasks.push(fetchBreakdown(project, range, 'searchAppearance', { rowLimit: cfg.searchAppearance.rowLimit })
      .then((r) => { out.searchAppearance = r; }).catch(() => { out.searchAppearance = []; }));
  }
  await Promise.all(tasks);
  return out;
}

/**
 * Сравнение период-к-периоду: тащим тоталы и топ-запросы/страницы за
 * предыдущий равный период и считаем дельты + декомпозицию Δclicks.
 * Graceful: при сбое или слишком коротком периоде возвращает null.
 */
async function _buildPeriodCompare(project, range, currTop, cfg, currPerformance) {
  if (!cfg || !cfg.enabled) return null;
  const prev = previousRange(range);
  if (prev.days < (cfg.minDays || 5)) return { available: false, reason: 'period_too_short' };
  try {
    const [prevPerf, prevQueries, prevPages] = await Promise.all([
      fetchPerformanceSeries(project, prev),
      fetchTopQueries(project, prev, { rowLimit: Math.max(cfg.topQueriesDelta * 2, 50) }),
      fetchBreakdown(project, prev, 'page', { rowLimit: Math.max(cfg.topPagesDelta * 2, 30) })
        .catch(() => []), // page как dimension в общем разрезе.
    ]);
    return buildPeriodReport({
      currTotals: currPerformance.totals,
      prevTotals: prevPerf.totals,
      currQueries: currTop.topQueries,
      prevQueries,
      currPages: currTop.topPages,
      prevPages,
      opts: {
        minImpressions: cfg.minImpressions,
        minClicksAbsDelta: cfg.minClicksAbsDelta,
        topQueriesDelta: cfg.topQueriesDelta,
        topPagesDelta: cfg.topPagesDelta,
      },
    });
  } catch (_) {
    return null;
  }
}

/**
 * Page-decay detector: тащим page×date по топ-N страницам и прогоняем
 * через линейную регрессию. Graceful: при сбое возвращает null.
 */
async function _buildPageDecay(project, range, topPages, cfg) {
  if (!cfg || !cfg.enabled) return null;
  const pages = (topPages || []).slice(0, cfg.topPages).map((p) => p.key).filter(Boolean);
  if (pages.length === 0) return null;
  try {
    const rows = await fetchPageDailySeries(project, range, pages);
    return detectPageDecay(rows, cfg);
  } catch (_) {
    return null;
  }
}

/**
 * Brand-split: тащим большой срез по запросам и считаем долю бренда.
 * Graceful: при сбое — null.
 */
async function _buildBrandSplit(project, range, cfg, siteUrl) {
  if (!cfg || !cfg.enabled) return null;
  try {
    const queries = await fetchTopQueries(project, range, { rowLimit: cfg.queryRowLimit });
    const brandTokens = deriveBrandTokens({ name: project.name, siteUrl, url: project.url });
    return splitBrand(queries, brandTokens);
  } catch (_) {
    return null;
  }
}

module.exports = { processAnalysis };
