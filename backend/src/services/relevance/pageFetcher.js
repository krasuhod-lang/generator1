'use strict';

/**
 * pageFetcher — параллельная загрузка HTML страниц ТОП-20.
 *
 * Главные правила:
 *   • разумный User-Agent (некоторые сайты режут axios/default);
 *   • Accept: только text/html — отсекаем PDF/картинки/JSON;
 *   • строгий лимит на размер ответа (RELEVANCE_MAX_HTML_BYTES, дефолт 4 МБ);
 *   • per-URL таймаут (RELEVANCE_FETCH_TIMEOUT_MS, дефолт 15 с);
 *   • ограниченный параллелизм (RELEVANCE_FETCH_CONCURRENCY, дефолт 6);
 *   • любая ошибка по конкретному URL не валит весь пайплайн — URL уходит в
 *     failed_urls с текстом ошибки.
 *
 * Возвращает { successes: [{url, html}], failures: [{url, error}] }.
 */

const axios = require('axios');

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (compatible; SEOGeniusRelevanceBot/1.0; +https://seogenius.local)';

const FETCH_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.RELEVANCE_FETCH_TIMEOUT_MS, 10);
  return Number.isFinite(v) && v >= 1000 && v <= 120000 ? v : 15000;
})();

const FETCH_CONCURRENCY = (() => {
  const v = parseInt(process.env.RELEVANCE_FETCH_CONCURRENCY, 10);
  return Number.isFinite(v) && v >= 1 && v <= 20 ? v : 6;
})();

const MAX_HTML_BYTES = (() => {
  const v = parseInt(process.env.RELEVANCE_MAX_HTML_BYTES, 10);
  // 4 MB по умолчанию — большая статья со встроенными картинками влезет,
  // но мегабайтные SPA-бандлы отрежем.
  return Number.isFinite(v) && v >= 65536 ? v : 4 * 1024 * 1024;
})();

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

async function fetchOne(url) {
  try {
    const res = await axios.get(url, {
      timeout: FETCH_TIMEOUT_MS,
      maxContentLength: MAX_HTML_BYTES,
      maxBodyLength:    MAX_HTML_BYTES,
      maxRedirects: 5,
      // Принимаем только html — text/plain/xml тоже допустим (mime у некоторых
      // сайтов кривой), а вот application/* (pdf/json/image) пусть падает 406.
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.7',
        'Accept-Language': 'ru,en;q=0.8',
      },
      // axios сам не распарсит — просим текст.
      responseType: 'text',
      transformResponse: [(d) => d],
      // Любой 4xx/5xx — ошибка
      validateStatus: (s) => s >= 200 && s < 300,
      // На некоторых сайтах нужно для https
      decompress: true,
    });

    const html = String(res.data || '');
    if (!html.trim()) {
      return { url, error: 'empty body' };
    }
    return { url, html };
  } catch (err) {
    const code = err?.response?.status || err?.code || 'ERR';
    const msg  = err?.message || 'fetch failed';
    return { url, error: `${code}: ${msg.slice(0, 140)}` };
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
