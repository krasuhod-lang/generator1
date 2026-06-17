'use strict';

const db = require('../../config/db');
const gscService = require('../projects/gscService');
const ydxService = require('../projects/ydxService');
const { loadCachedSeries, loadCurrent, syncDomain } = require('./keysSoSync');
const tasksLog = require('./tasksAutoLog');
const { forecastMetric } = require('./forecastEngine');
const positionAnalytics = require('../positionTracker/analytics');

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

async function _gscSection(project, from, to, granularity) {
  if (!project.gsc_connected || !project.gsc_site_url) return { connected: false, series: [], totals: null };
  try {
    const data = await gscService.fetchPerformanceSeries(project, { from, to });
    return {
      connected: true,
      series: _aggregateSeries(data.series, granularity),
      totals: data.totals || null,
      range: data.range,
    };
  } catch (err) {
    return { connected: true, error: err.message || 'gsc_failed', series: [], totals: null };
  }
}

async function _ydxSection(project, from, to, granularity) {
  if (!project.ydx_connected || !project.ydx_site_url) return { connected: false, series: [], totals: null };
  try {
    const data = await ydxService.fetchPerformanceSeries(project, { from, to });
    return {
      connected: true,
      series: _aggregateSeries(data.series, granularity),
      totals: data.totals || null,
      range: data.range,
    };
  } catch (err) {
    return { connected: true, error: err.message || 'ydx_failed', series: [], totals: null };
  }
}

async function _keysSoSection(project, from, to) {
  if (!project.keys_so_domain) return { connected: false, series: [], current: null };
  try {
    let series = await loadCachedSeries(project.keys_so_domain, from, to);
    let current = await loadCurrent(project.keys_so_domain);
    const cacheEmpty = !current && (!series || !series.length);
    const hasApiKey = !!(process.env.KEYS_SO_API_KEY || process.env.KEYSSO_API_KEY);
    if (cacheEmpty && hasApiKey) {
      await syncDomain(project.keys_so_domain, { base: project.keys_so_region || 'msk', months: 18 });
      series = await loadCachedSeries(project.keys_so_domain, from, to);
      current = await loadCurrent(project.keys_so_domain);
    }
    return {
      connected: true,
      series: (series || []).map((r) => ({
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
      })),
      current: current ? {
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
      } : null,
    };
  } catch (err) {
    return { connected: true, error: err.message || 'keys_so_failed', series: [], current: null };
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
  if (!linked) return { connected: false, series: [], summary: null, quick_wins: [], movers_up: [], movers_down: [], keywords: [] };
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
    return {
      connected: true,
      project: linked,
      series,
      summary,
      keywords,
      quick_wins: quickWins,
      movers_up: moversUp,
      movers_down: moversDown,
    };
  } catch (err) {
    return { connected: true, error: err.message || 'position_failed', series: [], summary: null, quick_wins: [], movers_up: [], movers_down: [], keywords: [] };
  }
}

async function _tasksSection(projectId, from, to, granularity, manualBlocks, opts = {}) {
  const includeHidden = opts.includeHidden === true;
  try {
    const [items, summary] = await Promise.all([
      tasksLog.listForPeriod(projectId, from, to, { includeHidden }),
      tasksLog.summarizeByType(projectId, from, to),
    ]);
    return {
      ...summary,
      items,
      blocks: _groupTasks(items, manualBlocks),
      annotations: items.slice(0, 12).map((item) => _annotationFromTask(item, granularity)),
    };
  } catch (err) {
    return {
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

async function aggregateForDraft(draft, opts = {}) {
  const { rows } = await db.query(`SELECT * FROM projects WHERE id = $1`, [draft.project_id]);
  const project = rows[0];
  if (!project) throw new Error('project_not_found');

  const from = _isoDate(opts.from || draft.date_from);
  const to = _isoDate(opts.to || draft.date_to);
  const granularity = _granularity(opts.granularity || draft.config?.granularity || 'month');

  const [gsc, ywm, keysSo, position, tasks] = await Promise.all([
    _gscSection(project, from, to, granularity),
    _ydxSection(project, from, to, granularity),
    _keysSoSection(project, from, to),
    _positionSection(project.id, from, to, granularity),
    _tasksSection(project.id, from, to, granularity, draft.tasks_blocks, { includeHidden: opts.includeHidden }),
  ]);

  return {
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
    traffic_value: _buildTrafficValue(keysSo, gsc, ywm),
    forecast: _buildForecast(gsc, keysSo),
    generated_at: new Date().toISOString(),
  };
}

module.exports = {
  aggregateForDraft,
  _aggregateSeries,
  _isoDate,
};
