'use strict';

/**
 * projects/ydxService.js — высокоуровневый слой над ydxClient: управление
 * токенами проекта (расшифровка, авто-обновление access по refresh с
 * сохранением в БД в зашифрованном виде) и сбор данных Яндекс.Вебмастера для
 * дашборда и сопоставления с Google Search Console.
 *
 * Полный аналог gscService.js, но с учётом особенностей Webmaster API:
 *   • для запросов нужен числовой user_id (/user/) и host_id выбранного сайта;
 *   • посуточная история отдаёт только показы/клики (позиция — из топ-запросов);
 *   • индикаторы: TOTAL_SHOWS (показы≈impressions), TOTAL_CLICKS (клики),
 *     AVG_SHOW_POSITION (средняя позиция показа).
 */

const db = require('../../config/db');
const ydx = require('./ydxClient');
const { encryptToken, decryptToken } = require('./tokenCrypto');
const { getProjectsConfig } = require('./config');

/**
 * Возвращает валидный access-токен для проекта, при необходимости обновляя
 * его через refresh и сохраняя новый зашифрованный токен + expiry в БД.
 */
async function getValidAccessToken(project) {
  if (!project || !project.ydx_connected) {
    throw new ydx.YdxError('Проект не подключён к Яндекс.Вебмастеру', 'ydx_not_connected', 409);
  }
  const expiry = project.ydx_token_expiry ? new Date(project.ydx_token_expiry).getTime() : 0;
  const now = Date.now();
  if (project.ydx_access_token_enc && expiry - 60_000 > now) {
    return decryptToken(project.ydx_access_token_enc);
  }
  const refresh = project.ydx_refresh_token_enc ? decryptToken(project.ydx_refresh_token_enc) : '';
  const refreshed = await ydx.refreshAccessToken(refresh);
  const newExpiry = new Date(Date.now() + refreshed.expiresIn * 1000);
  // refresh_token у Яндекса при обновлении может прийти новый — не затираем null'ом.
  const newRefreshEnc = refreshed.refreshToken
    ? encryptToken(refreshed.refreshToken)
    : project.ydx_refresh_token_enc;
  await db.query(
    `UPDATE projects
        SET ydx_access_token_enc = $2, ydx_refresh_token_enc = $3,
            ydx_token_expiry = $4, updated_at = NOW()
      WHERE id = $1`,
    [project.id, encryptToken(refreshed.accessToken), newRefreshEnc, newExpiry],
  );
  return refreshed.accessToken;
}

/** host_id выбранного сайта проекта (из сохранённого ydx_available_sites). */
function _resolveHostId(project) {
  const sites = Array.isArray(project.ydx_available_sites) ? project.ydx_available_sites : [];
  const match = sites.find((s) => s && s.siteUrl === project.ydx_site_url);
  return (match && match.hostId) || project.ydx_site_url || '';
}

/** Контекст для вызовов Webmaster API: accessToken + userId + hostId. */
async function _resolveContext(project) {
  const accessToken = await getValidAccessToken(project);
  const userId = await ydx.getUserId(accessToken);
  const hostId = _resolveHostId(project);
  if (!hostId) throw new ydx.YdxError('Не выбран сайт Яндекс.Вебмастера', 'ydx_no_host', 409);
  return { accessToken, userId, hostId };
}

function _isoDate(d) { return d.toISOString().slice(0, 10); }

/** Диапазон дат из пресета (days) или кастомный {from,to}. */
function resolveRange({ days, from, to } = {}) {
  if (from && to) return { startDate: from, endDate: to };
  const cfg = getProjectsConfig().ydx;
  const n = Number(days) || 28;
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - cfg.lagDays);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (n - 1));
  return { startDate: _isoDate(start), endDate: _isoDate(end) };
}

function _round(n, p = 2) {
  const f = Math.pow(10, p);
  return Math.round((Number(n) || 0) * f) / f;
}

/** Достаёт числовое значение индикатора из строки Webmaster API. */
function _indicator(row, name) {
  if (!row) return 0;
  const ind = row.indicators || {};
  const v = ind[name];
  if (v == null) return 0;
  // Webmaster может вернуть число или массив точек {date,value} — берём сумму.
  if (Array.isArray(v)) return v.reduce((s, p) => s + (Number(p && p.value) || 0), 0);
  return Number(v) || 0;
}

/** История показателей в массив точек {date,value}. */
function _historySeries(indicators, name) {
  const arr = indicators && indicators[name];
  if (!Array.isArray(arr)) return [];
  return arr.map((p) => ({ date: p && p.date, value: Number(p && p.value) || 0 }));
}

/**
 * Данные для графика эффективности Яндекс.Вебмастера: посуточная динамика
 * показов, кликов и средней позиции + суммарные тоталы (CTR — производная).
 * Метрики раздельные (как в GSC): показы, клики, CTR, средняя позиция.
 */
async function fetchPerformanceSeries(project, range) {
  const cfg = getProjectsConfig().ydx;
  const { startDate, endDate } = resolveRange(range);
  const { accessToken, userId, hostId } = await _resolveContext(project);

  const indicators = await ydx.queryHistory(accessToken, userId, hostId, {
    dateFrom: startDate, dateTo: endDate,
    indicators: [cfg.indicators.shows, cfg.indicators.clicks, cfg.indicators.position],
  });
  const shows = _historySeries(indicators, cfg.indicators.shows);
  const clicks = _historySeries(indicators, cfg.indicators.clicks);
  const positions = _historySeries(indicators, cfg.indicators.position);
  const clicksByDate = new Map(clicks.map((p) => [p.date, p.value]));
  const posByDate = new Map(positions.map((p) => [p.date, p.value]));
  const series = shows.map((p) => {
    const c = clicksByDate.get(p.date) || 0;
    return {
      date: p.date,
      clicks: c,
      impressions: p.value,
      ctr: p.value ? _round((c / p.value) * 100, 2) : 0,
      position: _round(posByDate.get(p.date) || 0, 2),
    };
  });
  const totalClicks = series.reduce((s, p) => s + p.clicks, 0);
  const totalImpr = series.reduce((s, p) => s + p.impressions, 0);
  const avgCtr = totalImpr ? _round((totalClicks / totalImpr) * 100, 2) : 0;

  // Средняя позиция за период — взвешенно по показам из посуточного ряда.
  let posW = 0;
  let posN = 0;
  for (const p of series) {
    if (p.position > 0) { const w = p.impressions || 1; posW += p.position * w; posN += w; }
  }
  let avgPos = posN ? _round(posW / posN, 2) : 0;
  // Фолбэк: если история не отдала позицию — берём её из топ-запросов.
  if (!avgPos) {
    try {
      const top = await fetchTopQueries(project, range, { ctx: { accessToken, userId, hostId } });
      const wSum = top.reduce((s, q) => s + q.impressions, 0);
      if (wSum) {
        avgPos = _round(top.reduce((s, q) => s + q.position * q.impressions, 0) / wSum, 2);
      }
    } catch (_) { /* позиция опциональна */ }
  }

  return {
    source: 'yandex',
    range: { startDate, endDate },
    series,
    totals: { clicks: totalClicks, impressions: totalImpr, ctr: avgCtr, position: avgPos },
    fromCache: false,
  };
}

/**
 * Топ поисковых запросов за период — нормализуем к тому же формату, что и
 * gscService.fetchTopDimensions().topQueries: {key, clicks, impressions, ctr, position}.
 * По умолчанию тянем ВСЕ запросы периода постранично (без лимита). Передача
 * rowLimit ограничивает выборку одной страницей нужного размера.
 */
async function fetchTopQueries(project, range, { rowLimit, ctx } = {}) {
  const cfg = getProjectsConfig().ydx;
  const { startDate, endDate } = resolveRange(range);
  const c = ctx || await _resolveContext(project);
  const indicators = [cfg.indicators.shows, cfg.indicators.clicks, cfg.indicators.position];
  const rows = rowLimit
    ? await ydx.queryPopular(c.accessToken, c.userId, c.hostId, {
      dateFrom: startDate, dateTo: endDate, indicators, limit: rowLimit,
    })
    : await ydx.queryPopularAll(c.accessToken, c.userId, c.hostId, {
      dateFrom: startDate, dateTo: endDate, indicators,
    });
  return (rows || []).map((r) => {
    const impressions = _indicator(r, cfg.indicators.shows);
    const clicks = _indicator(r, cfg.indicators.clicks);
    return {
      key: r.query_text || r.text || r.query || '',
      clicks,
      impressions,
      ctr: impressions ? _round((clicks / impressions) * 100, 2) : 0,
      position: _round(_indicator(r, cfg.indicators.position), 2),
    };
  });
}

/** Топ-запросы + (плейсхолдер) топ-страницы — симметрично gscService.fetchTopDimensions. */
async function fetchTopDimensions(project, range) {
  // Webmaster API не отдаёт срез по страницам через тот же эндпоинт, что и GSC,
  // поэтому topPages остаётся пустым — дашборд/сравнение опираются на запросы.
  const topQueries = await fetchTopQueries(project, range);
  return { topQueries, topPages: [] };
}

module.exports = {
  getValidAccessToken,
  resolveRange,
  fetchPerformanceSeries,
  fetchTopQueries,
  fetchTopDimensions,
  _resolveHostId,
};
