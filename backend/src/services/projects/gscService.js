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
const { getProjectsConfig } = require('./config');

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

function _round(n, p = 2) {
  const f = Math.pow(10, p);
  return Math.round((Number(n) || 0) * f) / f;
}

/**
 * Данные для графика эффективности: помесячная/посуточная динамика 4 метрик
 * (clicks, impressions, ctr, position) + суммарные тоталы за период.
 */
async function fetchPerformanceSeries(project, range) {
  const cfg = getProjectsConfig().gsc;
  const { startDate, endDate } = resolveRange(range);
  const accessToken = await getValidAccessToken(project);
  const { rows, fromCache } = await gsc.querySearchAnalytics(accessToken, project.gsc_site_url, {
    startDate, endDate,
    dimensions: ['date'],
    rowLimit: cfg.rowLimit,
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
async function fetchTopDimensions(project, range) {
  const cfg = getProjectsConfig();
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
    gsc.querySearchAnalytics(accessToken, project.gsc_site_url, {
      startDate, endDate, dimensions: ['query'], rowLimit: cfg.deepseek.topQueries,
    }),
    gsc.querySearchAnalytics(accessToken, project.gsc_site_url, {
      startDate, endDate, dimensions: ['page'], rowLimit: cfg.deepseek.topPages,
    }),
  ]);
  return {
    topQueries: (q.rows || []).map(mapRow),
    topPages: (p.rows || []).map(mapRow),
  };
}

module.exports = {
  getValidAccessToken,
  resolveRange,
  fetchPerformanceSeries,
  fetchTopDimensions,
};
