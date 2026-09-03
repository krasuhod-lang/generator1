'use strict';

const axios = require('axios');
const { getIntegrationSecret } = require('../integrations/integrationVault');

const BASE_URL = 'https://api-metrika.yandex.net';
const TIMEOUT_MS = 20_000;
const MAX_SOURCE_ROWS = 100;

function normalizeCounterId(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  return /^\d{1,20}$/.test(raw) ? raw : '';
}

function normalizeDate(value) {
  const raw = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

function resolveRange({ days, from, to } = {}) {
  const directFrom = normalizeDate(from);
  const directTo = normalizeDate(to);
  if (directFrom && directTo && directFrom <= directTo) {
    return { from: directFrom, to: directTo };
  }
  const count = Math.min(Math.max(Number(days) || 28, 1), 370);
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (count - 1));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round(value, precision = 2) {
  const factor = 10 ** precision;
  return Math.round(asNumber(value) * factor) / factor;
}

function responseRows(body) {
  return Array.isArray(body?.data) ? body.data : [];
}

function dimensionValue(row, index = 0) {
  const item = Array.isArray(row?.dimensions) ? row.dimensions[index] : null;
  return String(item?.name ?? item?.id ?? item?.value ?? '').trim();
}

function metricValue(row, metrics, name) {
  const index = metrics.indexOf(name);
  return index >= 0 ? asNumber(row?.metrics?.[index]) : 0;
}

async function requestReport(token, params) {
  const response = await axios.get(`${BASE_URL}/stat/v1/data`, {
    timeout: TIMEOUT_MS,
    headers: {
      Authorization: `OAuth ${token}`,
      Accept: 'application/json',
      'User-Agent': 'SeoMST/1.0 report-metrika',
    },
    params,
    validateStatus: (status) => status >= 200 && status < 300,
  });
  return response.data || {};
}

function mapDailyRows(body, metrics) {
  return responseRows(body)
    .map((row) => {
      const visits = metricValue(row, metrics, 'ym:s:visits');
      const users = metricValue(row, metrics, 'ym:s:users');
      const pageviews = metricValue(row, metrics, 'ym:s:pageviews');
      const bounceRate = metricValue(row, metrics, 'ym:s:bounceRate');
      const conversions = metricValue(row, metrics, 'ym:ev:anyGoalReaches');
      const conversionRate = metricValue(row, metrics, 'ym:ev:anyGoalConversionRate');
      return {
        date: dimensionValue(row),
        visits,
        users,
        pageviews,
        bounce_rate: round(bounceRate),
        conversions,
        conversion_rate: round(conversionRate),
      };
    })
    .filter((row) => row.date);
}

function mapSourceRows(body, metrics) {
  return responseRows(body)
    .map((row) => ({
      source: dimensionValue(row),
      visits: metricValue(row, metrics, 'ym:s:visits'),
      users: metricValue(row, metrics, 'ym:s:users'),
      conversions: metricValue(row, metrics, 'ym:ev:anyGoalReaches'),
      conversion_rate: round(metricValue(row, metrics, 'ym:ev:anyGoalConversionRate')),
    }))
    .filter((row) => row.source)
    .sort((a, b) => (b.visits - a.visits) || (b.conversions - a.conversions))
    .slice(0, MAX_SOURCE_ROWS);
}

function aggregateSeries(rows, granularity) {
  const byBucket = new Map();
  const keyFor = (date) => {
    if (granularity === 'day') return date;
    if (granularity === 'week') {
      const d = new Date(`${date}T00:00:00Z`);
      if (Number.isNaN(d.getTime())) return date;
      const day = d.getUTCDay() || 7;
      d.setUTCDate(d.getUTCDate() - day + 1);
      return d.toISOString().slice(0, 10);
    }
    return String(date).slice(0, 7);
  };
  for (const row of rows) {
    const key = keyFor(row.date);
    const current = byBucket.get(key) || {
      date: key, visits: 0, users: 0, pageviews: 0, conversions: 0, _bounceWeighted: 0, _bounceWeight: 0,
    };
    current.visits += row.visits;
    current.users += row.users;
    current.pageviews += row.pageviews;
    current.conversions += row.conversions;
    if (row.visits > 0) {
      current._bounceWeighted += row.bounce_rate * row.visits;
      current._bounceWeight += row.visits;
    }
    byBucket.set(key, current);
  }
  return [...byBucket.values()].sort((a, b) => a.date.localeCompare(b.date)).map((row) => ({
    date: row.date,
    visits: row.visits,
    users: row.users,
    pageviews: row.pageviews,
    conversions: row.conversions,
    bounce_rate: row._bounceWeight ? round(row._bounceWeighted / row._bounceWeight) : null,
    conversion_rate: row.visits ? round((row.conversions / row.visits) * 100) : 0,
  }));
}

function aggregateTotals(rows) {
  const totals = rows.reduce((acc, row) => {
    acc.visits += row.visits;
    acc.users += row.users;
    acc.pageviews += row.pageviews;
    acc.conversions += row.conversions;
    if (row.visits > 0 && row.bounce_rate != null) {
      acc.bounceWeighted += row.bounce_rate * row.visits;
      acc.bounceWeight += row.visits;
    }
    return acc;
  }, { visits: 0, users: 0, pageviews: 0, conversions: 0, bounceWeighted: 0, bounceWeight: 0 });
  return {
    visits: totals.visits,
    users: totals.users,
    pageviews: totals.pageviews,
    conversions: totals.conversions,
    bounce_rate: totals.bounceWeight ? round(totals.bounceWeighted / totals.bounceWeight) : null,
    conversion_rate: totals.visits ? round((totals.conversions / totals.visits) * 100) : 0,
  };
}

async function fetchReport(project, range, { granularity = 'month' } = {}) {
  const counterId = normalizeCounterId(project?.yandex_metrika_counter_id);
  if (!counterId) {
    return {
      connected: false,
      status: 'empty',
      reason: 'counter_not_configured',
      counter_id: null,
      range: { from: range?.from || null, to: range?.to || null },
      series: [],
      totals: null,
      sources: [],
      goal_scope: 'all_goals',
    };
  }

  const token = await getIntegrationSecret('YANDEX_METRIKA_OAUTH_TOKEN');
  if (!token) {
    return {
      connected: false,
      status: 'empty',
      reason: 'token_not_configured',
      counter_id: counterId,
      range: { from: range?.from || null, to: range?.to || null },
      series: [],
      totals: null,
      sources: [],
      goal_scope: 'all_goals',
    };
  }

  const date1 = normalizeDate(range?.from);
  const date2 = normalizeDate(range?.to);
  if (!date1 || !date2 || date1 > date2) {
    return {
      connected: true,
      status: 'empty',
      reason: 'invalid_range',
      counter_id: counterId,
      range: { from: date1 || null, to: date2 || null },
      series: [],
      totals: null,
      sources: [],
      goal_scope: 'all_goals',
    };
  }

  const dailyMetrics = [
    'ym:s:visits',
    'ym:s:users',
    'ym:s:pageviews',
    'ym:s:bounceRate',
    'ym:ev:anyGoalReaches',
    'ym:ev:anyGoalConversionRate',
  ];
  const sourceMetrics = [
    'ym:s:visits',
    'ym:s:users',
    'ym:ev:anyGoalReaches',
    'ym:ev:anyGoalConversionRate',
  ];

  const [dailyBody, sourceBody] = await Promise.all([
    requestReport(token, {
      id: counterId,
      date1,
      date2,
      lang: 'ru',
      dimensions: 'ym:s:date',
      metrics: dailyMetrics.join(','),
      limit: 10_000,
      accuracy: 'full',
    }),
    requestReport(token, {
      id: counterId,
      date1,
      date2,
      lang: 'ru',
      dimensions: 'ym:s:trafficSource',
      metrics: sourceMetrics.join(','),
      limit: MAX_SOURCE_ROWS,
      accuracy: 'full',
      sort: '-ym:s:visits',
    }),
  ]);

  const dailyRows = mapDailyRows(dailyBody, dailyMetrics);
  const series = aggregateSeries(dailyRows, granularity);
  return {
    connected: true,
    status: series.length || responseRows(sourceBody).length ? 'ready' : 'empty',
    reason: series.length || responseRows(sourceBody).length ? null : 'no_rows',
    counter_id: counterId,
    range: { from: date1, to: date2 },
    granularity,
    series,
    totals: aggregateTotals(dailyRows),
    sources: mapSourceRows(sourceBody, sourceMetrics),
    goal_scope: 'all_goals',
    generated_at: new Date().toISOString(),
  };
}

module.exports = {
  normalizeCounterId,
  resolveRange,
  fetchReport,
  _internal: {
    mapDailyRows,
    mapSourceRows,
    aggregateSeries,
    aggregateTotals,
  },
};
