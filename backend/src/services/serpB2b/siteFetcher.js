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
 * Anti-bot / SPA эскалация: если сайт закрыт WAF-заглушкой (Cloudflare /
 * DDoS-Guard / Qrator), вернул 403/429, либо отдал «пустой» SPA-шелл без
 * текста — прозрачно эскалируем через Python-сервис relevance_fetcher
 * (POST /fetch_html): Mode A curl_cffi (TLS-impersonation) с
 * auto-эскалацией в Mode B Playwright+stealth (JS-рендеринг). Сервис
 * настраивается через RELEVANCE_HEADLESS_FETCHER_URL (+ опционально
 * RELEVANCE_INTERNAL_TOKEN) — те же env, что у relevance/pageFetcher.
 *
 * Возвращает { url (final), html, status, engine }. На фатальных ошибках
 * бросает Error с .code (timeout|network|http_<code>|ssl|invalid_url).
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

// ── Anti-bot эскалация через relevance_fetcher (Python) ─────────────

// URL /fetch_html выводится из RELEVANCE_HEADLESS_FETCHER_URL (обычно
// http://relevance_fetcher:8001/fetch) — тот же приём, что в
// relevance/pageFetcher.js. Пусто, если сервис не настроен.
function _resolveFetchHtmlUrl(rawUrl) {
  const raw = String(rawUrl || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (/\/fetch_html\/?$/.test(u.pathname)) return u.toString();
    u.pathname = u.pathname.replace(/\/fetch\/?$/, '/fetch_html');
    if (!/\/fetch_html\/?$/.test(u.pathname)) {
      u.pathname = `${u.pathname.replace(/\/$/, '')}/fetch_html`;
    }
    return u.toString();
  } catch (_) {
    return '';
  }
}

const FETCH_HTML_URL = _resolveFetchHtmlUrl(process.env.RELEVANCE_HEADLESS_FETCHER_URL);
const INTERNAL_TOKEN = (process.env.RELEVANCE_INTERNAL_TOKEN || '').trim();

// Kill-switch: SERP_B2B_ANTIBOT_ESCALATION=false отключает эскалацию.
const ESCALATION_ENABLED = !!FETCH_HTML_URL
  && !['0', 'false', 'no', 'off'].includes(
    String(process.env.SERP_B2B_ANTIBOT_ESCALATION || '').trim().toLowerCase(),
  );

// Сигнатуры WAF-заглушек (Cloudflare / Qrator / DDoS-Guard / Imperva и пр.)
// — даже при 200 OK такой HTML бесполезен, реальный контент за челленджем.
const WAF_HTML_MARKERS = [
  '__cf_chl_', 'cf-browser-verification', 'just a moment', 'cdn-cgi/challenge-platform',
  'checking your browser', 'qrator.net', '_qrtj', 'ddos-guard', 'sucuri_cloudproxy',
  '_incapsula_resource', 'powered by imperva', 'проверка вашего браузера',
  'подтвердите, что вы не робот', 'доступ ограничен', 'captcha',
];

// Минимум видимого текста, ниже которого страница считается SPA-шеллом
// (у настоящих B2B-главных текст всегда сильно больше).
const SPA_TEXT_THRESHOLD = parseInt(process.env.SERP_B2B_SPA_THRESHOLD, 10) || 350;

/** true, если HTML — WAF/captcha-заглушка. */
function looksBlockedHtml(html) {
  if (!html) return false;
  const snippet = String(html).slice(0, 6000).toLowerCase();
  return WAF_HTML_MARKERS.some((m) => snippet.includes(m));
}

/** true, если HTML — пустой SPA-шелл без видимого текста (нужен JS-рендер). */
function looksEmptyHtml(html) {
  if (!html) return true;
  const text = String(html)
    .replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\b[^>]*>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length < SPA_TEXT_THRESHOLD;
}

/** Коды ошибок axios-пути, при которых имеет смысл эскалация в антибот. */
function _shouldEscalateOnError(code) {
  return code === 'http_403' || code === 'http_429' || code === 'http_retry'
    || code === 'timeout' || code === 'network';
}

/**
 * Эскалация через relevance_fetcher /fetch_html. Один вызов: Mode A
 * (curl_cffi TLS-impersonation) с auto_escalate → Mode B (Playwright).
 * @returns {Promise<{url,html,status,engine}|null>} null — если недоступен/не помог.
 */
async function _fetchViaAntibot(url, { timeout, jsRender = false } = {}) {
  if (!ESCALATION_ENABLED) return null;
  const headers = { 'Content-Type': 'application/json' };
  if (INTERNAL_TOKEN) headers['X-Internal-Token'] = INTERNAL_TOKEN;
  try {
    const res = await axios.post(FETCH_HTML_URL, {
      url,
      use_js_render: jsRender,
      auto_escalate: true,
      timeout_ms: Math.min(60000, Math.max(5000, timeout || 20000)),
    }, {
      headers,
      // Общий бюджет: попытки Mode A + auto-эскалация Mode B на стороне Python.
      timeout: Math.min(120000, (timeout || 20000) * 4),
      maxContentLength: 16 * 1024 * 1024,
      maxBodyLength: 1024 * 1024,
    });
    const body = res.data || {};
    if (!body.success || !body.html) return null;
    return {
      url: body.url || url,
      html: String(body.html),
      status: Number(body.status_code) || 200,
      engine: body.engine_used || 'antibot',
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[serpB2b] antibot fetch failed (${url}): ${err.message}`);
    return null;
  }
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
 * (timeout/5xx/429/сеть) и один fallback на insecure-SSL. Если axios-путь
 * не сработал (403/429/сеть/timeout) либо вернул WAF-заглушку / пустой
 * SPA-шелл — эскалирует через relevance_fetcher (curl_cffi → Playwright).
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeout=20000]
 * @returns {Promise<{ url, html, status, engine }>}
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
      const res = await _fetchOnce(url, { timeout, insecureSSL: sslFallback });
      // Успешный HTTP-ответ, но контент за WAF-челленджем или пустой
      // SPA-шелл — реальный HTML достаём через антибот-fetcher.
      if (looksBlockedHtml(res.html) || looksEmptyHtml(res.html)) {
        const jsRender = !looksBlockedHtml(res.html); // пустой шелл ⇒ сразу JS-рендер
        const esc = await _fetchViaAntibot(url, { timeout, jsRender });
        if (esc && !looksBlockedHtml(esc.html)) return esc;
      }
      return { ...res, engine: 'axios' };
    } catch (err) {
      lastErr = err;
      const kind = _classifyAxiosError(err);
      if (kind === 'ssl' && !sslFallback) {
        sslFallback = true;
        continue;
      }
      if (kind !== 'network' && kind !== 'timeout' && kind !== 'http_retry') {
        // Фатальный HTTP-код: 403/429 часто означает антибот — эскалируем.
        if (_shouldEscalateOnError(kind)) {
          const esc = await _fetchViaAntibot(url, { timeout });
          if (esc) return esc;
        }
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
  // Все axios-попытки исчерпаны — последний шанс через антибот-fetcher.
  const kind = _classifyAxiosError(lastErr);
  if (_shouldEscalateOnError(kind)) {
    const esc = await _fetchViaAntibot(url, { timeout });
    if (esc) return esc;
  }
  const e = new Error(`fetch ${url} failed: ${lastErr?.message || 'unknown'}`);
  e.code = kind;
  throw e;
}

module.exports = {
  fetchPage,
  isHttpUrl,
  // exposed for tests / диагностики
  looksBlockedHtml,
  looksEmptyHtml,
  _resolveFetchHtmlUrl,
  _shouldEscalateOnError,
};
