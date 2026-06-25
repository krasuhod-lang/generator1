'use strict';

const db = require('../../config/db');
const gscService = require('../projects/gscService');
const ydxService = require('../projects/ydxService');
const { loadCachedSeries, loadCurrent, syncDomain } = require('./keysSoSync');
const tasksLog = require('./tasksAutoLog');
const { forecastMetric } = require('./forecastEngine');
const positionAnalytics = require('../positionTracker/analytics');
const { buildModulesForProject } = require('./reportModulesService');
const { sanitizeData } = require('./viewModeSanitizer');
const freshnessService = require('../projects/freshnessService');
const { buildHeadline } = require('./headlineBuilder');
const { splitSeriesIntoMonths } = require('../projects/periodResolver');
const { applyOverrides } = require('./overridesApplier');
const { classifyQuery, deriveBrandTokens } = require('../projects/commercialIntent');
const { classifyUrl } = require('./urlClassifier');

/**
 * Метаданные временных рядов для UI/KPI.
 *
 * Графики в отчётах **должны** рисовать всю серию, включая текущий неполный
 * месяц (чтобы клиент видел актуальную динамику), но любые KPI/% роста
 * считаются ТОЛЬКО по полным месяцам — иначе сравнение «23 дня апреля vs
 * полный март» даёт ложные минусы (ТЗ §2-3).
 *
 * `series_meta` отдаётся в payload вместе с series:
 *   {
 *     monthly_periods:     [{ key, from, to, is_complete, is_partial, days,
 *                             clicks, impressions, ctr, position }],
 *     last_period_partial: boolean,   // последний месяц в окне неполный
 *     last_complete_month: 'YYYY-MM', // для подписи «за полные месяцы: …»
 *     complete_months:     number,    // сколько полных месяцев в окне
 *   }
 *
 * `totals_complete` / `prev_totals_complete` — агрегаты строго по полным
 * месяцам. KPI/дельты на фронте читают именно их (а series_meta используется
 * для визуального маркера неполной точки графика).
 */
function _seriesMeta(rawSeries) {
  const monthly = splitSeriesIntoMonths(rawSeries || []);
  const completes = monthly.filter((m) => m.is_complete);
  const last = monthly.length ? monthly[monthly.length - 1] : null;
  return {
    monthly_periods: monthly,
    last_period_partial: last ? !!last.is_partial : false,
    last_complete_month: completes.length ? completes[completes.length - 1].key : null,
    complete_months: completes.length,
  };
}

function _totalsFromMonths(months) {
  if (!Array.isArray(months) || !months.length) return null;
  let clicks = 0, impressions = 0, posSum = 0, posDays = 0;
  for (const m of months) {
    clicks += Number(m.clicks) || 0;
    impressions += Number(m.impressions) || 0;
    if (m.position && m.days) { posSum += m.position * m.days; posDays += m.days; }
  }
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? Math.round((clicks / impressions) * 10000) / 100 : 0,
    position: posDays > 0 ? Math.round((posSum / posDays) * 100) / 100 : null,
    months_count: months.length,
  };
}

/**
 * Считает totals_complete (полные месяцы из окна) и prev_totals_complete
 * (предыдущие N полных месяцев перед окном, той же длины) на основе
 * helper-сервиса (ydx/gsc/projects). Если данных меньше двух полных месяцев
 * (или предыдущие месяцы недоступны) — возвращает только totals_complete.
 *
 * П.1: prev-окно зависит только от запрошенного [from..to], поэтому prev-fetch
 * можно стартовать параллельно с основным; вызывающий код передаёт уже
 * готовый Promise через `prevSeriesPromise`. Для обратной совместимости
 * поддерживается старый сигнатуру `_completePeriodTotals(rawSeries, fetcher)`
 * (fetcher вызывается лениво, последовательно — это деградация).
 */
async function _completePeriodTotals(rawSeries, fetcherOrPromise) {
  const meta = _seriesMeta(rawSeries);
  const completes = meta.monthly_periods.filter((m) => m.is_complete);
  if (!completes.length) {
    return { totals_complete: null, prev_totals_complete: null, meta };
  }
  const totals_complete = _totalsFromMonths(completes);
  let prev_totals_complete = null;

  // Сценарий 1: prev-серия уже запущена параллельно — просто ждём её и
  // используем как есть (без второго fetcher).
  if (fetcherOrPromise && typeof fetcherOrPromise.then === 'function') {
    try {
      const prevRaw = await fetcherOrPromise;
      if (Array.isArray(prevRaw) && prevRaw.length) {
        const prevMonths = splitSeriesIntoMonths(prevRaw).filter((m) => m.is_complete);
        prev_totals_complete = _totalsFromMonths(prevMonths) || null;
      }
    } catch (err) {
      console.warn('[reports][periods] prev totals failed:', err.message);
    }
    return { totals_complete, prev_totals_complete, meta };
  }

  // Сценарий 2: legacy — ленивый fetcher (для тестов и точечных вызовов).
  if (typeof fetcherOrPromise === 'function') {
    try {
      const firstMonth = completes[0];
      // Окно для prev: ровно N месяцев, заканчивающихся за день до начала
      // первого полного месяца текущего окна.
      const n = completes.length;
      const prevTo = new Date(`${firstMonth.from}T00:00:00Z`);
      prevTo.setUTCDate(prevTo.getUTCDate() - 1);
      const prevFrom = new Date(prevTo);
      prevFrom.setUTCMonth(prevFrom.getUTCMonth() - (n - 1));
      prevFrom.setUTCDate(1);
      const fmt = (d) => d.toISOString().slice(0, 10);
      const prevRaw = await fetcherOrPromise(fmt(prevFrom), fmt(prevTo));
      if (Array.isArray(prevRaw) && prevRaw.length) {
        const prevMonths = splitSeriesIntoMonths(prevRaw).filter((m) => m.is_complete);
        prev_totals_complete = _totalsFromMonths(prevMonths) || null;
      }
    } catch (err) {
      // Не критично — без prev_totals_complete KPI всё равно покажет totals.
      console.warn('[reports][periods] prev totals failed:', err.message);
    }
  }
  return { totals_complete, prev_totals_complete, meta };
}

/**
 * Окно [from..to] → окно той же длины (в месяцах), оканчивающееся за день
 * до from. Используется для параллельного prev-fetch без ожидания основной
 * серии (см. П.1).
 */
function _prevWindowOf(from, to) {
  try {
    const f = new Date(`${from}T00:00:00Z`);
    const t = new Date(`${to}T00:00:00Z`);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) return null;
    const months = Math.max(1,
      (t.getUTCFullYear() - f.getUTCFullYear()) * 12 + (t.getUTCMonth() - f.getUTCMonth()) + 1);
    const prevTo = new Date(f);
    prevTo.setUTCDate(prevTo.getUTCDate() - 1);
    const prevFrom = new Date(prevTo);
    prevFrom.setUTCMonth(prevFrom.getUTCMonth() - (months - 1));
    prevFrom.setUTCDate(1);
    const fmt = (d) => d.toISOString().slice(0, 10);
    return { from: fmt(prevFrom), to: fmt(prevTo) };
  } catch (_) { return null; }
}

function _isoDate(value) {
  if (value == null) return '';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function _granularity(input) {
  const g = String(input || 'month').toLowerCase();
  return ['day', 'week', 'month'].includes(g) ? g : 'month';
}

function _bucketOf(dateStr, granularity) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(dateStr || '');
  const [, y, mo, d] = m;
  if (granularity === 'month') return `${y}-${mo}-01`;
  if (granularity === 'week') {
    const dt = new Date(Date.UTC(+y, +mo - 1, +d));
    const offset = (dt.getUTCDay() + 6) % 7;
    dt.setUTCDate(dt.getUTCDate() - offset);
    return dt.toISOString().slice(0, 10);
  }
  return `${y}-${mo}-${d}`;
}

function _periodWindow(from, to) {
  const fromMs = new Date(`${from}T00:00:00Z`).getTime();
  const toMs = new Date(`${to}T00:00:00Z`).getTime();
  const days = Math.max(1, Math.round((toMs - fromMs) / 86400_000) + 1);
  return { days, period: days > 14 ? 'month' : 'week' };
}

function _aggregateSeries(series, granularity, valueKeys = ['clicks', 'impressions']) {
  const buckets = new Map();
  for (const row of series || []) {
    const date = String(row.date || '').slice(0, 10);
    if (!date) continue;
    const bucket = _bucketOf(date, granularity);
    if (!buckets.has(bucket)) {
      const init = { date: bucket, _posSum: 0, _posWeight: 0 };
      for (const key of valueKeys) init[key] = 0;
      buckets.set(bucket, init);
    }
    const item = buckets.get(bucket);
    for (const key of valueKeys) {
      if (typeof row[key] === 'number') item[key] += row[key];
    }
    if (typeof row.position === 'number' && row.position > 0) {
      const weight = Number(row.impressions) || 1;
      item._posSum += row.position * weight;
      item._posWeight += weight;
    }
  }
  return Array.from(buckets.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((item) => {
      const out = { date: item.date };
      for (const key of valueKeys) out[key] = item[key];
      out.ctr = item.impressions > 0 ? Math.round((item.clicks / item.impressions) * 10000) / 100 : 0;
      out.position = item._posWeight > 0 ? Math.round((item._posSum / item._posWeight) * 100) / 100 : null;
      return out;
    });
}

/**
 * Lightweight month-bucket aggregator kept for tests/integrations that need a
 * simple monthly roll-up without specifying a granularity. Sums the requested
 * value keys, derives a weighted CTR from clicks/impressions when present and
 * uses an arithmetic-mean position so callers don't have to provide weights.
 */
function _aggregateByMonth(series, valueKeys = ['clicks', 'impressions']) {
  const buckets = new Map();
  for (const row of Array.isArray(series) ? series : []) {
    const date = String(row && row.date ? row.date : '').slice(0, 10);
    if (!date) continue;
    const bucket = _bucketOf(date, 'month');
    if (!buckets.has(bucket)) {
      const init = { date: bucket, _posSum: 0, _posCount: 0 };
      for (const key of valueKeys) init[key] = 0;
      buckets.set(bucket, init);
    }
    const item = buckets.get(bucket);
    for (const key of valueKeys) {
      if (typeof row[key] === 'number') item[key] += row[key];
    }
    if (typeof row.position === 'number' && row.position > 0) {
      item._posSum += row.position;
      item._posCount += 1;
    }
  }
  return Array.from(buckets.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((item) => {
      const out = { date: item.date };
      for (const key of valueKeys) out[key] = item[key];
      const clicks = Number(item.clicks) || 0;
      const impressions = Number(item.impressions) || 0;
      out.ctr = impressions > 0 ? Math.round((clicks / impressions) * 10000) / 100 : 0;
      out.position = item._posCount > 0 ? Math.round((item._posSum / item._posCount) * 100) / 100 : null;
      return out;
    });
}

function _annotationFromTask(item, granularity) {
  const date = _isoDate(item.performed_at);
  return {
    date,
    bucket: _bucketOf(date, granularity),
    label: String(item.title || '').slice(0, 48),
    type: item.task_type || 'other',
  };
}

function _taskSectionLabel(taskType) {
  return ({
    content_generation: 'Контент',
    meta_update: 'Мета-теги',
    link_article: 'Ссылки',
    technical_seo: 'Технические работы',
    other: 'Прочее',
  })[taskType] || 'Прочее';
}

function _groupTasks(items, manualBlocks) {
  if (Array.isArray(manualBlocks) && manualBlocks.length) return manualBlocks;
  const months = new Map();
  for (const item of items || []) {
    const date = _isoDate(item.performed_at);
    const month = date.slice(0, 7) || 'Без месяца';
    if (!months.has(month)) months.set(month, []);
    const sections = months.get(month);
    const title = _taskSectionLabel(item.task_type);
    let section = sections.find((s) => s.title === title);
    if (!section) {
      section = { title, tasks: [] };
      sections.push(section);
    }
    section.tasks.push({
      title: item.title || '',
      description_html: item.description || '',
      link: item.ref_id ? String(item.ref_id) : '',
      date,
      source: item.source || 'manual',
    });
  }
  return Array.from(months.entries()).map(([month, sections]) => ({ month, sections }));
}

function _buildTrafficValue(keysSo, gsc, ywm) {
  const adcost = Number(keysSo?.current?.adcost ?? keysSo?.series?.[keysSo?.series?.length - 1]?.adcost);
  if (!Number.isFinite(adcost) || adcost <= 0) return null;
  const clicks = Number(gsc?.totals?.clicks || 0) + Number(ywm?.totals?.clicks || 0);
  return {
    adcost: Math.round(adcost * 100) / 100,
    estimated_savings: Math.round(adcost),
    clicks,
    label: `Если бы вы покупали этот трафик в Директе, вы бы потратили около ${Math.round(adcost).toLocaleString('ru-RU')} ₽`,
  };
}

async function _gscSection(project, from, to, granularity, freshnessMap) {
  const last_sync_at = freshnessMap?.gsc?.last_successful_sync_at || null;
  if (!project.gsc_connected || !project.gsc_site_url) {
    return { connected: false, status: 'empty', reason: 'not_connected', series: [], totals: null, totals_complete: null, prev_totals_complete: null, series_meta: null, last_sync_at };
  }
  try {
    // П.1: prev-окно зависит только от запрошенного [from..to], поэтому
    // стартуем prev-fetch параллельно с основной серией. Раньше эти запросы
    // шли последовательно (главный fetch → completePeriodTotals → второй
    // fetch), что удваивало латентность GSC под фронт-таймаут.
    const prevWindow = _prevWindowOf(from, to);
    const prevPromise = prevWindow
      ? gscService.fetchPerformanceSeries(project, { from: prevWindow.from, to: prevWindow.to })
          .then((p) => p?.series || [])
          .catch((err) => { console.warn('[reports][gsc] prev failed:', err.message); return []; })
      : Promise.resolve([]);

    const data = await gscService.fetchPerformanceSeries(project, { from, to });
    const series = _aggregateSeries(data.series, granularity);
    const isPartial = freshnessMap?.gsc?.status === 'partial' || freshnessMap?.gsc?.status === 'gap';
    const completePeriods = await _completePeriodTotals(data.series, prevPromise);
    return {
      connected: true,
      status: series.length ? (isPartial ? 'partial' : 'ready') : 'empty',
      reason: series.length ? (isPartial ? 'source_lag' : null) : 'no_rows',
      last_sync_at,
      series,
      series_meta: completePeriods.meta,
      totals: data.totals || null,
      totals_complete: completePeriods.totals_complete,
      prev_totals_complete: completePeriods.prev_totals_complete,
      range: data.range,
    };
  } catch (err) {
    console.error('[reports][gsc] section failed:', err.message);
    return {
      connected: true,
      status: 'error',
      reason: 'source_failed',
      error: err.message || 'gsc_failed',
      last_sync_at,
      series: [],
      series_meta: null,
      totals: null,
      totals_complete: null,
      prev_totals_complete: null,
    };
  }
}

async function _ydxSection(project, from, to, granularity, freshnessMap) {
  const last_sync_at = freshnessMap?.yandex_webmaster?.last_successful_sync_at || null;
  if (!project.ydx_connected || !project.ydx_site_url) {
    return { connected: false, status: 'empty', reason: 'not_connected', series: [], totals: null, totals_complete: null, prev_totals_complete: null, series_meta: null, last_sync_at };
  }
  try {
    // П.1: parallel prev-fetch (см. _gscSection).
    const prevWindow = _prevWindowOf(from, to);
    const prevPromise = prevWindow
      ? ydxService.fetchPerformanceSeries(project, { from: prevWindow.from, to: prevWindow.to })
          .then((p) => p?.series || [])
          .catch((err) => { console.warn('[reports][ydx] prev failed:', err.message); return []; })
      : Promise.resolve([]);

    const data = await ydxService.fetchPerformanceSeries(project, { from, to });
    const series = _aggregateSeries(data.series, granularity);
    const isPartial = freshnessMap?.yandex_webmaster?.status === 'partial' || freshnessMap?.yandex_webmaster?.status === 'gap';
    const completePeriods = await _completePeriodTotals(data.series, prevPromise);
    return {
      connected: true,
      status: series.length ? (isPartial ? 'partial' : 'ready') : 'empty',
      reason: series.length ? (isPartial ? 'source_lag' : null) : 'no_rows',
      last_sync_at,
      series,
      series_meta: completePeriods.meta,
      totals: data.totals || null,
      totals_complete: completePeriods.totals_complete,
      prev_totals_complete: completePeriods.prev_totals_complete,
      range: data.range,
    };
  } catch (err) {
    console.error('[reports][ydx] section failed:', err.message);
    return {
      connected: true,
      status: 'error',
      reason: 'source_failed',
      error: err.message || 'ydx_failed',
      last_sync_at,
      series: [],
      series_meta: null,
      totals: null,
      totals_complete: null,
      prev_totals_complete: null,
    };
  }
}

function _mapSeriesRow(r) {
  return {
    date: r.date,
    visibility: r.visibility != null ? Number(r.visibility) : null,
    yandex_traffic: r.yandex_traffic,
    google_traffic: r.google_traffic,
    keywords_top1: r.keywords_top1,
    keywords_top3: r.keywords_top3,
    keywords_top10: r.keywords_top10,
    keywords_top50: r.keywords_top50 != null ? Number(r.keywords_top50) : Number(r.keywords_total || 0),
    keywords_total: r.keywords_total,
    adcost: r.adcost != null ? Number(r.adcost) : null,
  };
}

/**
 * Срез топ-запросов и топ-страниц проекта за период, разбитый по интенту.
 *
 * ТЗ §4: в отчёте по умолчанию показываем коммерческие запросы (transactional,
 * commercial, investigation) и связанные с ними страницы каталога/услуг.
 * Информационные запросы выводятся отдельной вкладкой, чтобы клиент видел
 * именно те данные, которые приносят выручку, а LLM-промпт не «дрейфовал»
 * в информационный контент.
 *
 * Источник данных: gscService.fetchTopDimensions(project, range) — тот же,
 * что используется в AI-аналитике проектов. Классификация — без сети,
 * детерминированно через commercialIntent.classifyQuery c brand-токенами,
 * выведенными из проекта (deriveBrandTokens).
 *
 * Страница помечается коммерческой, если ≥50% её кликов приходится на
 * коммерческие запросы (что соответствует обычной коммерческой посадочной).
 */
const TOP_LIMIT = 25;
const PAGES_LIMIT = 50;             // ТЗ-правка: до 50 топ-страниц с разворачиваемыми запросами
const PER_PAGE_QUERY_LIMIT = 30;    // сколько запросов показываем под каждой страницей

function _classifyQueries(rows, brandTokens) {
  return (rows || []).map((row) => {
    const { intent, branded, commercial } = classifyQuery(row.key || '', { brandTokens });
    return { ...row, intent, branded, commercial };
  });
}

function _splitQueries(rows) {
  const commercial    = rows.filter((r) => r.commercial);
  const informational = rows.filter((r) => r.intent === 'informational');
  const other         = rows.filter((r) => !r.commercial && r.intent !== 'informational');
  // Сортируем каждое сегмент по убыванию кликов, затем по показам.
  const sortRows = (a, b) => (b.clicks - a.clicks) || (b.impressions - a.impressions);
  return {
    commercial: commercial.sort(sortRows).slice(0, TOP_LIMIT),
    informational: informational.sort(sortRows).slice(0, TOP_LIMIT),
    other: other.sort(sortRows).slice(0, TOP_LIMIT),
  };
}

function _splitPages(pages, queryPageMap) {
  // ТЗ-правка: интент страницы определяем по URL (urlClassifier), а не по
  // ненадёжной классификации запросов. Доля commercial-кликов остаётся как
  // вспомогательный сигнал (commercial_share), но решающим является URL.
  // Если маркеров в URL нет (intent='unknown'), страница попадает в оба
  // списка (commercial + informational) — см. _queriesSection.
  return (pages || []).map((p) => {
    const stats = queryPageMap.get(p.key) || { commercialClicks: 0, totalClicks: 0 };
    const commercialShare = stats.totalClicks > 0 ? stats.commercialClicks / stats.totalClicks : null;
    const { intent, confident, marker } = classifyUrl(p.key);
    const isCommercial = intent === 'commercial';
    const isUnknown = intent === 'unknown';
    return {
      ...p,
      // commercial: true | false | null (null = unknown, попадает в оба списка)
      commercial: isUnknown ? null : isCommercial,
      page_intent: intent,
      intent_confident: confident,
      intent_unknown: isUnknown,
      intent_marker: marker,
      commercial_share: commercialShare != null ? Math.round(commercialShare * 100) / 100 : null,
    };
  });
}

/**
 * Список топ-страниц (до PAGES_LIMIT) с разворачиваемым перечнем запросов,
 * по которым продвигается каждая страница. Источник запросов — срез
 * query×page (GSC). Интент страницы — по URL.
 *
 * @param {Array}  pages       topPages [{key, clicks, impressions, ctr, position}]
 * @param {Array}  queryPage   срез query×page [{query, page, clicks, impressions, ctr, position}]
 * @param {string} engine      'google' | 'yandex' — пометка источника
 */
function _buildPagesWithQueries(pages, queryPage, engine) {
  // page -> массив запросов этой страницы
  const queriesByPage = new Map();
  for (const r of queryPage || []) {
    if (!r.page) continue;
    const arr = queriesByPage.get(r.page) || [];
    arr.push({
      query: r.query || '',
      clicks: Number(r.clicks) || 0,
      impressions: Number(r.impressions) || 0,
      ctr: r.ctr != null ? Number(r.ctr) : null,
      position: r.position != null ? Number(r.position) : null,
    });
    queriesByPage.set(r.page, arr);
  }
  const sortRows = (a, b) => (b.clicks - a.clicks) || (b.impressions - a.impressions);
  return (pages || [])
    .slice()
    .sort(sortRows)
    .slice(0, PAGES_LIMIT)
    .map((p) => {
      const { intent, confident, marker } = classifyUrl(p.key);
      const queries = (queriesByPage.get(p.key) || []).sort(sortRows);
      return {
        url: p.key,
        engine,
        clicks: Number(p.clicks) || 0,
        impressions: Number(p.impressions) || 0,
        ctr: p.ctr != null ? Number(p.ctr) : null,
        position: p.position != null ? Number(p.position) : null,
        page_intent: intent,
        intent_confident: confident,
        intent_unknown: intent === 'unknown',
        intent_marker: marker,
        queries_count: queries.length,
        queries: queries.slice(0, PER_PAGE_QUERY_LIMIT),
      };
    });
}

function _summarizeCommercial(queries) {
  let totalClicks = 0, commercialClicks = 0, totalImpr = 0, commercialImpr = 0;
  for (const q of queries) {
    totalClicks    += Number(q.clicks) || 0;
    totalImpr      += Number(q.impressions) || 0;
    if (q.commercial) {
      commercialClicks += Number(q.clicks) || 0;
      commercialImpr   += Number(q.impressions) || 0;
    }
  }
  const sharePct = totalClicks > 0 ? Math.round((commercialClicks / totalClicks) * 1000) / 10 : null;
  return {
    total_clicks: totalClicks,
    total_impressions: totalImpr,
    commercial_clicks: commercialClicks,
    commercial_impressions: commercialImpr,
    commercial_share_pct: sharePct,
  };
}

async function _queriesSection(project, from, to) {
  if (!project.gsc_connected || !project.gsc_site_url) {
    return { connected: false, status: 'empty', reason: 'not_connected',
      top_queries_commercial: [], top_queries_informational: [], top_queries_other: [],
      top_pages_commercial: [], top_pages_informational: [], summary: null };
  }
  try {
    const [{ topQueries, topPages }, queryPage] = await Promise.all([
      gscService.fetchTopDimensions(project, { from, to }),
      // queryPage срез нужен для классификации страниц по доле commercial-кликов.
      // Если упадёт — fallback: страницы без разбиения по intent.
      _safeFetchQueryPage(project, from, to),
    ]);
    const brandTokens = deriveBrandTokens({ name: project.name, siteUrl: project.gsc_site_url, url: project.url });
    const classified = _classifyQueries(topQueries, brandTokens);
    const split = _splitQueries(classified);
    const summary = _summarizeCommercial(classified);

    // Page → суммарные клики по коммерческим/всем запросам этой страницы.
    const queryPageMap = new Map();
    for (const r of queryPage || []) {
      const { commercial } = classifyQuery(r.query || '', { brandTokens });
      const stats = queryPageMap.get(r.page) || { commercialClicks: 0, totalClicks: 0 };
      stats.totalClicks += Number(r.clicks) || 0;
      if (commercial) stats.commercialClicks += Number(r.clicks) || 0;
      queryPageMap.set(r.page, stats);
    }
    const taggedPages = _splitPages(topPages, queryPageMap);
    const sortRows = (a, b) => (b.clicks - a.clicks) || (b.impressions - a.impressions);
    // ТЗ-правка: страницы с нераспознанным интентом (commercial===null)
    // попадают в оба списка, чтобы клиент увидел их и в коммерческом, и в
    // информационном разрезе — в UI они подписаны «не удалось распознать».
    const pagesCommercial    = taggedPages.filter((p) => p.commercial === true  || p.commercial === null).sort(sortRows).slice(0, TOP_LIMIT);
    const pagesInformational = taggedPages.filter((p) => p.commercial === false || p.commercial === null).sort(sortRows).slice(0, TOP_LIMIT);

    // ТЗ-правка: до 50 топ-страниц с разворачиваемым списком запросов (Google).
    // Yandex.Вебмастер не отдаёт срез по страницам, поэтому pages по Яндексу
    // недоступны — это честное ограничение API, помечаем engine.
    const pagesGoogle = _buildPagesWithQueries(topPages, queryPage, 'google');

    return {
      connected: true,
      status: topQueries.length ? 'ready' : 'empty',
      reason: topQueries.length ? null : 'no_rows',
      top_queries_commercial: split.commercial,
      top_queries_informational: split.informational,
      top_queries_other: split.other,
      top_pages_commercial: pagesCommercial,
      top_pages_informational: pagesInformational,
      pages: { google: pagesGoogle, yandex: [] },
      pages_limit: PAGES_LIMIT,
      summary,
    };
  } catch (err) {
    console.error('[reports][queries] section failed:', err.message);
    return {
      connected: true,
      status: 'error',
      reason: 'source_failed',
      error: err.message || 'queries_failed',
      top_queries_commercial: [], top_queries_informational: [], top_queries_other: [],
      top_pages_commercial: [], top_pages_informational: [],
      pages: { google: [], yandex: [] }, pages_limit: PAGES_LIMIT,
      summary: null,
    };
  }
}

async function _safeFetchQueryPage(project, from, to) {
  try {
    if (typeof gscService.fetchQueryPageMatrix === 'function') {
      return (await gscService.fetchQueryPageMatrix(project, { from, to })) || [];
    }
  } catch (err) {
    console.warn('[reports][queries] queryPage fetch failed:', err.message);
  }
  return [];
}

function _mapCurrent(current) {
  if (!current) return null;
  return {
    date: current.date,
    visibility: current.visibility != null ? Number(current.visibility) : null,
    top1: current.keywords_top1,
    top3: current.keywords_top3,
    top10: current.keywords_top10,
    top50: current.keywords_top50 != null ? Number(current.keywords_top50) : Number(current.keywords_total || 0),
    total: current.keywords_total,
    yandex_traffic: current.yandex_traffic,
    google_traffic: current.google_traffic,
    adcost: current.adcost != null ? Number(current.adcost) : null,
  };
}

async function _loadEngineData(domain, from, to, searchEngine) {
  const series = await loadCachedSeries(domain, from, to, searchEngine);
  const current = await loadCurrent(domain, searchEngine);
  return {
    series: (series || []).map(_mapSeriesRow),
    current: _mapCurrent(current),
  };
}

async function _keysSoSection(project, from, to, freshnessMap) {
  const last_sync_at = freshnessMap?.keys_so?.last_successful_sync_at || null;
  if (!project.keys_so_domain) {
    return { connected: false, status: 'empty', reason: 'not_connected', yandex: { series: [], current: null }, google: { series: [], current: null }, series: [], current: null, last_sync_at };
  }
  try {
    // Check if cache is empty; if so, sync (which fetches both Yandex and Google).
    const ydxCurrent = await loadCurrent(project.keys_so_domain, 'yandex');
    const ydxSeries = await loadCachedSeries(project.keys_so_domain, from, to, 'yandex');
    const cacheEmpty = !ydxCurrent && (!ydxSeries || !ydxSeries.length);
    const hasApiKey = !!(process.env.KEYS_SO_API_KEY || process.env.KEYSSO_API_KEY);
    if (cacheEmpty && hasApiKey) {
      await syncDomain(project.keys_so_domain, { base: project.keys_so_region || 'msk', months: 18 });
    }

    const [yandex, google] = await Promise.all([
      _loadEngineData(project.keys_so_domain, from, to, 'yandex'),
      _loadEngineData(project.keys_so_domain, from, to, 'google'),
    ]);

    const hasRows = (yandex.series?.length || 0) + (google.series?.length || 0) > 0;
    // Backwards-compatible: top-level series/current point to Yandex (default)
    return {
      connected: true,
      status: hasRows ? 'ready' : 'empty',
      reason: hasRows ? null : 'no_rows',
      last_sync_at,
      series: yandex.series,
      current: yandex.current,
      yandex,
      google,
    };
  } catch (err) {
    console.error('[reports][keys_so] section failed:', err.message);
    return {
      connected: true,
      status: 'error',
      reason: 'source_failed',
      error: err.message || 'keys_so_failed',
      last_sync_at,
      series: [],
      current: null,
      yandex: { series: [], current: null },
      google: { series: [], current: null },
    };
  }
}

async function _positionSection(projectId, from, to, granularity) {
  const { rows } = await db.query(
    `SELECT id, name, domain, engine::text AS engine, geo_lr, geo_loc, device::text AS device
       FROM position_projects
      WHERE parent_project_id = $1
      LIMIT 1`,
    [projectId],
  );
  const linked = rows[0];
  if (!linked) return { connected: false, status: 'empty', reason: 'not_connected', series: [], summary: null, quick_wins: [], movers_up: [], movers_down: [], keywords: [] };
  const { period } = _periodWindow(from, to);
  const fromTs = `${from}T00:00:00Z`;
  const toTs = `${to}T23:59:59Z`;
  try {
    const [series, summary, keywords, moversUp, moversDown] = await Promise.all([
      positionAnalytics.getProjectSeries(linked.id, { from: fromTs, to: toTs, granularity }),
      positionAnalytics.getProjectSummary(linked.id, { period }),
      positionAnalytics.getKeywordsTable(linked.id, { period }),
      positionAnalytics.getMovers(linked.id, { period, direction: 'up', limit: 8 }),
      positionAnalytics.getMovers(linked.id, { period, direction: 'down', limit: 8 }),
    ]);
    const quickWins = (keywords || [])
      .filter((item) => item.position != null && item.position >= 11 && item.position <= 15)
      .slice(0, 12)
      .map((item) => ({
        query: item.query,
        position: item.position,
        delta: item.delta,
        found_url: item.found_url || null,
      }));
    const hasRows = (series && series.length) || (keywords && keywords.length);
    return {
      connected: true,
      status: hasRows ? 'ready' : 'empty',
      reason: hasRows ? null : 'no_rows',
      project: linked,
      series,
      summary,
      keywords,
      quick_wins: quickWins,
      movers_up: moversUp,
      movers_down: moversDown,
    };
  } catch (err) {
    console.error('[reports][position] section failed:', err.message);
    return { connected: true, status: 'error', reason: 'source_failed', error: err.message || 'position_failed', series: [], summary: null, quick_wins: [], movers_up: [], movers_down: [], keywords: [] };
  }
}

async function _tasksSection(projectId, from, to, granularity, manualBlocks, opts = {}) {
  const includeHidden = opts.includeHidden === true;
  try {
    const [items, summary] = await Promise.all([
      tasksLog.listForPeriod(projectId, from, to, { includeHidden }),
      tasksLog.summarizeByType(projectId, from, to),
    ]);
    const hasRows = items && items.length;
    return {
      ...summary,
      status: hasRows ? 'ready' : 'empty',
      reason: hasRows ? null : 'no_rows',
      items,
      blocks: _groupTasks(items, manualBlocks),
      annotations: items.slice(0, 12).map((item) => _annotationFromTask(item, granularity)),
    };
  } catch (err) {
    console.error('[reports][tasks] section failed:', err.message);
    return {
      status: 'error',
      reason: 'source_failed',
      error: err.message || 'tasks_failed',
      total_generated: 0,
      by_type: {},
      items: [],
      blocks: Array.isArray(manualBlocks) ? manualBlocks : [],
      annotations: [],
    };
  }
}

function _buildForecast(gsc, keysSo) {
  const out = {};
  const gscClicks = (gsc.series || []).map((r) => Number(r.clicks) || 0);
  const visibility = (keysSo.series || []).map((r) => r.visibility != null ? Number(r.visibility) : null).filter((v) => v != null);
  if (gscClicks.length >= 2) out.gsc_clicks = forecastMetric(gscClicks, 3);
  if (visibility.length >= 2) out.keys_visibility = forecastMetric(visibility, 3);
  return out;
}

async function _modulesSection(project, from, to, config) {
  const moduleConfig = (config && config.modules) || {};
  // Полностью отключить блок модулей можно через config.modules.enabled = false.
  if (moduleConfig.enabled === false) {
    return { enabled: [], disabled: true, status: 'empty', reason: 'disabled' };
  }
  if (!project.gsc_connected || !project.gsc_site_url) {
    // Без GSC ключевые модули (Striking Distance / CTR Gap / Content Health)
    // не имеют данных — явно сигналим, а не прячем тихо.
    return { enabled: [], status: 'empty', reason: 'not_connected' };
  }
  try {
    const modules = await buildModulesForProject(project, { from, to, config: moduleConfig });
    const hasAny = !!(modules.striking_distance?.items?.length
      || modules.ctr_gap?.items?.length
      || modules.content_health?.items?.length
      || modules.off_page?.items?.length
      || modules.tech_audit?.items?.length);
    return {
      ...modules,
      status: hasAny ? 'ready' : 'empty',
      reason: hasAny ? null : 'no_rows',
    };
  } catch (err) {
    console.error('[reports][modules] section failed:', err.message);
    return { enabled: [], status: 'error', reason: 'source_failed', error: err.message || 'modules_failed' };
  }
}

async function _loadFreshnessMap(projectId) {
  try {
    const arr = await freshnessService.getProjectFreshness(projectId);
    const map = {};
    for (const item of arr || []) map[item.source] = item;
    return map;
  } catch (_) {
    return {};
  }
}

async function aggregateForDraft(draft, opts = {}) {
  const { rows } = await db.query(`SELECT * FROM projects WHERE id = $1`, [draft.project_id]);
  const project = rows[0];
  if (!project) throw new Error('project_not_found');

  const from = _isoDate(opts.from || draft.date_from);
  const to = _isoDate(opts.to || draft.date_to);
  const granularity = _granularity(opts.granularity || draft.config?.granularity || 'month');
  const viewMode = opts.viewMode || 'analyst';

  const freshnessMap = await _loadFreshnessMap(project.id);

  // П.1: распараллелить все секции в один Promise.all (включая modules).
  // _*Section внутри ловят ошибки источников и возвращают status='error',
  // так что .all не падает целиком. Раньше modules ждали отдельно ПОСЛЕ
  // основного Promise.all и удваивали общее время ответа.
  const [gsc, ywm, keysSo, position, tasks, queries, modules] = await Promise.all([
    _gscSection(project, from, to, granularity, freshnessMap),
    _ydxSection(project, from, to, granularity, freshnessMap),
    _keysSoSection(project, from, to, freshnessMap),
    _positionSection(project.id, from, to, granularity),
    _tasksSection(project.id, from, to, granularity, draft.tasks_blocks, { includeHidden: opts.includeHidden }),
    _queriesSection(project, from, to),
    _modulesSection(project, from, to, draft.config),
  ]);

  // Сводный статус интеграций — нужен для UI-баннеров и для PDF footnote
  // (если какие-то секции в partial/error, в экспорт добавляется сноска).
  //
  // core: true — это настоящие внешние интеграции данных (GSC, Яндекс,
  // Keys.so, съём позиций). Только по ним строится глобальная плашка
  // «часть источников недоступна». Производные/внутренние секции (Работы,
  // Модули, Топ-запросы) имеют собственные пустые состояния в своих блоках
  // и НЕ должны пугать клиента в общем баннере — иначе пустой лог работ даёт
  // ложное «Не удалось получить: Работы».
  const integrations = [
    { id: 'gsc', label: 'Google Search Console', status: gsc.status, reason: gsc.reason, last_sync_at: gsc.last_sync_at || null, core: true },
    { id: 'yandex_webmaster', label: 'Яндекс.Вебмастер', status: ywm.status, reason: ywm.reason, last_sync_at: ywm.last_sync_at || null, core: true },
    { id: 'keys_so', label: 'Keys.so', status: keysSo.status, reason: keysSo.reason, last_sync_at: keysSo.last_sync_at || null, core: true },
    { id: 'position', label: 'Съём позиций', status: position.status, reason: position.reason, last_sync_at: null, core: true },
    { id: 'tasks', label: 'Работы', status: tasks.status, reason: tasks.reason, last_sync_at: null, core: false },
    { id: 'modules', label: 'Модули', status: modules.status, reason: modules.reason, last_sync_at: null, core: false },
    { id: 'queries', label: 'Топ-запросы', status: queries.status, reason: queries.reason, last_sync_at: null, core: false },
  ];
  const coreIntegrations = integrations.filter((i) => i.core);
  const completeness = {
    has_partial: coreIntegrations.some((i) => i.status === 'partial'),
    has_error: coreIntegrations.some((i) => i.status === 'error'),
    has_empty: coreIntegrations.some((i) => i.status === 'empty'),
    partial_sources: coreIntegrations.filter((i) => i.status === 'partial').map((i) => i.label),
    failed_sources: coreIntegrations.filter((i) => i.status === 'error').map((i) => i.label),
  };

  const payload = {
    project: {
      id: project.id,
      name: project.name,
      url: project.url,
      logo_url: project.logo_url || null,
      color_accent: project.color_accent || null,
      keys_so_domain: project.keys_so_domain || null,
    },
    period: { from, to, granularity },
    gsc,
    ywm,
    keys_so: keysSo,
    position,
    tasks,
    modules,
    queries,
    integrations,
    completeness,
    view_mode: viewMode,
    traffic_value: _buildTrafficValue(keysSo, gsc, ywm),
    forecast: _buildForecast(gsc, keysSo),
    generated_at: new Date().toISOString(),
  };

  // Sprint 2: client-first headline (главный KPI, что изменилось, top-3
  // достижения/риска). Чисто детерминированный блок над уже собранным
  // payload — не зависит от LLM. Безопасно для client mode по построению
  // (не содержит технических полей).
  try {
    payload.headline = buildHeadline(payload, draft?.summary || draft?.llm_summary || null);
  } catch (err) {
    console.error('[reports][headline] build failed:', err.message);
    payload.headline = null;
  }

  // ТЗ §6: ручные правки чисел и AI-блоков. Применяем ПОСЛЕ headline, но
  // ДО sanitize — sanitize не должен трогать пользовательские значения,
  // а наоборот, может уронить тех. поля, прокинутые правкой случайно.
  // overrides сохраняются в draft.overrides (миграция 088).
  if (draft && draft.overrides && typeof draft.overrides === 'object') {
    try {
      applyOverrides(payload, draft.overrides);
    } catch (err) {
      console.error('[reports][overrides] apply failed:', err.message);
    }
  }

  return sanitizeData(payload, viewMode);
}

module.exports = {
  aggregateForDraft,
  _aggregateSeries,
  _aggregateByMonth,
  _isoDate,
  _seriesMeta,
  _totalsFromMonths,
  _completePeriodTotals,
  _classifyQueries,
  _splitQueries,
  _splitPages,
  _buildPagesWithQueries,
  _summarizeCommercial,
};
