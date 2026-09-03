'use strict';

const axios = require('axios');
const { getIntegrationSecret } = require('../integrations/integrationVault');

const BASE_URL = 'https://api-metrika.yandex.net';
const TIMEOUT_MS = 20_000;
const MAX_SOURCE_ROWS = 100;
// Metrica stat/v1/data accepts at most 20 metrics per request. Keep room
// for the four daily base metrics (or two source metrics).
const MAX_GOAL_METRICS_PER_REQUEST = 16;

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

function normalizeGoalId(value) {
  const raw = String(value == null ? '' : value).trim();
  return /^\d{1,20}$/.test(raw) ? raw : '';
}

function goalMetricName(goalId) {
  const id = normalizeGoalId(goalId);
  return id ? `ym:s:goal${id}reaches` : '';
}

function goalIdsFromBody(body) {
  const rows = Array.isArray(body?.goals) ? body.goals : (Array.isArray(body) ? body : []);
  return [...new Set(rows.map((goal) => normalizeGoalId(goal?.id ?? goal?.goal_id ?? goal)))]
    .filter(Boolean);
}

async function requestGoals(token, counterId) {
  const response = await axios.get(`${BASE_URL}/management/v1/counter/${counterId}/goals`, {
    timeout: TIMEOUT_MS,
    headers: {
      Authorization: `OAuth ${token}`,
      Accept: 'application/json',
      'User-Agent': 'SeoMST/1.0 report-metrika',
    },
    validateStatus: (status) => status >= 200 && status < 300,
  });
  return goalIdsFromBody(response.data || {});
}

function chunk(values, size) {
  const output = [];
  for (let i = 0; i < values.length; i += size) output.push(values.slice(i, i + size));
  return output.length ? output : [[]];
}

function mergeMetricBodies(results) {
  const metricNames = [...new Set(results.flatMap((item) => item.metrics || []))];
  const byDimension = new Map();
  for (const item of results) {
    const metrics = item.metrics || [];
    for (const row of responseRows(item.body)) {
      const key = dimensionValue(row);
      if (!key) continue;
      const current = byDimension.get(key) || {
        dimensions: Array.isArray(row.dimensions) ? row.dimensions : [{ name: key }],
        values: new Map(),
      };
      metrics.forEach((name, index) => {
        if (!name) return;
        current.values.set(name, (current.values.get(name) || 0) + asNumber(row?.metrics?.[index]));
      });
      byDimension.set(key, current);
    }
  }
  return {
    body: {
      data: [...byDimension.values()].map((entry) => ({
        dimensions: entry.dimensions,
        metrics: metricNames.map((name) => entry.values.get(name) || 0),
      })),
    },
    metrics: metricNames,
  };
}

function goalReaches(row, metrics) {
  return metrics.reduce((sum, name, index) => (
    /^ym:s:goal\d+reaches$/.test(String(name))
      ? sum + asNumber(row?.metrics?.[index])
      : sum
  ), 0);
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

async function requestMetricBatches(token, baseParams, baseMetrics, goalIds) {
  const goalMetrics = goalIds.map(goalMetricName).filter(Boolean);
  const batches = chunk(goalMetrics, MAX_GOAL_METRICS_PER_REQUEST);
  const results = await Promise.all(batches.map(async (batch) => {
    const metrics = [...baseMetrics, ...batch];
    const body = await requestReport(token, { ...baseParams, metrics: metrics.join(',') });
    return { body, metrics };
  }));
  const merged = mergeMetricBodies(results);
  return { body: merged.body, metrics: merged.metrics };
}

function mapDailyRows(body, metrics) {
  return responseRows(body)
    .map((row) => {
      const visits = metricValue(row, metrics, 'ym:s:visits');
      const users = metricValue(row, metrics, 'ym:s:users');
      const pageviews = metricValue(row, metrics, 'ym:s:pageviews');
      const bounceRate = metricValue(row, metrics, 'ym:s:bounceRate');
      const conversions = goalReaches(row, metrics);
      const conversionRate = visits ? round((conversions / visits) * 100) : 0;
      return {
        date: dimensionValue(row),
        visits,
        users,
        pageviews,
        bounce_rate: round(bounceRate),
        conversions,
        conversion_rate: conversionRate,
      };
    })
    .filter((row) => row.date);
}

function mapSourceRows(body, metrics) {
  return responseRows(body)
    .map((row) => {
      const visits = metricValue(row, metrics, 'ym:s:visits');
      const conversions = goalReaches(row, metrics);
      return {
        source: dimensionValue(row),
        visits,
        users: metricValue(row, metrics, 'ym:s:users'),
        conversions,
        conversion_rate: visits ? round((conversions / visits) * 100) : 0,
      };
    })
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

  const dailyBaseMetrics = [
    'ym:s:visits',
    'ym:s:users',
    'ym:s:pageviews',
    'ym:s:bounceRate',
  ];
  const sourceBaseMetrics = [
    'ym:s:visits',
    'ym:s:users',
  ];
  // The Metrica API requires a concrete goal ID for goal metrics. There is no
  // supported `ym:ev:anyGoal*` wildcard in stat/v1/data, so discover goals
  // first and add one `ym:s:goal<ID>reaches` metric per actual goal.
  let goalIds = [];
  try {
    goalIds = await requestGoals(token, counterId);
  } catch (error) {
    // Traffic remains useful when goals are unavailable or the account has no
    // goal-management permission. Do not turn this optional block into a 400.
    goalIds = [];
  }

  const [dailyResult, sourceResult] = await Promise.all([
    requestMetricBatches(token, {
      id: counterId,
      date1,
      date2,
      lang: 'ru',
      dimensions: 'ym:s:date',
      limit: 10_000,
      accuracy: 'full',
    }, dailyBaseMetrics, goalIds),
    requestMetricBatches(token, {
      id: counterId,
      date1,
      date2,
      lang: 'ru',
      dimensions: 'ym:s:trafficSource',
      limit: MAX_SOURCE_ROWS,
      accuracy: 'full',
      sort: '-ym:s:visits',
    }, sourceBaseMetrics, goalIds),
  ]);

  const dailyBody = dailyResult.body;
  const dailyMetrics = dailyResult.metrics;
  const sourceBody = sourceResult.body;
  const sourceMetrics = sourceResult.metrics;
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
    goal_scope: goalIds.length ? 'all_goals' : 'none_or_unavailable',
    goal_count: goalIds.length,
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
    normalizeGoalId,
    goalMetricName,
    goalIdsFromBody,
    mergeMetricBodies,
    goalReaches,
    requestMetricBatches,
  },
};
