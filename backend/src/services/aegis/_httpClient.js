'use strict';

/**
 * aegis/_httpClient — общий внутренний HTTP-клиент для подключения к
 * микросервису aegis_py (FastAPI). Графейс-деградирует: если сервис не
 * настроен (AEGIS_PY_URL пустой) или недоступен — возвращает { ok:false,
 * reason: ... } без выброса исключения. Это критично для опциональности
 * подсистем (GraphRAG, Qdrant, Ray, DSPy включаются постепенно).
 *
 * Использует встроенный http/https, без новых deps (axios уже есть, но
 * для единообразия здесь — нативный модуль).
 */

const http  = require('http');
const https = require('https');
const { URL } = require('url');

function _send(urlStr, { method = 'GET', body = null, headers = {}, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); }
    catch (e) { resolve({ ok: false, reason: 'invalid_url', error: e.message }); return; }
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const payload = body ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8') : null;
    const req = lib.request({
      hostname: u.hostname,
      port:     u.port || (isHttps ? 443 : 80),
      path:     u.pathname + u.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': payload.length } : {}),
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (_e) { /* not json */ }
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        resolve({ ok, status: res.statusCode, body: json, raw, reason: ok ? null : 'http_status' });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error',   (err) => { resolve({ ok: false, reason: 'network', error: err.message }); });
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * post(baseUrl, path, body, opts) — гр. деградация.
 *   - Если baseUrl пустой → { ok:false, reason:'not_configured' }
 *   - Если сервис недоступен → { ok:false, reason:'network', error:'...' }
 */
async function post(baseUrl, p, body, opts = {}) {
  if (!baseUrl) return { ok: false, reason: 'not_configured' };
  return _send(baseUrl.replace(/\/$/, '') + p, { method: 'POST', body, ...opts });
}

async function get(baseUrl, p, opts = {}) {
  if (!baseUrl) return { ok: false, reason: 'not_configured' };
  return _send(baseUrl.replace(/\/$/, '') + p, { method: 'GET', ...opts });
}

module.exports = { post, get };
