'use strict';

/**
 * Лёгкий fetcher сырого HTML для SERP B2B-парсера.
 *
 * Не используем общий services/parser/scraper.js, потому что он применяет
 * Mozilla Readability и удаляет «шум» (footer, address, скрипты с
 * jsonld) — а нам как раз нужен футер (там часто контакты), реквизиты в
 * <address> и tel:/mailto: hrefs. Поэтому здесь — минимальный axios c
 * UA-ротацией, мягким SSL-фоллбеком, ретраями и читаемой ошибкой.
 *
 * Возвращает { url (final), html, status }. На фатальных ошибках бросает
 * Error с .code (timeout|network|http_<code>|ssl|invalid_url).
 */

const axios = require('axios');
const https = require('https');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
];
const pickUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// Insecure-агент — только как fallback при битой цепочке сертификатов
// для публичного скрапинга (никаких чувствительных данных не отправляем).
// codeql[js/disabling-certificate-validation] — осознанный fallback парсера.
// eslint-disable-next-line no-restricted-syntax
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SSL_ERR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_NOT_YET_VALID',
]);

const RETRY_NET_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'ENOTFOUND',
  'EPIPE', 'ECONNREFUSED', 'EHOSTUNREACH', 'EPROTO',
]);

function _classifyAxiosError(err) {
  if (!err) return 'network';
  if (err.code && SSL_ERR_CODES.has(err.code)) return 'ssl';
  if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message || '')) return 'timeout';
  if (err.code && RETRY_NET_CODES.has(err.code)) return 'network';
  if (err.response && err.response.status) {
    const s = err.response.status;
    if (s >= 500 || s === 429) return 'http_retry';
    return `http_${s}`;
  }
  return 'network';
}

function isHttpUrl(url) {
  try {
    const u = new URL(url);
    return /^https?:$/i.test(u.protocol);
  } catch (_) {
    return false;
  }
}

async function _fetchOnce(url, { timeout, insecureSSL }) {
  const headers = {
    'User-Agent': pickUA(),
    'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.7',
    'Accept-Language': 'ru,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
  };
  const res = await axios.get(url, {
    timeout,
    maxRedirects: 5,
    responseType: 'text',
    transformResponse: [(d) => d],
    httpsAgent: insecureSSL ? insecureAgent : undefined,
    validateStatus: (s) => s >= 200 && s < 400,
    headers,
    // Нам нужен только HTML — отсекаем огромные PDF/ZIP-ответы.
    maxContentLength: 8 * 1024 * 1024,
    maxBodyLength: 8 * 1024 * 1024,
  });
  const ct = String(res.headers?.['content-type'] || '').toLowerCase();
  if (ct && !ct.includes('html') && !ct.includes('xml') && !ct.includes('text')) {
    const e = new Error(`unsupported content-type: ${ct}`);
    e.code = 'CONTENT_TYPE';
    throw e;
  }
  return {
    url: res.request?.res?.responseUrl || url,
    html: String(res.data || ''),
    status: res.status,
  };
}

/**
 * Скачивает страницу и возвращает сырой HTML. Делает до 3 попыток
 * (timeout/5xx/429/сеть) и один fallback на insecure-SSL.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeout=20000]
 * @returns {Promise<{ url, html, status }>}
 */
async function fetchPage(url, { timeout = 20000 } = {}) {
  if (!isHttpUrl(url)) {
    const e = new Error(`invalid url: ${url}`);
    e.code = 'invalid_url';
    throw e;
  }
  let sslFallback = false;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await _fetchOnce(url, { timeout, insecureSSL: sslFallback });
    } catch (err) {
      lastErr = err;
      const kind = _classifyAxiosError(err);
      if (kind === 'ssl' && !sslFallback) {
        sslFallback = true;
        continue;
      }
      if (kind !== 'network' && kind !== 'timeout' && kind !== 'http_retry') {
        const e = new Error(`fetch ${url} failed: ${err.message}`);
        e.code = kind;
        throw e;
      }
      if (attempt < 3) {
        const backoff = 500 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 200);
        await sleep(backoff);
      }
    }
  }
  const kind = _classifyAxiosError(lastErr);
  const e = new Error(`fetch ${url} failed: ${lastErr?.message || 'unknown'}`);
  e.code = kind;
  throw e;
}

module.exports = {
  fetchPage,
  isHttpUrl,
};
