'use strict';

/**
 * pageFetcher — параллельная загрузка HTML страниц ТОП-20.
 *
 * Главные правила:
 *   • реальный браузерный User-Agent (некоторые сайты режут axios/default
 *     или дефолтные строки SEO-ботов);
 *   • расширенный Accept (+image/webp,*\/*; q=0.8) — современные сайты часто
 *     отдают 406, если видеть только text/html;
 *   • строгий лимит на размер ответа (RELEVANCE_MAX_HTML_BYTES, дефолт 16 МБ);
 *   • per-URL таймаут (RELEVANCE_FETCH_TIMEOUT_MS, дефолт 25 с);
 *   • ограниченный параллелизм (RELEVANCE_FETCH_CONCURRENCY, дефолт 6);
 *   • повтор с альтернативным User-Agent (Googlebot) при 403/429/503/таймауте —
 *     это закрывает большинство «непарсимых» сайтов с базовой WAF-защитой;
 *   • любая ошибка по конкретному URL не валит весь пайплайн — URL уходит в
 *     failed_urls с текстом ошибки.
 *
 * Возвращает { successes: [{url, html}], failures: [{url, error}] }.
 */

const axios = require('axios');

// Реальный современный Chrome — большинство сайтов отдают полную HTML-версию.
const PRIMARY_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Fallback для «WAF-защищённых» сайтов: Googlebot обычно пропускают в обход
// антибот-фильтров, чтобы не вылетать из выдачи Яндекса/Google.
const FALLBACK_USER_AGENT =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

const FETCH_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.RELEVANCE_FETCH_TIMEOUT_MS, 10);
  return Number.isFinite(v) && v >= 1000 && v <= 120000 ? v : 25000;
})();

const FETCH_CONCURRENCY = (() => {
  const v = parseInt(process.env.RELEVANCE_FETCH_CONCURRENCY, 10);
  return Number.isFinite(v) && v >= 1 && v <= 20 ? v : 6;
})();

const MAX_HTML_BYTES = (() => {
  const v = parseInt(process.env.RELEVANCE_MAX_HTML_BYTES, 10);
  // 16 MB по умолчанию — редкие тяжёлые SPA с инлайн-данными тоже влезут;
  // поднимаем с прежних 4 МБ, потому что нам важно собрать «100% контента».
  return Number.isFinite(v) && v >= 65536 ? v : 16 * 1024 * 1024;
})();

// Статус-коды и сетевые коды ошибок, при которых имеет смысл повторить
// запрос с альтернативным User-Agent.
const RETRY_STATUS_CODES = new Set([403, 408, 425, 429, 500, 502, 503, 504, 522, 524]);
const RETRY_ERROR_CODES  = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED',
  'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH',
]);

/** Ограниченно-параллельный map: запускает не более `limit` задач одновременно. */
async function pMap(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

function _buildHeaders(userAgent) {
  return {
    'User-Agent':      userAgent,
    // Принимаем и html, и xml, и любой mime — некоторые сайты неправильно
    // ставят Content-Type, но по сути отдают html. */*;q=0.8 закрывает дыру.
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.7,en;q=0.6',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control':   'no-cache',
    'Pragma':          'no-cache',
    // Имитируем «прямой переход» — некоторые сайты блочат пустой Referer.
    'Referer':         'https://yandex.ru/',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest':  'document',
    'Sec-Fetch-Mode':  'navigate',
    'Sec-Fetch-Site':  'cross-site',
    'Sec-Fetch-User':  '?1',
  };
}

async function _doFetch(url, userAgent) {
  return axios.get(url, {
    timeout: FETCH_TIMEOUT_MS,
    maxContentLength: MAX_HTML_BYTES,
    maxBodyLength:    MAX_HTML_BYTES,
    maxRedirects: 5,
    headers: _buildHeaders(userAgent),
    responseType: 'text',
    transformResponse: [(d) => d],
    validateStatus: (s) => s >= 200 && s < 300,
    decompress: true,
  });
}

function _shouldRetry(err) {
  const status = err?.response?.status;
  if (status && RETRY_STATUS_CODES.has(status)) return true;
  const code = err?.code;
  if (code && RETRY_ERROR_CODES.has(code)) return true;
  return false;
}

async function fetchOne(url) {
  // Попытка №1 — реальный Chrome.
  try {
    const res = await _doFetch(url, PRIMARY_USER_AGENT);
    const html = String(res.data || '');
    if (!html.trim()) {
      // Пустой body — попробуем ещё раз Googlebot, иногда помогает.
      throw Object.assign(new Error('empty body'), { code: 'EMPTY_BODY' });
    }
    return { url, html };
  } catch (err1) {
    if (!_shouldRetry(err1) && err1?.code !== 'EMPTY_BODY') {
      const code = err1?.response?.status || err1?.code || 'ERR';
      const msg  = err1?.message || 'fetch failed';
      return { url, error: `${code}: ${msg.slice(0, 140)}` };
    }
    // Попытка №2 — Googlebot UA. Многие WAF/anti-bot пропускают его.
    try {
      const res2 = await _doFetch(url, FALLBACK_USER_AGENT);
      const html2 = String(res2.data || '');
      if (!html2.trim()) {
        return { url, error: 'empty body (after retry)' };
      }
      return { url, html: html2 };
    } catch (err2) {
      const code = err2?.response?.status || err2?.code || 'ERR';
      const msg  = err2?.message || 'fetch failed';
      return { url, error: `${code}: ${msg.slice(0, 140)}` };
    }
  }
}

/**
 * @param {string[]} urls
 * @returns {Promise<{successes: Array<{url, html}>, failures: Array<{url, error}>}>}
 */
async function fetchPages(urls) {
  const list = (Array.isArray(urls) ? urls : [])
    .map((u) => String(u || '').trim())
    .filter(Boolean);

  if (list.length === 0) {
    return { successes: [], failures: [] };
  }

  const all = await pMap(list, FETCH_CONCURRENCY, fetchOne);

  const successes = [];
  const failures  = [];
  for (const r of all) {
    if (r && r.html) successes.push({ url: r.url, html: r.html });
    else if (r)      failures.push({ url: r.url, error: r.error || 'unknown' });
  }
  return { successes, failures };
}

module.exports = { fetchPages, FETCH_CONCURRENCY, FETCH_TIMEOUT_MS };
