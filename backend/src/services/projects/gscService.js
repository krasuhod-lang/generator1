'use strict';

/**
 * projects/gscService.js — высокоуровневый слой над gscClient: управление
 * токенами проекта (расшифровка, авто-обновление access по refresh с
 * сохранением в БД в зашифрованном виде) и сбор данных для дашборда и
 * AI-аналитики.
 */

const db = require('../../config/db');
const gsc = require('./gscClient');
const { encryptToken, decryptToken } = require('./tokenCrypto');

/**
 * Возвращает валидный access-токен для проекта, при необходимости обновляя
 * его через refresh и сохраняя новый зашифрованный токен + expiry в БД.
 * @param {Object} project строка projects (с *_enc и gsc_token_expiry)
 */
async function getValidAccessToken(project) {
  if (!project || !project.gsc_connected) {
    throw new gsc.GscError('Проект не подключён к Google Search Console', 'gsc_not_connected', 409);
  }
  const expiry = project.gsc_token_expiry ? new Date(project.gsc_token_expiry).getTime() : 0;
  const now = Date.now();
  // 60 c запас, чтобы токен не протух в середине серии запросов.
  if (project.gsc_access_token_enc && expiry - 60_000 > now) {
    return decryptToken(project.gsc_access_token_enc);
  }
  // Обновляем по refresh.
  const refresh = project.gsc_refresh_token_enc ? decryptToken(project.gsc_refresh_token_enc) : '';
  const refreshed = await gsc.refreshAccessToken(refresh);
  const newExpiry = new Date(Date.now() + refreshed.expiresIn * 1000);
  await db.query(
    `UPDATE projects
        SET gsc_access_token_enc = $2, gsc_token_expiry = $3, updated_at = NOW()
      WHERE id = $1`,
    [project.id, encryptToken(refreshed.accessToken), newExpiry],
  );
  return refreshed.accessToken;
}

function _isoDate(d) { return d.toISOString().slice(0, 10); }

/** Диапазон дат из пресета (days) или кастомный {from,to}. Возвращает ISO-строки. */
function resolveRange({ days, from, to } = {}) {
  if (from && to) return { startDate: from, endDate: to };
  const n = Number(days) || 28;
  const end = new Date();
  // GSC отдаёт данные с задержкой ~2-3 дня — не запрашиваем «сегодня».
  end.setUTCDate(end.getUTCDate() - 2);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (n - 1));
  return { startDate: _isoDate(start), endDate: _isoDate(end) };
}

/**
 * Предыдущий равный по длине период (для PoP-сравнения). Заканчивается за
 * день до startDate переданного периода.
 * @returns {{from:string, to:string, days:number}} — формат, совместимый с
 *   resolveRange/fetchPerformanceSeries (они принимают {from,to}).
 */
function previousRange(range) {
  const { startDate, endDate } = resolveRange(range);
  const start = new Date(`${startDate}T00:00:00Z`);
  const end   = new Date(`${endDate}T00:00:00Z`);
  const days  = Math.max(1, Math.round((end - start) / 86400000) + 1);
  const prevEnd   = new Date(start);
  prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setUTCDate(prevStart.getUTCDate() - (days - 1));
  return { from: _isoDate(prevStart), to: _isoDate(prevEnd), days };
}

function _round(n, p = 2) {
  const f = Math.pow(10, p);
  return Math.round((Number(n) || 0) * f) / f;
}

/**
 * Данные для графика эффективности: помесячная/посуточная динамика 4 метрик
 * (clicks, impressions, ctr, position) + суммарные тоталы за период.
 */
async function fetchPerformanceSeries(project, range) {
  const { startDate, endDate } = resolveRange(range);
  const accessToken = await getValidAccessToken(project);
  const { rows, fromCache } = await gsc.querySearchAnalyticsAll(accessToken, project.gsc_site_url, {
    startDate, endDate,
    dimensions: ['date'],
  });
  const series = rows.map((r) => ({
    date: Array.isArray(r.keys) ? r.keys[0] : null,
    clicks: r.clicks || 0,
    impressions: r.impressions || 0,
    ctr: _round((r.ctr || 0) * 100, 2), // в процентах
    position: _round(r.position || 0, 2),
  }));
  const totalClicks = series.reduce((s, p) => s + p.clicks, 0);
  const totalImpr = series.reduce((s, p) => s + p.impressions, 0);
  const avgCtr = totalImpr ? _round((totalClicks / totalImpr) * 100, 2) : 0;
  const avgPos = series.length
    ? _round(series.reduce((s, p) => s + p.position, 0) / series.length, 2)
    : 0;
  return {
    range: { startDate, endDate },
    series,
    totals: { clicks: totalClicks, impressions: totalImpr, ctr: avgCtr, position: avgPos },
    fromCache: Boolean(fromCache),
  };
}

/** Топ-запросы и топ-страницы за период (для среза AI-аналитики). */
async function fetchTopDimensions(project, range, { rowLimit = 0 } = {}) {
  const { startDate, endDate } = resolveRange(range);
  const accessToken = await getValidAccessToken(project);

  const mapRow = (r) => ({
    key: Array.isArray(r.keys) ? r.keys[0] : '',
    clicks: r.clicks || 0,
    impressions: r.impressions || 0,
    ctr: _round((r.ctr || 0) * 100, 2),
    position: _round(r.position || 0, 2),
  });

  const [q, p] = await Promise.all([
    gsc.querySearchAnalyticsAll(accessToken, project.gsc_site_url, {
      startDate, endDate, dimensions: ['query'],
    }, { maxRows: rowLimit }),
    gsc.querySearchAnalyticsAll(accessToken, project.gsc_site_url, {
      startDate, endDate, dimensions: ['page'],
    }, { maxRows: rowLimit }),
  ]);
  return {
    topQueries: (q.rows || []).map(mapRow),
    topPages: (p.rows || []).map(mapRow),
  };
}

/**
 * Срез «запрос × страница» за период — для детектора каннибализации и
 * несоответствия интента в коммерческом анализе. Возвращает плоский список
 * строк {query, page, clicks, impressions, ctr%, position}.
 *
 * @param {Object} [opts]
 * @param {string} [opts.page]     если задан — фильтруем выборку этой страницей
 *   на стороне GSC (dimensionFilterGroups), чтобы не тянуть весь индекс ради
 *   одного URL (живой эндпоинт под 60-секундным таймаутом фронта).
 * @param {number} [opts.rowLimit] потолок строк (0 = без лимита, фон-аналитика).
 */
async function fetchQueryPageMatrix(project, range, { page, rowLimit = 0 } = {}) {
  const { startDate, endDate } = resolveRange(range);
  const accessToken = await getValidAccessToken(project);
  const body = {
    startDate, endDate,
    dimensions: ['query', 'page'],
  };
  if (page) {
    body.dimensionFilterGroups = [{
      filters: [{ dimension: 'page', operator: 'equals', expression: page }],
    }];
  }
  const { rows } = await gsc.querySearchAnalyticsAll(
    accessToken, project.gsc_site_url, body, { maxRows: rowLimit },
  );
  return (rows || []).map((r) => ({
    query: Array.isArray(r.keys) ? (r.keys[0] || '') : '',
    page: Array.isArray(r.keys) ? (r.keys[1] || '') : '',
    clicks: r.clicks || 0,
    impressions: r.impressions || 0,
    ctr: _round((r.ctr || 0) * 100, 2),
    position: _round(r.position || 0, 2),
  }));
}

/**
 * Универсальный одно-измеренческий разрез по device / country / searchAppearance.
 * Возвращает массив {key, clicks, impressions, ctr%, position}.
 */
async function fetchBreakdown(project, range, dimension, { rowLimit = 0 } = {}) {
  const { startDate, endDate } = resolveRange(range);
  const accessToken = await getValidAccessToken(project);
  const { rows } = await gsc.querySearchAnalyticsAll(accessToken, project.gsc_site_url, {
    startDate, endDate,
    dimensions: [dimension],
  }, { maxRows: rowLimit });
  return (rows || []).map((r) => ({
    key: Array.isArray(r.keys) ? (r.keys[0] || '') : '',
    clicks: r.clicks || 0,
    impressions: r.impressions || 0,
    ctr: _round((r.ctr || 0) * 100, 2),
    position: _round(r.position || 0, 2),
  }));
}

/**
 * Срез page × date — нужен для page-decay detector (регрессия по неделям
 * на каждой странице из топа). Тянем строки только для top-N страниц,
 * чтобы не раздувать запрос: фильтр по page через dimensionFilterGroups.
 */
async function fetchPageDailySeries(project, range, pages, { rowLimit = 0 } = {}) {
  if (!Array.isArray(pages) || pages.length === 0) return [];
  const { startDate, endDate } = resolveRange(range);
  const accessToken = await getValidAccessToken(project);
  const { rows } = await gsc.querySearchAnalyticsAll(accessToken, project.gsc_site_url, {
    startDate, endDate,
    dimensions: ['page', 'date'],
    dimensionFilterGroups: [{
      filters: pages.map((p) => ({ dimension: 'page', operator: 'equals', expression: p })),
      groupType: 'or',
    }],
  }, { maxRows: rowLimit });
  return (rows || []).map((r) => ({
    page: Array.isArray(r.keys) ? (r.keys[0] || '') : '',
    date: Array.isArray(r.keys) ? (r.keys[1] || '') : '',
    clicks: r.clicks || 0,
    impressions: r.impressions || 0,
    ctr: _round((r.ctr || 0) * 100, 2),
    position: _round(r.position || 0, 2),
  }));
}

/**
 * Срез по запросам с произвольным потолком. Используется для:
 *   • PoP-сравнения (запросы за предыдущий период);
 *   • расчёта бренд/небренд пропорции (нужен весь набор, не только топ).
 * rowLimit=0 (по умолчанию) — без лимита: тянем все запросы постранично.
 */
async function fetchTopQueries(project, range, { rowLimit = 0 } = {}) {
  const { startDate, endDate } = resolveRange(range);
  const accessToken = await getValidAccessToken(project);
  const { rows } = await gsc.querySearchAnalyticsAll(accessToken, project.gsc_site_url, {
    startDate, endDate,
    dimensions: ['query'],
  }, { maxRows: rowLimit });
  return (rows || []).map((r) => ({
    key: Array.isArray(r.keys) ? (r.keys[0] || '') : '',
    clicks: r.clicks || 0,
    impressions: r.impressions || 0,
    ctr: _round((r.ctr || 0) * 100, 2),
    position: _round(r.position || 0, 2),
  }));
}

module.exports = {
  getValidAccessToken,
  resolveRange,
  previousRange,
  fetchPerformanceSeries,
  fetchTopDimensions,
  fetchQueryPageMatrix,
  fetchBreakdown,
  fetchPageDailySeries,
  fetchTopQueries,
};
