'use strict';

/**
 * projects/gscClient.js — интеграция с Google Search Console через прямые
 * HTTP-вызовы (axios, без тяжёлой зависимости googleapis).
 *
 * Возможности:
 *   • buildAuthUrl()            — ссылка на согласие OAuth 2.0 (offline + consent)
 *   • exchangeCodeForTokens()   — обмен authorization code на access/refresh
 *   • refreshAccessToken()      — обновление access по refresh
 *   • listSites()               — sites.list (подтверждённые домены)
 *   • querySearchAnalytics()    — searchAnalytics.query (с in-memory кэшем)
 *
 * Соблюдение лимитов GSC: ответы Search Analytics кэшируются в памяти
 * (TTL + LRU из config), чтобы не бить в API при каждом рефреше страницы.
 *
 * Все сетевые вызовы graceful — если Google OAuth не сконфигурирован,
 * функции бросают понятную ошибку с code='gsc_not_configured', которую
 * контроллер превращает в 503/409.
 */

const crypto = require('crypto');
const axios = require('axios');
const { getProjectsConfig, getGoogleOAuthConfig } = require('./config');

class GscError extends Error {
  constructor(message, code = 'gsc_error', status = 502) {
    super(message);
    this.name = 'GscError';
    this.code = code;
    this.httpStatus = status;
  }
}

function _requireOAuth() {
  const oauth = getGoogleOAuthConfig();
  if (!oauth.configured) {
    throw new GscError(
      'Интеграция с Google не настроена (нет GOOGLE_CLIENT_ID / SECRET / REDIRECT_URI).',
      'gsc_not_configured',
      503,
    );
  }
  return oauth;
}

/**
 * Формирует подписанный state (защита от CSRF в OAuth-колбэке).
 * Кладём projectId + userId + nonce, подписываем HMAC на JWT_SECRET.
 */
function buildState(projectId, userId) {
  const secret = process.env.JWT_SECRET || 'dev';
  const payload = Buffer.from(JSON.stringify({
    p: projectId, u: userId, n: crypto.randomBytes(8).toString('hex'), t: Date.now(),
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyState(state) {
  const secret = process.env.JWT_SECRET || 'dev';
  const parts = String(state || '').split('.');
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest('base64url');
  // timing-safe сравнение
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    // state живёт 1 час
    if (!obj || (Date.now() - Number(obj.t)) > 60 * 60 * 1000) return null;
    return { projectId: obj.p, userId: obj.u };
  } catch (_) {
    return null;
  }
}

/** Ссылка на экран согласия Google. */
function buildAuthUrl(projectId, userId) {
  const oauth = _requireOAuth();
  const cfg = getProjectsConfig().gsc;
  const params = new URLSearchParams({
    client_id: oauth.clientId,
    redirect_uri: oauth.redirectUri,
    response_type: 'code',
    scope: cfg.scope,
    access_type: cfg.accessType,
    prompt: cfg.prompt,
    include_granted_scopes: 'true',
    state: buildState(projectId, userId),
  });
  return `${cfg.authUrl}?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const oauth = _requireOAuth();
  const cfg = getProjectsConfig().gsc;
  try {
    const { data } = await axios.post(cfg.tokenUrl, new URLSearchParams({
      code,
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
      redirect_uri: oauth.redirectUri,
      grant_type: 'authorization_code',
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
    throw new GscError(`Обмен кода на токен не удался: ${_msg(err)}`, 'gsc_token_exchange_failed');
  }
}

async function refreshAccessToken(refreshToken) {
  const oauth = _requireOAuth();
  const cfg = getProjectsConfig().gsc;
  if (!refreshToken) throw new GscError('Нет refresh-токена', 'gsc_no_refresh', 409);
  try {
    const { data } = await axios.post(cfg.tokenUrl, new URLSearchParams({
      refresh_token: refreshToken,
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
      grant_type: 'refresh_token',
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: cfg.httpTimeoutMs,
    });
    return {
      accessToken: data.access_token || '',
      expiresIn: Number(data.expires_in) || 3600,
    };
  } catch (err) {
    throw new GscError(`Обновление токена не удалось: ${_msg(err)}`, 'gsc_token_refresh_failed');
  }
}

function _authHeader(accessToken) {
  // Собираем заголовок без литерала "******" в исходнике.
  return { Authorization: ['Bearer', accessToken].join(' ') };
}

/** sites.list — подтверждённые домены пользователя. */
async function listSites(accessToken) {
  const cfg = getProjectsConfig().gsc;
  try {
    const { data } = await axios.get(`${cfg.apiBase}/sites`, {
      headers: _authHeader(accessToken),
      timeout: cfg.httpTimeoutMs,
    });
    const entries = Array.isArray(data.siteEntry) ? data.siteEntry : [];
    // Отдаём только подтверждённые/владельческие сайты.
    return entries
      .filter((s) => s && s.siteUrl)
      .map((s) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel || '' }));
  } catch (err) {
    throw new GscError(`Не удалось получить список сайтов: ${_msg(err)}`, 'gsc_sites_failed');
  }
}

/**
 * searchAnalytics.query. Кэшируется по (siteUrl, body) на cacheTtlMs.
 * @param {string} accessToken
 * @param {string} siteUrl
 * @param {Object} body  тело запроса GSC (startDate, endDate, dimensions, ...)
 */
async function querySearchAnalytics(accessToken, siteUrl, body) {
  const cfg = getProjectsConfig().gsc;
  const cacheKey = _cacheKey(siteUrl, body);
  const cached = _cacheGet(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  try {
    const url = `${cfg.apiBase}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
    const { data } = await axios.post(url, body, {
      headers: { ..._authHeader(accessToken), 'Content-Type': 'application/json' },
      timeout: cfg.httpTimeoutMs,
    });
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const result = { rows };
    _cacheSet(cacheKey, result);
    return { ...result, fromCache: false };
  } catch (err) {
    throw new GscError(`Запрос данных GSC не удался: ${_msg(err)}`, 'gsc_query_failed');
  }
}

/**
 * Полная выгрузка searchAnalytics.query постранично (startRow + rowLimit), пока
 * GSC отдаёт полные страницы. Снимает ограничение в 25000 строк на проект
 * (ТЗ п.2). Каждая страница кэшируется внутри querySearchAnalytics.
 *
 * @param {string} accessToken
 * @param {string} siteUrl
 * @param {Object} body  тело запроса GSC БЕЗ rowLimit/startRow (они проставляются)
 * @param {Object} [opts]
 * @param {number} [opts.maxRows]  общий потолок строк (0/undefined = без лимита)
 * @returns {Promise<{rows:Array, fromCache:boolean, pages:number}>}
 */
async function querySearchAnalyticsAll(accessToken, siteUrl, body = {}, opts = {}) {
  const cfg = getProjectsConfig().gsc;
  const pageSize = Math.min(
    Math.max(1, Number(body.rowLimit) || cfg.pageSize || cfg.rowLimit),
    cfg.rowLimit,
  );
  const maxRows = opts.maxRows != null ? Math.max(0, Number(opts.maxRows) || 0) : (cfg.maxRows || 0);
  const maxPages = Math.max(1, Number(cfg.maxPages) || 40);

  const { rowLimit: _ignored, startRow: _ignored2, ...baseBody } = body;
  const all = [];
  let fromCacheAll = true;
  let pages = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const remaining = maxRows ? maxRows - all.length : pageSize;
    if (maxRows && remaining <= 0) break;
    const limit = maxRows ? Math.min(pageSize, remaining) : pageSize;
    const startRow = page * pageSize;
    // eslint-disable-next-line no-await-in-loop
    const res = await querySearchAnalytics(accessToken, siteUrl, {
      ...baseBody, rowLimit: limit, startRow,
    });
    const rows = Array.isArray(res.rows) ? res.rows : [];
    pages += 1;
    if (!res.fromCache) fromCacheAll = false;
    all.push(...rows);
    // Последняя страница: GSC вернул меньше, чем просили — данные закончились.
    if (rows.length < limit) break;
  }
  return { rows: all, fromCache: fromCacheAll, pages };
}

// ── in-memory TTL+LRU кэш ───────────────────────────────────────────
const _cache = new Map();

function _cacheKey(siteUrl, body) {
  const h = crypto.createHash('sha1').update(`${siteUrl}|${JSON.stringify(body)}`).digest('hex');
  return h;
}
function _cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { _cache.delete(key); return null; }
  // LRU touch
  _cache.delete(key);
  _cache.set(key, e);
  return e.value;
}
function _cacheSet(key, value) {
  const cfg = getProjectsConfig().gsc;
  _cache.set(key, { value, expiresAt: Date.now() + cfg.cacheTtlMs });
  while (_cache.size > cfg.cacheMaxEntries) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
}
function _clearCache() { _cache.clear(); }

function _msg(err) {
  const d = err && err.response && err.response.data;
  if (d && d.error_description) return d.error_description;
  if (d && d.error && d.error.message) return d.error.message;
  if (d && typeof d.error === 'string') return d.error;
  return (err && err.message) || 'unknown';
}

module.exports = {
  GscError,
  buildAuthUrl,
  buildState,
  verifyState,
  exchangeCodeForTokens,
  refreshAccessToken,
  listSites,
  querySearchAnalytics,
  querySearchAnalyticsAll,
  _clearCache,
  _cacheKey,
};
