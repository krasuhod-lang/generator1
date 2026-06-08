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
 *   • повтор с альтернативным User-Agent (Googlebot) при 403/429/503/таймауте;
 *   • cookie jar (`tough-cookie`) — многие сайты на втором запросе отдают
 *     полный HTML, если приняли cookie с первого (Cloudflare cf_clearance,
 *     Qrator, Akamai). Создаём отдельный jar на каждый URL — изоляция;
 *   • опциональный headless-fallback: если задан
 *     `RELEVANCE_HEADLESS_FETCHER_URL`, для пустых/SPA-страниц делаем
 *     POST {url} → ожидаем {html} от внешнего сервиса (Playwright/Puppeteer
 *     поднимается отдельным контейнером — тяжёлый Chromium не тащим в
 *     основной backend, чтобы не раздувать образ).
 *
 * Возвращает `{ successes: [{url, html}], failures: [{url, error, code, ...}] }`.
 * `failures[].code` — категория (`http_403`, `timeout`, `dns`, `tls`,
 * `empty_body`, `too_large`, `parse_error`, `headless_fail`, `unknown`).
 * Это позволяет фронту показать распределение причин fail'а — сразу видно,
 * где WAF, где SSR-only, где вообще DNS-проблемы.
 */

const axios = require('axios');

let _cookieJarSupport = null;
let _CookieJarCtor    = null;
try {
  // Подключение опционально: если пакетов нет — работаем без cookie jar
  // (graceful degradation; пайплайн не падает).
  // eslint-disable-next-line global-require
  _cookieJarSupport = require('axios-cookiejar-support').wrapper;
  // eslint-disable-next-line global-require
  _CookieJarCtor    = require('tough-cookie').CookieJar;
} catch (_) {
  _cookieJarSupport = null;
  _CookieJarCtor    = null;
}

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
  return Number.isFinite(v) && v >= 65536 ? v : 16 * 1024 * 1024;
})();

// Минимальная длина «полезного» текста в HTML, ниже которой считаем страницу
// SPA-заглушкой и (если настроен headless) пробуем headless-fallback.
const SPA_THRESHOLD_BYTES = (() => {
  const v = parseInt(process.env.RELEVANCE_SPA_THRESHOLD_BYTES, 10);
  return Number.isFinite(v) && v >= 0 && v <= 1_000_000 ? v : 1500;
})();

// Опциональный URL внешнего headless-сервиса (Playwright/Puppeteer).
// Сервис должен принимать POST { url, timeout_ms } → { html } или 4xx/5xx.
const HEADLESS_FETCHER_URL = (process.env.RELEVANCE_HEADLESS_FETCHER_URL || '').trim();
const HEADLESS_TIMEOUT_MS  = (() => {
  const v = parseInt(process.env.RELEVANCE_HEADLESS_TIMEOUT_MS, 10);
  return Number.isFinite(v) && v >= 5000 && v <= 120000 ? v : 35000;
})();

// X-Internal-Token для вызова `relevance_fetcher` (шарим единый токен с
// сервисом `relevance`). Если переменная пустая — сервис тоже её не требует.
const RELEVANCE_INTERNAL_TOKEN = (process.env.RELEVANCE_INTERNAL_TOKEN || '').trim();

// Сигнатуры антибот-челленджей (Cloudflare / Qrator / DDoS-Guard / Sucuri).
// При их обнаружении в HTML или статус-кодах форсим headless БЕЗ ожидания
// SPA-порога — иначе мы будем считать «пустым телом» страницу, которая на
// самом деле прячет реальный контент за JS-челленджем.
const WAF_HTML_MARKERS = [
  '__cf_chl_',
  'cf-browser-verification',
  'Just a moment...',
  'cdn-cgi/challenge-platform',
  'Checking your browser',
  'qrator.net',
  '_qrtj',
  'ddos-guard',
  'sucuri_cloudproxy',
];

const FORCE_HEADLESS_STATUSES = new Set([401, 403, 429, 503]);

function _looksLikeWafChallenge(html) {
  if (!html) return false;
  // Дешёвый поиск без regex по ограниченному префиксу — не пробегаем по
  // мегабайтам HTML, достаточно проверить начало (~16 КБ).
  const head = html.slice(0, 16384);
  for (const m of WAF_HTML_MARKERS) {
    if (head.indexOf(m) !== -1) return true;
  }
  return false;
}

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
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.7,en;q=0.6',
    // Brotli/gzip/deflate — axios сам распакует (decompress:true).
    // На некоторых серверах brotli может вернуть «битый» поток (плохой
    // Content-Encoding) — для таких случаев есть fallback в _doFetch без `br`.
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control':   'no-cache',
    'Pragma':          'no-cache',
    'Referer':         'https://yandex.ru/',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest':  'document',
    'Sec-Fetch-Mode':  'navigate',
    'Sec-Fetch-Site':  'cross-site',
    'Sec-Fetch-User':  '?1',
  };
}

function _newAxiosWithJar() {
  // tough-cookie + axios-cookiejar-support: получаем axios-инстанс,
  // который сам сохраняет/подтягивает Set-Cookie между запросами на
  // один и тот же домен. Это критично для Cloudflare/Qrator: первый
  // запрос → 503 + Set-Cookie cf_clearance; второй → 200 OK.
  if (!_cookieJarSupport || !_CookieJarCtor) return axios.create();
  const jar = new _CookieJarCtor();
  const inst = axios.create({ jar, withCredentials: true });
  return _cookieJarSupport(inst);
}

async function _doFetch(client, url, userAgent, { acceptBrotli = true } = {}) {
  const headers = _buildHeaders(userAgent);
  if (!acceptBrotli) {
    // На редких серверах brotli приходит «битым» (бинарь без правильного
    // Content-Encoding). Если первая попытка дала пустой/мусорный body —
    // повторяем без `br`, чтобы axios не пытался распаковывать.
    headers['Accept-Encoding'] = 'gzip, deflate';
  }
  return client.get(url, {
    timeout: FETCH_TIMEOUT_MS,
    maxContentLength: MAX_HTML_BYTES,
    maxBodyLength:    MAX_HTML_BYTES,
    maxRedirects: 5,
    headers,
    responseType: 'text',
    transformResponse: [(d) => d],
    validateStatus: (s) => s >= 200 && s < 300,
    decompress: true,
  });
}

/**
 * Категоризирует ошибку axios → стабильный код для статистики.
 * Эти коды попадают в `failed_urls[].code` и используются на фронте
 * для подсчёта распределения причин fail'а (сразу видно, где WAF,
 * где SSR-only сайты, где DNS).
 */
function _categorize(err) {
  const status = err?.response?.status;
  if (status) return `http_${status}`;
  const code = err?.code;
  if (code === 'EMPTY_BODY')        return 'empty_body';
  if (code === 'ECONNABORTED')      return 'timeout';   // axios timeout
  if (code === 'ETIMEDOUT')         return 'timeout';
  if (code === 'ECONNRESET')        return 'conn_reset';
  if (code === 'ECONNREFUSED')      return 'conn_refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  if (code === 'ENETUNREACH')       return 'unreachable';
  if (code === 'CERT_HAS_EXPIRED' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
   || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
   || code === 'SELF_SIGNED_CERT_IN_CHAIN'
   || code === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'tls';
  if (code === 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED'
   || code === 'ERR_BAD_RESPONSE') return 'too_large';
  return 'unknown';
}

function _shouldRetry(err) {
  const status = err?.response?.status;
  if (status && RETRY_STATUS_CODES.has(status)) return true;
  const code = err?.code;
  if (code && RETRY_ERROR_CODES.has(code)) return true;
  return false;
}

async function _headlessFetch(url) {
  if (!HEADLESS_FETCHER_URL) return null;
  try {
    const res = await axios.post(
      HEADLESS_FETCHER_URL,
      { url, timeout_ms: HEADLESS_TIMEOUT_MS },
      {
        timeout: HEADLESS_TIMEOUT_MS + 5000,
        maxContentLength: MAX_HTML_BYTES,
        maxBodyLength:    MAX_HTML_BYTES,
        validateStatus: (s) => s >= 200 && s < 300,
        headers: RELEVANCE_INTERNAL_TOKEN
          ? { 'X-Internal-Token': RELEVANCE_INTERNAL_TOKEN }
          : undefined,
      },
    );
    const html = String(res?.data?.html || '');
    if (!html.trim()) return null;
    return html;
  } catch (_) {
    return null;
  }
}

async function fetchOne(url) {
  const client = _newAxiosWithJar();
  const result = { url };

  // helper: вернуть успех (если headless вернул HTML), иначе null.
  // Используем при WAF/антибот-сигналах ДО исчерпания axios-попыток.
  const _tryHeadless = async (reasonMethod) => {
    if (!HEADLESS_FETCHER_URL) return null;
    const hh = await _headlessFetch(url);
    if (hh) return { url, html: hh, method: `headless_${reasonMethod}` };
    return null;
  };

  // Попытка №1 — реальный Chrome + cookie jar (Cloudflare cf_clearance ловится).
  let firstErr = null;
  try {
    const res = await _doFetch(client, url, PRIMARY_USER_AGENT);
    const html = String(res.data || '');
    if (!html.trim()) {
      throw Object.assign(new Error('empty body'), { code: 'EMPTY_BODY' });
    }
    // Антибот-челлендж — сразу в headless (axios даже на retry его не
    // пробьёт, нужно реальное JS-исполнение).
    if (_looksLikeWafChallenge(html)) {
      const hh = await _tryHeadless('cf_challenge');
      if (hh) return hh;
    }
    if (html.length < SPA_THRESHOLD_BYTES) {
      // Возможно SPA — попытаемся headless (если настроен).
      const hh = await _tryHeadless('spa');
      if (hh) return hh;
    }
    return { url, html, method: 'axios_chrome' };
  } catch (err) {
    firstErr = err;
  }

  // Если первый запрос упал на статусе из FORCE_HEADLESS_STATUSES (403/503/…) —
  // axios-retry даже с другим UA не пробьёт WAF (он привязывает челлендж к
  // IP+TLS). Сразу пробуем headless.
  const firstStatus = firstErr?.response?.status;
  if (firstStatus && FORCE_HEADLESS_STATUSES.has(firstStatus)) {
    const hh = await _tryHeadless(`http_${firstStatus}`);
    if (hh) return hh;
  }

  // Попытка №2 — fallback: Googlebot UA, тот же cookie jar (поможет
  // если первый запрос получил cookie-челлендж, а второй пройдёт).
  let secondErr = null;
  if (_shouldRetry(firstErr) || firstErr?.code === 'EMPTY_BODY') {
    try {
      const res2 = await _doFetch(client, url, FALLBACK_USER_AGENT);
      const html2 = String(res2.data || '');
      if (!html2.trim()) {
        throw Object.assign(new Error('empty body (after retry)'), { code: 'EMPTY_BODY' });
      }
      if (_looksLikeWafChallenge(html2)) {
        const hh = await _tryHeadless('cf_challenge_after_googlebot');
        if (hh) return hh;
      }
      if (html2.length < SPA_THRESHOLD_BYTES) {
        const hh = await _tryHeadless('spa');
        if (hh) return hh;
      }
      return { url, html: html2, method: 'axios_googlebot' };
    } catch (err) {
      secondErr = err;
    }
  }

  // Попытка №3 — без brotli (на случай битого br-стрима у редких серверов).
  if (!secondErr) secondErr = firstErr;
  if (_shouldRetry(secondErr) || secondErr?.code === 'EMPTY_BODY') {
    try {
      const res3 = await _doFetch(client, url, PRIMARY_USER_AGENT, { acceptBrotli: false });
      const html3 = String(res3.data || '');
      if (html3.trim()) {
        if (_looksLikeWafChallenge(html3)) {
          const hh = await _tryHeadless('cf_challenge_no_brotli');
          if (hh) return hh;
        }
        if (html3.length < SPA_THRESHOLD_BYTES) {
          const hh = await _tryHeadless('spa');
          if (hh) return hh;
        }
        return { url, html: html3, method: 'axios_no_brotli' };
      }
    } catch (_) { /* ignored — последний fallback ниже */ }
  }

  // Финальная попытка — headless, если включён, даже без предварительного
  // успеха. Это покрывает SPA, которые без JS вообще ничего не отдают,
  // и WAF-страницы, где axios подряд получает 403/503.
  if (HEADLESS_FETCHER_URL) {
    const hh = await _headlessFetch(url);
    if (hh) return { url, html: hh, method: 'headless_last_resort' };
  }

  const finalErr = secondErr || firstErr;
  result.error = (() => {
    const status = finalErr?.response?.status || finalErr?.code || 'ERR';
    const msg    = String(finalErr?.message || 'fetch failed').slice(0, 140);
    return `${status}: ${msg}`;
  })();
  result.code = _categorize(finalErr);
  return result;
}

/**
 * @param {string[]} urls
 * @returns {Promise<{successes: Array<{url, html, method?}>, failures: Array<{url, error, code}>}>}
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
    if (r && r.html) successes.push({ url: r.url, html: r.html, method: r.method || 'axios' });
    else if (r) failures.push({
      url:   r.url,
      error: r.error || 'unknown',
      code:  r.code  || 'unknown',
    });
  }
  return { successes, failures };
}

module.exports = {
  fetchPages,
  fetchOne,
  FETCH_CONCURRENCY,
  FETCH_TIMEOUT_MS,
  HEADLESS_FETCHER_URL,
  COOKIE_JAR_AVAILABLE: !!_cookieJarSupport,
};
