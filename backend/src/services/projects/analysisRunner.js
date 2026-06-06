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
const { detectSeasonality } = require('./seasonalityDetector');
const { splitQueries: splitBrand } = require('./brandSplit');
const { getProjectsConfig } = require('./config');
const { onAnalysisDone } = require('./aegisBridge');
const { insertSnapshot } = require('./snapshotsRepo');
const { auditPages, regenerateMetaForPages } = require('./pageMetaAudit');
const { analyzeEat } = require('./eatAnalyzer');
const { auditSchema } = require('./schemaAuditor');
const { buildLinkStrategy } = require('./linkStrategy');
const { buildBlogPlan } = require('./contentGapPlanner');
const { buildGeoAeo } = require('./geoAeo');
const { analyzeTopPages } = require('./topPageInsights');
const { buildActionPlan } = require('./actionPlan');
const dspyClient = require('./dspyClient');
const { callDeepSeek } = require('../llm/deepseek.adapter');
const ydxService = require('./ydxService');
const { runYandexAnalysis } = require('./ydxAnalyzer');
const { buildRankingFactors } = require('./rankingFactors');
const { buildStrategyMap } = require('./strategyMap');
const { runSynthesis } = require('./synthesisAnalyzer');

/**
 * llmFn для donorTopicGenerator («Темы статей под анкоры»). Один батч-вызов
 * DeepSeek. Graceful: без ключа возвращает '' → генератор откатывается на
 * детерминированную обёртку.
 */
async function _donorTopicLlmFn(prompt, opts = {}) {
  if (!process.env.DEEPSEEK_API_KEY) return '';
  const cfg = getProjectsConfig().deepseek;
  const resp = await callDeepSeek('', String(prompt || ''), {
    temperature: opts.temperature != null ? opts.temperature : 0.6,
    maxTokens: opts.maxTokens || 4000,
    timeoutMs: opts.timeoutMs || 120000,
    model: cfg.model,
  });
  return (resp && resp.text) || '';
}

/**
 * Собирает «голую» выгрузку GSC за переданный диапазон + детерминированные
 * срезы (commercial, breakdowns, period_compare, page_decay, brand_split).
 * Используется и фоновым анализом (processAnalysis), и эндпоинтом
 * POST /:id/snapshots (сбор без LLM).
 *
 * @returns {Promise<{snapshot:object, payload:object}>} snapshot — то, что
 *   ляжет в project_snapshots.gsc_data; payload — расширенный объект для
 *   передачи в deepseekAnalyzer (содержит `project` и сырой queryPage).
 */
async function collectSnapshot(project, range) {
  const performance = await fetchPerformanceSeries(project, range);
  const top = await fetchTopDimensions(project, range);
  const resolved = resolveRange(range);

  const projectsCfg = getProjectsConfig();
  const commercialCfg = projectsCfg.commercial;
  const brandTokens = deriveBrandTokens({
    name: project.name, siteUrl: project.gsc_site_url, url: project.url,
  });
  let commercial = null;
  let queryPage = [];
  if (commercialCfg.enabled) {
    try {
      queryPage = await fetchQueryPageMatrix(project, range);
    } catch (_) { queryPage = []; }
    commercial = analyzeCommercial({
      topQueries: top.topQueries,
      topPages: top.topPages,
      queryPage,
      brandTokens,
    });
  }

  let serpVerification = null;
  const serpCfg = projectsCfg.serpVerification;
  if (serpCfg.enabled && commercial && Array.isArray(commercial.cannibalization)
    && commercial.cannibalization.length > 0) {
    try {
      serpVerification = await verifyCannibalization({
        candidates: commercial.cannibalization,
      });
    } catch (_) { serpVerification = null; }
  }

  const breakdowns = await _fetchBreakdowns(project, range, projectsCfg.gscBreakdowns);
  const periodCompare = await _buildPeriodCompare(project, range, top, projectsCfg.periodCompare, performance);
  const pageDecay = await _buildPageDecay(project, range, top.topPages, projectsCfg.pageDecay);
  const brandSplit = await _buildBrandSplit(project, range, projectsCfg.brandSplit, project.gsc_site_url);
  // Закономерности спада на дистанции в несколько месяцев (ТЗ п.4) — строим
  // из уже собранного дневного ряда totals, без дополнительных запросов.
  const seasonality = _buildSeasonality(performance.series, projectsCfg.seasonality);

  // --- Новые слои (п.1-8 ТЗ). Все graceful: ошибка → null, пайплайн не падает.
  // Порядок учитывает зависимости: linkAudit → eat(linkedUrls) → schema(eat) → geo(schema).
  const pageMetaAudit = await _buildPageMetaAudit(project, top, commercial, pageDecay, queryPage, projectsCfg.pageMetaAudit);
  const linkAudit = await _buildLinkStrategy(project, commercial, top, queryPage);
  const linkedUrls = linkAudit && linkAudit.audit && Array.isArray(linkAudit.audit._linked_urls)
    ? new Set(linkAudit.audit._linked_urls) : null;
  const eat = await _buildEat(project, top, linkedUrls, projectsCfg.eat);
  const schemaAudit = await _buildSchemaAudit(eat, project, projectsCfg.schemaAudit);
  const blogPlan = await _buildBlogPlan(project, top, queryPage, breakdowns, brandTokens, serpVerification);
  const geoAeo = await _buildGeoAeo(project, top, schemaAudit, breakdowns, brandTokens);
  const topPageInsights = await _buildTopPageInsights(project, top, queryPage);

  // _scans — транзиентные данные парсинга (hiddenLayers) для schema/geo, в
  // снапшот НЕ кладём (тяжёлый HTML), очищаем перед сохранением.
  const eatPersist = _stripScans(eat);
  const linkAuditPersist = _stripLinkedUrls(linkAudit);

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
    seasonality,
    page_meta_audit: pageMetaAudit,
    eat: eatPersist,
    schema_audit: schemaAudit,
    link_audit: linkAuditPersist,
    blog_plan: blogPlan,
    geo_aeo: geoAeo,
    top_page_insights: topPageInsights,
  };

  // ТЗ п.3 — «План действий»: связываем все срезы в конкретные, посчитанные
  // рекомендации (что→на что→зачем→эффект). Граничный шаг: добирает конкретные
  // мета-теги через мета-генератор + xmlstock + парсинг (graceful без ключей).
  const actionPlan = await _buildActionPlan(project, snapshot, queryPage);
  snapshot.action_plan = actionPlan;

  const payload = {
    project,
    range: resolved,
    performance,
    top,
    commercial,
    serpVerification,
    queryPage,
    breakdowns,
    periodCompare,
    pageDecay,
    brandSplit,
    seasonality,
    pageMetaAudit,
    eat: eatPersist,
    schemaAudit,
    linkAudit: linkAuditPersist,
    blogPlan,
    geoAeo,
    topPageInsights,
    actionPlan,
  };

  return { snapshot, payload };
}

/**
 * Собирает снапшот Яндекс.Вебмастера за тот же период (раздельный анализ).
 * Данные Webmaster API беднее GSC: тоталы, посуточная динамика, топ-запросы и
 * бренд-сплит. Полностью graceful: при любой ошибке/отсутствии подключения
 * возвращает null — пайплайн продолжает работать только по Google.
 *
 * @returns {Promise<{snapshot:object, payload:object}|null>}
 */
async function collectYdxSnapshot(project, range) {
  const acfg = getProjectsConfig().analyzer;
  if (!acfg || !acfg.yandex || !acfg.yandex.enabled) return null;
  if (!project.ydx_connected || !project.ydx_site_url) return null;
  try {
    const performance = await ydxService.fetchPerformanceSeries(project, range);
    let topQueries = [];
    try {
      topQueries = await ydxService.fetchTopQueries(project, range);
    } catch (_) { topQueries = []; }

    let brandSplit = null;
    try {
      const brandTokens = deriveBrandTokens({
        name: project.name, siteUrl: project.ydx_site_url, url: project.url,
      });
      brandSplit = splitBrand(topQueries, brandTokens);
    } catch (_) { brandSplit = null; }

    const snapshot = {
      source: 'yandex',
      range: performance.range,
      totals: performance.totals,
      series: performance.series,
      top_queries: topQueries,
      brand_split: brandSplit,
    };
    const payload = {
      project,
      range: performance.range,
      performance,
      topQueries,
      brandSplit,
    };
    return { snapshot, payload };
  } catch (e) {
    console.warn('[projects/analysisRunner] ydx snapshot failed:', e.message);
    return null;
  }
}

/** Удаляет транзиентные _scans из eat-результата перед персистом. */
function _stripScans(eat) {
  if (!eat || typeof eat !== 'object') return eat;
  const { _scans, ...rest } = eat;
  return rest;
}

/** Удаляет тяжёлый список _linked_urls из link-аудита перед персистом. */
function _stripLinkedUrls(linkAudit) {
  if (!linkAudit || typeof linkAudit !== 'object' || !linkAudit.audit) return linkAudit;
  const { _linked_urls, ...auditRest } = linkAudit.audit;
  return { ...linkAudit, audit: auditRest };
}

/** Постраничный аудит метатегов (п.4). */
async function _buildPageMetaAudit(project, top, commercial, pageDecay, queryPage, cfg) {
  if (!cfg || !cfg.enabled) return null;
  try {
    const snapshotLike = { commercial, page_decay: pageDecay, top_pages: top.topPages };
    return await auditPages({ project, snapshot: snapshotLike, queryPage });
  } catch (_) { return null; }
}

/** E-E-A-T по шаблонам страниц (п.5). */
async function _buildEat(project, top, linkedUrls, cfg) {
  if (!cfg || !cfg.enabled) return null;
  try {
    return await analyzeEat({ project, snapshot: { top_pages: top.topPages }, linkedUrls });
  } catch (_) { return null; }
}

/** Аудит микроразметки (п.8) — поверх результата парсинга из _buildEat. */
async function _buildSchemaAudit(eat, project, cfg) {
  if (!cfg || !cfg.enabled) return null;
  try {
    return auditSchema({ eatResult: eat, project });
  } catch (_) { return null; }
}

/** Ссылочная стратегия + аудит ссылок (п.1, п.2). */
async function _buildLinkStrategy(project, commercial, top, queryPage) {
  try {
    return await buildLinkStrategy({
      project, commercial, topPages: top.topPages, queryPage, db, llmFn: _donorTopicLlmFn,
    });
  } catch (_) { return null; }
}

/** План публикаций в блог (п.3). */
async function _buildBlogPlan(project, top, queryPage, breakdowns, brandTokens, serpVerification) {
  try {
    return await buildBlogPlan({
      project,
      topQueries: top.topQueries,
      queryPage,
      breakdowns,
      brandTokens,
      serpVerification,
      dspyClient,
    });
  } catch (_) { return null; }
}

/** GEO/AEO — нейровыдача (п.7). Probe внутри пайплайна выключен (лимиты ключа). */
async function _buildGeoAeo(project, top, schemaAudit, breakdowns, brandTokens) {
  try {
    return await buildGeoAeo({
      project,
      topQueries: top.topQueries,
      schemaAudit,
      breakdowns,
      brandTokens,
      runProbe: false,
    });
  } catch (_) { return null; }
}

/** Реверс-инжиниринг топовых страниц (п.3) — почему в топе + рекомендации. */
async function _buildTopPageInsights(project, top, queryPage) {
  try {
    return await analyzeTopPages({
      project,
      snapshot: { top_pages: top.topPages },
      queryPage,
    });
  } catch (_) { return null; }
}

/**
 * «План действий» (ТЗ п.3): связывает собранные срезы в конкретные посчитанные
 * рекомендации. metaFn = regenerateMetaForPages — конкретные мета-теги через
 * мета-генератор + xmlstock + парсинг. Graceful: ошибка → null.
 */
async function _buildActionPlan(project, snapshot, queryPage) {
  try {
    return await buildActionPlan({
      project, snapshot, queryPage, metaFn: regenerateMetaForPages,
    });
  } catch (_) { return null; }
}

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
              p.gsc_refresh_token_enc, p.gsc_token_expiry,
              p.ydx_connected, p.ydx_site_url, p.ydx_access_token_enc,
              p.ydx_refresh_token_enc, p.ydx_token_expiry, p.ydx_available_sites
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
      ydx_connected: row.ydx_connected,
      ydx_site_url: row.ydx_site_url,
      ydx_access_token_enc: row.ydx_access_token_enc,
      ydx_refresh_token_enc: row.ydx_refresh_token_enc,
      ydx_token_expiry: row.ydx_token_expiry,
      ydx_available_sites: row.ydx_available_sites,
    };
    range = (row.period_from && row.period_to)
      ? { from: _isoDate(row.period_from), to: _isoDate(row.period_to) }
      : { days: _daysForKey(row.range_key) };

    await db.query(
      `UPDATE project_analyses SET status = 'running', started_at = NOW() WHERE id = $1`,
      [analysisId],
    );

    // Загружаем user_id один раз — потребуется и для project_snapshots,
    // и для aegis-петли в конце.
    const { rows: uRows } = await db.query(
      `SELECT user_id FROM projects WHERE id = $1`, [project.id],
    ).catch(() => ({ rows: [] }));
    const userId = uRows[0] && uRows[0].user_id || null;

    // Сбор «голой» выгрузки GSC + все детерминированные срезы.
    const { snapshot, payload } = await collectSnapshot(project, range);

    // Сразу сохраняем снимок как отдельную строку — он остаётся даже если
    // LLM-вызов ниже упадёт. PR 1 «снимки как first-class сущность».
    let snapshotId = null;
    if (userId) {
      try {
        const ins = await insertSnapshot({
          projectId: project.id,
          userId,
          rangeKey: row.range_key || null,
          periodFrom: snapshot.range.startDate,
          periodTo: snapshot.range.endDate,
          source: 'analysis',
          gscData: snapshot,
        });
        snapshotId = ins.id;
        await db.query(
          `UPDATE project_analyses SET snapshot_id = $2 WHERE id = $1`,
          [analysisId, snapshotId],
        );
      } catch (e) {
        // best-effort: при сбое продолжаем без snapshot_id (старое поведение).
        console.warn('[projects/analysisRunner] snapshot persist failed:', e.message);
      }
    }

    const batchCfg = getProjectsConfig().batch;
    const workload = estimateWorkload({
      topQueries: payload.top.topQueries,
      topPages: payload.top.topPages,
      queryPage: payload.queryPage,
    });
    const useBatch = shouldBatch(workload, batchCfg);

    const result = useBatch
      ? await runProjectAnalysisBatched(payload)
      : await runProjectAnalysis(payload);

    if (result.verdict !== 'ok') {
      await _setError(analysisId, `Анализатор ${result.verdict}: ${result.reason || ''}`);
      return;
    }

    // ── Раздельный анализ Яндекса + сводка закономерностей + ranking-gaps ──
    // Всё graceful: сбой любого из проходов не валит основной (Google) отчёт.
    let ydxSnapshot = null;
    let ydxPayload = null;
    let ydxReport = null;
    try {
      const ydx = await collectYdxSnapshot(project, range);
      if (ydx) { ydxSnapshot = ydx.snapshot; ydxPayload = ydx.payload; }
    } catch (e) {
      console.warn('[projects/analysisRunner] ydx collect failed:', e.message);
    }
    if (ydxPayload) {
      try {
        const yr = await runYandexAnalysis(ydxPayload);
        if (yr && yr.verdict === 'ok') ydxReport = yr.markdown;
      } catch (e) {
        console.warn('[projects/analysisRunner] ydx analysis failed:', e.message);
      }
    }

    // Детерминированный аудит факторов ранжирования (что мешает росту).
    let rankingFactors = null;
    try { rankingFactors = buildRankingFactors(snapshot, ydxSnapshot); } catch (_) { rankingFactors = null; }

    // Визуальная схема стратегии (ТЗ п.5) — строим из факторов ранжирования и
    // кладём в снапшот, чтобы и кабинет, и публичный отчёт рисовали её одинаково.
    try { snapshot.strategy_map = buildStrategyMap(rankingFactors); } catch (_) { snapshot.strategy_map = null; }

    // Финальная сводка закономерностей Google ↔ Яндекс + подсветка пробелов.
    let synthesisMarkdown = null;
    const synthCfg = getProjectsConfig().analyzer;
    if (synthCfg && synthCfg.synthesis && synthCfg.synthesis.enabled) {
      try {
        const syn = await runSynthesis({
          project,
          gscReport: result.markdown,
          ydxReport,
          gscPerformance: payload.performance,
          ydxPerformance: ydxPayload ? ydxPayload.performance : null,
          rankingFactors,
        });
        if (syn && (syn.markdown || syn.verdict === 'ok')) synthesisMarkdown = syn.markdown || null;
      } catch (e) {
        console.warn('[projects/analysisRunner] synthesis failed:', e.message);
      }
    }

    await db.query(
      `UPDATE project_analyses
          SET status = 'done',
              report_markdown = $2,
              gsc_snapshot = $3,
              llm_model = $4,
              tokens_in = $5,
              tokens_out = $6,
              cost_usd = $7,
              ydx_snapshot = $8,
              ydx_report_markdown = $9,
              synthesis_markdown = $10,
              ranking_factors = $11,
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
        ydxSnapshot ? JSON.stringify(ydxSnapshot) : null,
        ydxReport,
        synthesisMarkdown,
        rankingFactors ? JSON.stringify(rankingFactors) : null,
      ],
    );

    // Aegis-петля (best-effort): seoBrain snapshot + training example +
    // biobrain feedback. Любая ошибка — warn и продолжаем.
    try {
      await onAnalysisDone(db, {
        analysisId,
        project: { ...project, user_id: userId },
        snapshot,
        result,
      });
    } catch (e) {
      console.warn('[projects/analysisRunner] aegis hook failed:', e.message);
    }
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
 * Сезонность/закономерности спада (ТЗ п.4) — детерминированно из дневного ряда.
 * Graceful: при сбое или коротком ряде возвращает null/неактивный объект.
 */
function _buildSeasonality(series, cfg) {
  if (!cfg || !cfg.enabled) return null;
  try {
    return detectSeasonality(series, cfg);
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

module.exports = { processAnalysis, collectSnapshot, collectYdxSnapshot };
