'use strict';

/**
 * pageFetcher — параллельная загрузка HTML страниц ТОП-20.
 *
 * Главные правила:
 *   • реальный браузерный User-Agent (некоторые сайты режут axios/default
 *     или дефолтные строки SEO-ботов); UA берётся из пула свежих браузерных
 *     строк со случайной ротацией на каждый URL (anti-bot);
 *   • расширенный Accept (+image/webp,*\/*; q=0.8) — современные сайты часто
 *     отдают 406, если видеть только text/html;
 *   • строгий лимит на размер ответа (RELEVANCE_MAX_HTML_BYTES, дефолт 16 МБ);
 *   • per-URL таймаут (RELEVANCE_FETCH_TIMEOUT_MS, дефолт 25 с);
 *   • ограниченный параллелизм (RELEVANCE_FETCH_CONCURRENCY, дефолт 6);
 *   • повтор с альтернативным User-Agent (Googlebot) при 403/429/503/таймауте,
 *     с экспоненциальной задержкой между попытками (Exponential Backoff,
 *     RELEVANCE_RETRY_BASE_DELAY_MS / RELEVANCE_RETRY_MAX_DELAY_MS);
 *   • опциональный прокси-ротатор (RELEVANCE_PROXY_URL / RELEVANCE_PROXY_LIST)
 *     через https-proxy-agent — обход IP-блокировок и гео-ограничений;
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

let _HttpsProxyAgent = null;
try {
  // https-proxy-agent уже в зависимостях бэкенда. Туннелируем axios-запросы
  // через корпоративный/ротируемый прокси (CONNECT) — обход IP-блокировок и
  // гео-ограничений сайтов-доноров. Если пакет недоступен — работаем напрямую.
  // eslint-disable-next-line global-require
  _HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;
} catch (_) {
  _HttpsProxyAgent = null;
}

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

// Пул свежих UA реальных десктоп-браузеров (Chrome/Edge/Firefox на Win/Mac).
// Ротация снижает шанс попасть под rate-limit/фингерпринт-блокировку по
// «однообразному» User-Agent (TZ: «ротация актуальных User-Agent»). Берём
// хардкод-пул вместо внешней fake_useragent — он не тянет зависимость и не
// ходит в сеть за свежей базой UA на каждый запрос.
const USER_AGENT_POOL = [
  PRIMARY_USER_AGENT,
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

/** Случайный «человеческий» UA из пула (TZ: случайный, но валидный UA). */
function _randomUserAgent() {
  return USER_AGENT_POOL[Math.floor(Math.random() * USER_AGENT_POOL.length)];
}

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

// ── Прокси (anti-bot / гео-обход) ──────────────────────────────────────────
// TZ: «Архитектура функции должна поддерживать передачу прокси-серверов.
// Предусмотреть возможность подключения proxy-ротатора».
//   • RELEVANCE_PROXY_URL  — один прокси (******host:port).
//   • RELEVANCE_PROXY_LIST — список через запятую/перенос строки → ротатор:
//     на каждый URL берём случайный прокси из пула.
// Прокси применяется только если в вызов передан proxiesEnabled !== false
// (по умолчанию включён, когда пул непустой). Туннелирование — через
// https-proxy-agent (CONNECT), работает для https-целей.
function _parseProxyList(raw) {
  return String(raw || '')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const PROXY_POOL = (() => {
  const single = (process.env.RELEVANCE_PROXY_URL || '').trim();
  const list = _parseProxyList(process.env.RELEVANCE_PROXY_LIST);
  const all = [];
  if (single) all.push(single);
  for (const p of list) if (!all.includes(p)) all.push(p);
  return all;
})();

const PROXY_AVAILABLE = PROXY_POOL.length > 0 && !!_HttpsProxyAgent;

/** Случайный прокси из пула (ротатор) либо null, если пул пуст/выключен. */
function _pickProxy(proxiesEnabled) {
  if (proxiesEnabled === false) return null;
  if (!PROXY_AVAILABLE) return null;
  return PROXY_POOL[Math.floor(Math.random() * PROXY_POOL.length)];
}

/** Строит agent для axios из URL прокси (или null, если прокси не задан). */
function _proxyAgent(proxyUrl) {
  if (!proxyUrl || !_HttpsProxyAgent) return null;
  try {
    return new _HttpsProxyAgent(proxyUrl);
  } catch (_) {
    return null;
  }
}

// ── Экспоненциальный backoff между ретраями ────────────────────────────────
// TZ: «Реализовать экспоненциальную задержку (Exponential Backoff) для
// повторных запросов при статусах 429, 500, 502, 503, 504». Базовая задержка
// и потолок настраиваются через env; добавляем небольшой джиттер, чтобы не
// бить по серверу синхронно по всем URL батча.
const RETRY_BASE_DELAY_MS = (() => {
  const v = parseInt(process.env.RELEVANCE_RETRY_BASE_DELAY_MS, 10);
  return Number.isFinite(v) && v >= 0 && v <= 30000 ? v : 600;
})();

const RETRY_MAX_DELAY_MS = (() => {
  const v = parseInt(process.env.RELEVANCE_RETRY_MAX_DELAY_MS, 10);
  return Number.isFinite(v) && v >= 0 && v <= 120000 ? v : 8000;
})();

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Задержка attempt-й попытки: base * 2^(attempt-1) + джиттер, с потолком. */
function _backoffDelay(attempt) {
  if (RETRY_BASE_DELAY_MS <= 0) return 0;
  const exp = RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exp, RETRY_MAX_DELAY_MS);
  const jitter = Math.floor(Math.random() * Math.min(250, capped + 1));
  return capped + jitter;
}

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

async function _doFetch(client, url, userAgent, { acceptBrotli = true, proxyAgent = null } = {}) {
  const headers = _buildHeaders(userAgent);
  if (!acceptBrotli) {
    // На редких серверах brotli приходит «битым» (бинарь без правильного
    // Content-Encoding). Если первая попытка дала пустой/мусорный body —
    // повторяем без `br`, чтобы axios не пытался распаковывать.
    headers['Accept-Encoding'] = 'gzip, deflate';
  }
  const cfg = {
    timeout: FETCH_TIMEOUT_MS,
    maxContentLength: MAX_HTML_BYTES,
    maxBodyLength:    MAX_HTML_BYTES,
    maxRedirects: 5,
    headers,
    responseType: 'text',
    transformResponse: [(d) => d],
    validateStatus: (s) => s >= 200 && s < 300,
    decompress: true,
  };
  if (proxyAgent) {
    // Туннелируем через прокси (CONNECT). proxy:false отключает встроенную
    // axios-обработку env-переменных HTTP(S)_PROXY, чтобы не конфликтовала.
    cfg.httpsAgent = proxyAgent;
    cfg.httpAgent = proxyAgent;
    cfg.proxy = false;
  }
  return client.get(url, cfg);
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

async function _headlessFetch(url, proxyUrl = null) {
  if (!HEADLESS_FETCHER_URL) return null;
  try {
    const body = { url, timeout_ms: HEADLESS_TIMEOUT_MS };
    // Пробрасываем прокси в headless-сервис (Playwright умеет launch с proxy).
    if (proxyUrl) body.proxy = proxyUrl;
    const res = await axios.post(
      HEADLESS_FETCHER_URL,
      body,
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

async function fetchOne(url, opts = {}) {
  const { proxiesEnabled } = opts;
  const client = _newAxiosWithJar();
  // Прокси выбираем один раз на URL (ротатор на уровне URL, не на уровне
  // попытки), чтобы cookie jar/челлендж не «прыгали» между IP внутри ретраев.
  const proxyUrl = _pickProxy(proxiesEnabled);
  const proxyAgent = _proxyAgent(proxyUrl);
  // Случайные «человеческие» UA для основной и третьей попытки (ротация).
  const primaryUa = _randomUserAgent();
  const thirdUa = _randomUserAgent();
  const result = { url };
  // Счётчик ретраев (TZ output: retries_used) — число повторов сверх первой
  // попытки, доведших до успеха или до финальной ошибки.
  let retries = 0;

  // helper: вернуть успех (если headless вернул HTML), иначе null.
  // Используем при WAF/антибот-сигналах ДО исчерпания axios-попыток.
  const _tryHeadless = async (reasonMethod) => {
    if (!HEADLESS_FETCHER_URL) return null;
    const hh = await _headlessFetch(url, proxyUrl);
    if (hh) return { url, html: hh, method: `headless_${reasonMethod}`, retries_used: retries };
    return null;
  };

  // Попытка №1 — реальный Chrome + cookie jar (Cloudflare cf_clearance ловится).
  let firstErr = null;
  try {
    const res = await _doFetch(client, url, primaryUa, { proxyAgent });
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
    return { url, html, method: 'axios_chrome', retries_used: retries };
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
  // Перед повтором — экспоненциальная пауза (TZ: Exponential Backoff).
  let secondErr = null;
  if (_shouldRetry(firstErr) || firstErr?.code === 'EMPTY_BODY') {
    retries += 1;
    await _sleep(_backoffDelay(retries));
    try {
      const res2 = await _doFetch(client, url, FALLBACK_USER_AGENT, { proxyAgent });
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
      return { url, html: html2, method: 'axios_googlebot', retries_used: retries };
    } catch (err) {
      secondErr = err;
    }
  }

  // Попытка №3 — без brotli (на случай битого br-стрима у редких серверов).
  if (!secondErr) secondErr = firstErr;
  if (_shouldRetry(secondErr) || secondErr?.code === 'EMPTY_BODY') {
    retries += 1;
    await _sleep(_backoffDelay(retries));
    try {
      const res3 = await _doFetch(client, url, thirdUa, { acceptBrotli: false, proxyAgent });
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
        return { url, html: html3, method: 'axios_no_brotli', retries_used: retries };
      }
    } catch (_) { /* ignored — последний fallback ниже */ }
  }

  // Финальная попытка — headless, если включён, даже без предварительного
  // успеха. Это покрывает SPA, которые без JS вообще ничего не отдают,
  // и WAF-страницы, где axios подряд получает 403/503.
  if (HEADLESS_FETCHER_URL) {
    const hh = await _headlessFetch(url, proxyUrl);
    if (hh) return { url, html: hh, method: 'headless_last_resort', retries_used: retries };
  }

  const finalErr = secondErr || firstErr;
  result.error = (() => {
    const status = finalErr?.response?.status || finalErr?.code || 'ERR';
    const msg    = String(finalErr?.message || 'fetch failed').slice(0, 140);
    return `${status}: ${msg}`;
  })();
  result.code = _categorize(finalErr);
  result.retries_used = retries;
  return result;
}

/**
 * @param {string[]} urls
 * @param {object}   [opts]
 * @param {boolean}  [opts.proxiesEnabled] — включить прокси-ротатор для этого
 *   батча (по умолчанию используется, если задан пул RELEVANCE_PROXY_*).
 * @returns {Promise<{successes: Array<{url, html, method?, retries_used?}>, failures: Array<{url, error, code, retries_used?}>}>}
 */
async function fetchPages(urls, opts = {}) {
  const list = (Array.isArray(urls) ? urls : [])
    .map((u) => String(u || '').trim())
    .filter(Boolean);

  if (list.length === 0) {
    return { successes: [], failures: [] };
  }

  const all = await pMap(list, FETCH_CONCURRENCY, (u) => fetchOne(u, opts));

  const successes = [];
  const failures  = [];
  for (const r of all) {
    if (r && r.html) {
      successes.push({
        url: r.url, html: r.html, method: r.method || 'axios', retries_used: r.retries_used || 0,
      });
    } else if (r) {
      failures.push({
        url:   r.url,
        error: r.error || 'unknown',
        code:  r.code  || 'unknown',
        retries_used: r.retries_used || 0,
      });
    }
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
  PROXY_AVAILABLE,
  USER_AGENT_POOL,
};
