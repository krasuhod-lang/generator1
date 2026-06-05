'use strict';

/**
 * projects/ydxClient.js — интеграция с Яндекс.Вебмастером (Webmaster API v4)
 * через прямые HTTP-вызовы (axios). Полный аналог gscClient.js для Google.
 *
 * Возможности:
 *   • buildAuthUrl()            — ссылка на экран согласия Яндекс ID (OAuth 2.0)
 *   • exchangeCodeForTokens()   — обмен authorization code на access/refresh
 *   • refreshAccessToken()      — обновление access по refresh
 *   • getUserId()               — /user/ → числовой user_id Вебмастера
 *   • listHosts()               — /user/{uid}/hosts/ (подтверждённые сайты)
 *   • queryPopular()            — топ поисковых запросов (показы/клики/позиция)
 *   • queryHistory()            — посуточная история показов/кликов
 *
 * OAuth state (CSRF-защита) переиспользуется из gscClient — формат единый
 * (подписанный HMAC payload с projectId+userId+nonce), чтобы не плодить копии.
 *
 * Все сетевые вызовы graceful: если Yandex OAuth не сконфигурирован, функции
 * бросают понятную ошибку с code='ydx_not_configured', которую контроллер
 * превращает в 503/409. Заголовок авторизации Яндекса использует схему
 * «OAuth <token>» (не «Bearer»).
 */

const crypto = require('crypto');
const axios = require('axios');
const { getProjectsConfig, getYandexOAuthConfig } = require('./config');
const { buildState, verifyState } = require('./gscClient');

class YdxError extends Error {
  constructor(message, code = 'ydx_error', status = 502) {
    super(message);
    this.name = 'YdxError';
    this.code = code;
    this.httpStatus = status;
  }
}

function _requireOAuth() {
  const oauth = getYandexOAuthConfig();
  if (!oauth.configured) {
    throw new YdxError(
      'Интеграция с Яндекс.Вебмастером не настроена (нет YANDEX_CLIENT_ID / SECRET / REDIRECT_URI).',
      'ydx_not_configured',
      503,
    );
  }
  return oauth;
}

/** Ссылка на экран согласия Яндекс ID. */
function buildAuthUrl(projectId, userId) {
  const oauth = _requireOAuth();
  const cfg = getProjectsConfig().ydx;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: oauth.clientId,
    redirect_uri: oauth.redirectUri,
    scope: cfg.scope,
    force_confirm: 'yes',
    state: buildState(projectId, userId),
  });
  return `${cfg.authUrl}?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const oauth = _requireOAuth();
  const cfg = getProjectsConfig().ydx;
  try {
    const { data } = await axios.post(cfg.tokenUrl, new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
      redirect_uri: oauth.redirectUri,
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: cfg.httpTimeoutMs,
    });
    return {
      accessToken: data.access_token || '',
      refreshToken: data.refresh_token || '',
      expiresIn: Number(data.expires_in) || 3600,
      scope: data.scope || '',
    };
  } catch (err) {
    throw new YdxError(`Обмен кода на токен не удался: ${_msg(err)}`, 'ydx_token_exchange_failed');
  }
}

async function refreshAccessToken(refreshToken) {
  const oauth = _requireOAuth();
  const cfg = getProjectsConfig().ydx;
  if (!refreshToken) throw new YdxError('Нет refresh-токена', 'ydx_no_refresh', 409);
  try {
    const { data } = await axios.post(cfg.tokenUrl, new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: cfg.httpTimeoutMs,
    });
    return {
      accessToken: data.access_token || '',
      refreshToken: data.refresh_token || '',
      expiresIn: Number(data.expires_in) || 3600,
    };
  } catch (err) {
    throw new YdxError(`Обновление токена не удалось: ${_msg(err)}`, 'ydx_token_refresh_failed');
  }
}

function _authHeader(accessToken) {
  // Яндекс использует схему «OAuth <token>». Собираем без литерала в исходнике.
  return { Authorization: ['OAuth', accessToken].join(' ') };
}

/** /user/ → числовой идентификатор пользователя Вебмастера. */
async function getUserId(accessToken) {
  const cfg = getProjectsConfig().ydx;
  try {
    const { data } = await axios.get(`${cfg.apiBase}/user/`, {
      headers: _authHeader(accessToken),
      timeout: cfg.httpTimeoutMs,
    });
    const uid = data && (data.user_id != null ? data.user_id : data.userId);
    if (uid == null) throw new YdxError('Webmaster API не вернул user_id', 'ydx_no_user_id');
    return String(uid);
  } catch (err) {
    if (err instanceof YdxError) throw err;
    throw new YdxError(`Не удалось получить user_id: ${_msg(err)}`, 'ydx_user_failed');
  }
}

/**
 * /user/{uid}/hosts/ — подтверждённые сайты пользователя. Нормализуем в
 * формат, симметричный gsc.listSites: {siteUrl, hostId, verified}.
 */
async function listHosts(accessToken, userId) {
  const cfg = getProjectsConfig().ydx;
  try {
    const { data } = await axios.get(`${cfg.apiBase}/user/${encodeURIComponent(userId)}/hosts/`, {
      headers: _authHeader(accessToken),
      timeout: cfg.httpTimeoutMs,
    });
    const hosts = Array.isArray(data && data.hosts) ? data.hosts : [];
    return hosts
      .filter((h) => h && (h.host_id || h.unicode_host_url || h.ascii_host_url))
      .map((h) => ({
        siteUrl: h.unicode_host_url || h.ascii_host_url || h.host_id,
        hostId: h.host_id || '',
        verified: Boolean(h.verified),
      }));
  } catch (err) {
    throw new YdxError(`Не удалось получить список сайтов: ${_msg(err)}`, 'ydx_hosts_failed');
  }
}

/**
 * Популярные поисковые запросы за период. Возвращает «сырой» массив строк
 * Webmaster API ({query_text|text, indicators:{...}}). Кэшируется.
 * Поддерживает постраничную выборку через offset (см. queryPopularAll).
 */
async function queryPopular(accessToken, userId, hostId, { dateFrom, dateTo, indicators, limit, offset } = {}) {
  const cfg = getProjectsConfig().ydx;
  const params = new URLSearchParams();
  params.set('order_by', cfg.indicators.shows);
  (indicators || [cfg.indicators.shows, cfg.indicators.clicks, cfg.indicators.position])
    .forEach((ind) => params.append('query_indicator', ind));
  if (dateFrom) params.set('date_from', dateFrom);
  if (dateTo) params.set('date_to', dateTo);
  if (limit) params.set('limit', String(limit));
  if (offset) params.set('offset', String(offset));
  const url = `${cfg.apiBase}/user/${encodeURIComponent(userId)}/hosts/${encodeURIComponent(hostId)}/search-queries/popular/?${params.toString()}`;
  return _getCached(url, accessToken, 'ydx_popular_failed', (data) =>
    (Array.isArray(data && data.queries) ? data.queries : []));
}

/**
 * Все популярные запросы периода — постранично, без лимита. Перебираем offset
 * страницами по cfg.pageSize, пока страница «полная», уважая cfg.maxRows
 * (0 = без лимита) и cfg.maxPages (страховка от бесконечного цикла).
 */
async function queryPopularAll(accessToken, userId, hostId, { dateFrom, dateTo, indicators } = {}) {
  const cfg = getProjectsConfig().ydx;
  const pageSize = Math.max(1, Number(cfg.pageSize) || 500);
  const maxRows = Math.max(0, Number(cfg.maxRows) || 0); // 0 = без лимита
  const maxPages = Math.max(1, Number(cfg.maxPages) || 500);
  const all = [];
  for (let page = 0; page < maxPages; page += 1) {
    const remaining = maxRows ? maxRows - all.length : pageSize;
    if (maxRows && remaining <= 0) break;
    const limit = maxRows ? Math.min(pageSize, remaining) : pageSize;
    // eslint-disable-next-line no-await-in-loop
    const rows = await queryPopular(accessToken, userId, hostId, {
      dateFrom, dateTo, indicators, limit, offset: page * pageSize,
    });
    if (!rows.length) break;
    all.push(...rows);
    if (rows.length < limit) break; // последняя (неполная) страница
  }
  return all;
}

/**
 * Посуточная история показов/кликов по сайту в целом (для графика
 * эффективности). Возвращает объект indicators: { TOTAL_SHOWS:[{date,value}], ... }.
 */
async function queryHistory(accessToken, userId, hostId, { dateFrom, dateTo, indicators } = {}) {
  const cfg = getProjectsConfig().ydx;
  const params = new URLSearchParams();
  (indicators || [cfg.indicators.shows, cfg.indicators.clicks])
    .forEach((ind) => params.append('query_indicator', ind));
  if (dateFrom) params.set('date_from', dateFrom);
  if (dateTo) params.set('date_to', dateTo);
  const url = `${cfg.apiBase}/user/${encodeURIComponent(userId)}/hosts/${encodeURIComponent(hostId)}/search-queries/all/history/?${params.toString()}`;
  return _getCached(url, accessToken, 'ydx_history_failed', (data) =>
    (data && typeof data.indicators === 'object' && data.indicators) || {});
}

// ── in-memory TTL+LRU кэш (как в gscClient) ─────────────────────────
const _cache = new Map();

function _cacheKey(url) {
  return crypto.createHash('sha256').update(String(url)).digest('hex');
}
function _cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { _cache.delete(key); return null; }
  _cache.delete(key);
  _cache.set(key, e);
  return e.value;
}
function _cacheSet(key, value) {
  const cfg = getProjectsConfig().ydx;
  _cache.set(key, { value, expiresAt: Date.now() + cfg.cacheTtlMs });
  while (_cache.size > cfg.cacheMaxEntries) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
}
function _clearCache() { _cache.clear(); }

async function _getCached(url, accessToken, errCode, pick) {
  const cfg = getProjectsConfig().ydx;
  const key = _cacheKey(url);
  const cached = _cacheGet(key);
  if (cached !== null && cached !== undefined) return cached;
  try {
    const { data } = await axios.get(url, {
      headers: _authHeader(accessToken),
      timeout: cfg.httpTimeoutMs,
    });
    const value = pick(data);
    _cacheSet(key, value);
    return value;
  } catch (err) {
    throw new YdxError(`Запрос данных Яндекс.Вебмастера не удался: ${_msg(err)}`, errCode);
  }
}

function _msg(err) {
  const d = err && err.response && err.response.data;
  if (d && d.error_description) return d.error_description;
  if (d && d.error && d.error.message) return d.error.message;
  if (d && d.message) return d.message;
  if (d && typeof d.error === 'string') return d.error;
  return (err && err.message) || 'unknown';
}

module.exports = {
  YdxError,
  buildAuthUrl,
  buildState,
  verifyState,
  exchangeCodeForTokens,
  refreshAccessToken,
  getUserId,
  listHosts,
  queryPopular,
  queryPopularAll,
  queryHistory,
  _clearCache,
  _cacheKey,
};
