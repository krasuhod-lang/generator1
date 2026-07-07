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

// URL двухрежимного эндпоинта `/fetch_html` (curl_cffi TLS-impersonation /
// Playwright+stealth) того же relevance_fetcher-сервиса. Выводится из
// RELEVANCE_HEADLESS_FETCHER_URL заменой хвоста `/fetch` → `/fetch_html`,
// отдельная env-переменная не нужна. Пусто, если headless-сервис не настроен.
const FETCH_HTML_URL = (() => {
  if (!HEADLESS_FETCHER_URL) return '';
  try {
    const u = new URL(HEADLESS_FETCHER_URL);
    if (/\/fetch_html\/?$/.test(u.pathname)) return u.toString();
    u.pathname = u.pathname.replace(/\/fetch\/?$/, '/fetch_html');
    if (!/\/fetch_html\/?$/.test(u.pathname)) {
      u.pathname = `${u.pathname.replace(/\/$/, '')}/fetch_html`;
    }
    return u.toString();
  } catch (_) {
    return '';
  }
})();

// Тумблер curl_cffi-эскалации (Mode A): по умолчанию включён, если доступен
// fetch_html-эндпоинт. Kill-switch: RELEVANCE_CURL_CFFI_ESCALATION=false.
const CURL_CFFI_ENABLED = !!FETCH_HTML_URL
  && !['0', 'false', 'no', 'off'].includes(
    String(process.env.RELEVANCE_CURL_CFFI_ESCALATION || '').trim().toLowerCase(),
  );

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
  // Cloudflare
  '__cf_chl_',
  'cf-browser-verification',
  'Just a moment...',
  'cdn-cgi/challenge-platform',
  'Checking your browser',
  // Qrator / DDoS-Guard / Sucuri
  'qrator.net',
  '_qrtj',
  'ddos-guard',
  'sucuri_cloudproxy',
  // Akamai
  'ak_bmsc',
  'Reference&#32;ID',
  'Reference #18.',
  // Imperva / Incapsula
  '_Incapsula_Resource',
  'Powered by Imperva',
  'Request unsuccessful',
  // PerimeterX / HUMAN
  'pxhd',
  '__pxvid',
  'Please verify you are a human',
  // F5 BIG-IP
  'f5avraaaaa',
  'TS01',
  // Generic
  'Доступ ограничен',
  'Подтвердите, что вы не робот',
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
  // HTTP/2 / parser-level errors that occasionally happen on Node 20 with
  // aggressive HTTP/2 servers. Без ретрая такие URL уходили в `unknown` и
  // оператор видел «3/20» там, где на самом деле помог бы повтор / headless.
  'EPROTO',
  'HPE_INVALID_HEADER_TOKEN',
  'HPE_INVALID_CONSTANT',
  'HPE_INVALID_CHUNK_SIZE',
  'HPE_INVALID_METHOD',
  'HPE_HEADER_OVERFLOW',
  'ERR_HTTP2_STREAM_ERROR',
  'ERR_HTTP2_PROTOCOL_ERROR',
  'ERR_HTTP2_GOAWAY_SESSION',
  'ERR_HTTP2_INVALID_STREAM',
  'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
  'ERR_SSL_PROTOCOL_ERROR',
]);
// Регулярка-маска для всех ERR_HTTP2_* / HPE_* кодов на случай новых имён в
// будущих версиях Node — _shouldRetry() проверяет совпадение либо по Set,
// либо по этому prefix-фильтру.
const RETRY_ERROR_CODE_PREFIXES = ['ERR_HTTP2_', 'HPE_'];

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
    // Берём сырой ArrayBuffer, чтобы корректно перекодировать страницы в
    // windows-1251 / koi8-r / etc — axios по умолчанию декодирует как UTF-8
    // и для cp1251-русских сайтов кириллица превращается в мусор, что ломает
    // лемматизацию (`_WORD_COUNT_RE` находит мало слов → text_chars≈0).
    responseType: 'arraybuffer',
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
  const res = await client.get(url, cfg);
  // Декодируем тело в строку с учётом charset из Content-Type / <meta charset>.
  res.data = _decodeBodyToString(res.data, res.headers || {});
  return res;
}

/**
 * Определяет charset из HTTP-заголовка `Content-Type` (приоритет 1) и из
 * `<meta charset>` / `<meta http-equiv="Content-Type">` (приоритет 2).
 * Для неподдерживаемых TextDecoder'ом кодировок пытаемся iconv-lite
 * (зависимость опциональная — graceful degradation).
 */
let _iconv = null;
try {
  // eslint-disable-next-line global-require
  _iconv = require('iconv-lite');
} catch (_) { _iconv = null; }

function _detectCharset(buf, headers) {
  const ct = String((headers && (headers['content-type'] || headers['Content-Type'])) || '');
  const m1 = /charset\s*=\s*['"]?([\w-]+)/i.exec(ct);
  if (m1 && m1[1]) return m1[1].toLowerCase();
  // Сниффим первые 4 KB на наличие <meta charset=...> / http-equiv.
  try {
    const head = Buffer.isBuffer(buf) ? buf.slice(0, 4096).toString('latin1')
                                      : String(buf || '').slice(0, 4096);
    const m2 = /<meta[^>]+charset\s*=\s*['"]?([\w-]+)/i.exec(head);
    if (m2 && m2[1]) return m2[1].toLowerCase();
  } catch (_) { /* best-effort */ }
  return 'utf-8';
}

function _decodeBodyToString(body, headers) {
  // Если уже строка (например при responseType:'text' где-то выше) — возвращаем.
  if (typeof body === 'string') return body;
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body || []);
  const enc = _detectCharset(buf, headers);
  // node:TextDecoder поддерживает большой список кодировок (utf-8, windows-1251,
  // koi8-r, и т.д.). Если конкретная не поддерживается — пробуем iconv-lite.
  try {
    return new TextDecoder(enc, { fatal: false }).decode(buf);
  } catch (_) {
    if (_iconv && _iconv.encodingExists(enc)) {
      try { return _iconv.decode(buf, enc); } catch (_e) { /* fallthrough */ }
    }
    // Последний фоллбэк — UTF-8.
    return buf.toString('utf-8');
  }
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
  if (typeof code === 'string' && (code.startsWith('ERR_HTTP2_') || code.startsWith('HPE_')
    || code === 'EPROTO')) return 'http2_protocol';
  if (code === 'HEADLESS_UNAVAILABLE') return 'headless_unavailable';
  if (code === 'HEADLESS_FAIL')        return 'headless_fail';
  return 'unknown';
}

/**
 * Верхнеуровневая категория причины fail'а для диагностики в отчёте:
 * WAF / captcha / timeout / SSL / DNS / empty / not_found / http_error /
 * network / headless / unknown. Отвечает на вопрос оператора «что именно
 * требуется указать» (прокси, увеличенный таймаут и т.п.).
 */
function categoryOf(code, error = '') {
  const c = String(code || 'unknown');
  const e = String(error || '').toLowerCase();
  if (e.includes('captcha') || e.includes('are you a human')
    || e.includes('не робот')) return 'captcha';
  if (c === 'http_403' || c === 'http_401' || c === 'http_429'
    || e.includes('waf challenge') || e.includes('blocked')) return 'waf';
  if (c === 'timeout' || c === 'http_408' || c === 'http_522'
    || c === 'http_524' || e.includes('timeout')) return 'timeout';
  if (c === 'tls' || e.includes('ssl') || e.includes('certificate')) return 'ssl';
  if (c === 'dns') return 'dns';
  if (c === 'empty_body') return 'empty';
  if (c === 'http_404' || c === 'http_410' || c === 'http_451') return 'not_found';
  if (/^http_5\d\d$/.test(c)) return 'waf_or_5xx';
  if (/^http_\d+$/.test(c)) return 'http_error';
  if (c === 'conn_reset' || c === 'conn_refused' || c === 'unreachable'
    || c === 'http2_protocol') return 'network';
  if (c.startsWith('headless_')) return 'headless';
  return 'unknown';
}

// ── Per-domain память «какой метод сработал» ────────────────────────────────
// При повторных анализах начинаем с уровня эскалации, который сработал для
// домена в прошлый раз (axios → curl_cffi → headless), не тратя время на
// заведомо провальные нижние уровни. In-memory с TTL — процесс живёт долго,
// а свежесть важнее persistence (сайт мог снять WAF).
const DOMAIN_METHOD_TTL_MS = (() => {
  const v = parseInt(process.env.RELEVANCE_DOMAIN_METHOD_TTL_MS, 10);
  return Number.isFinite(v) && v >= 0 ? v : 24 * 3600 * 1000;
})();
const _domainMethodStats = new Map(); // host -> { tier, method, at }
const _DOMAIN_STATS_MAX = 5000;

function _hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
  catch (_) { return ''; }
}

/** Уровень эскалации по имени метода: axios* → 0, curl_cffi → 1, headless* → 2. */
function _tierOfMethod(method) {
  const m = String(method || '');
  if (m.startsWith('headless')) return 2;
  if (m.startsWith('curl_cffi')) return 1;
  return 0;
}

function _rememberDomainMethod(url, method) {
  const host = _hostOf(url);
  if (!host) return;
  if (_domainMethodStats.size >= _DOMAIN_STATS_MAX && !_domainMethodStats.has(host)) {
    // Простейшая защита от роста без границ: выбрасываем самую старую запись.
    const oldest = _domainMethodStats.keys().next().value;
    if (oldest !== undefined) _domainMethodStats.delete(oldest);
  }
  _domainMethodStats.set(host, {
    tier: _tierOfMethod(method), method: String(method || ''), at: Date.now(),
  });
}

function _recommendedTier(url) {
  const host = _hostOf(url);
  if (!host) return 0;
  const rec = _domainMethodStats.get(host);
  if (!rec) return 0;
  if (DOMAIN_METHOD_TTL_MS > 0 && Date.now() - rec.at > DOMAIN_METHOD_TTL_MS) {
    _domainMethodStats.delete(host);
    return 0;
  }
  return rec.tier;
}

/**
 * Mode A: curl_cffi TLS-impersonation через POST /fetch_html
 * (use_js_render=false). Быстрый обход Cloudflare/DDoS-Guard для статических
 * страниц — «настоящий» TLS-handshake без полноценного браузера. Средний
 * уровень эскалации между axios и Playwright.
 * Возвращает { ok, html?, reason?, status? } — никогда не бросает.
 */
async function _curlCffiFetch(url, proxyUrl = null) {
  if (!CURL_CFFI_ENABLED) {
    return { ok: false, reason: 'curl_cffi_unavailable: fetch_html endpoint not configured' };
  }
  try {
    const body = { url, use_js_render: false, timeout_ms: FETCH_TIMEOUT_MS };
    if (proxyUrl) body.proxy = proxyUrl;
    // Контракт proxy_pool сервиса fetch_html: каждая retry-попытка внутри
    // сервиса берёт следующий прокси из пула (per-domain ротация при 403/429).
    if (PROXY_POOL.length > 1) body.proxy_pool = PROXY_POOL;
    const res = await axios.post(FETCH_HTML_URL, body, {
      timeout: FETCH_TIMEOUT_MS * 3 + 5000,
      maxContentLength: MAX_HTML_BYTES,
      maxBodyLength:    MAX_HTML_BYTES,
      validateStatus: (s) => s >= 200 && s < 300,
      headers: RELEVANCE_INTERNAL_TOKEN
        ? { 'X-Internal-Token': RELEVANCE_INTERNAL_TOKEN }
        : undefined,
    });
    const data = res?.data || {};
    const html = String(data.html || '');
    const status = Number(data.status_code || 0);
    if (data.success && html.trim() && !_looksLikeWafChallenge(html)) {
      return { ok: true, html, status };
    }
    return {
      ok: false,
      status,
      reason: `curl_cffi_fail: ${data.error_msg || `status=${status || 'n/a'}`}`,
    };
  } catch (e) {
    return {
      ok: false,
      status: e?.response?.status || 0,
      reason: `curl_cffi_fail: ${e?.code || e?.message || 'unknown'}`,
    };
  }
}

function _shouldRetry(err) {
  const status = err?.response?.status;
  if (status && RETRY_STATUS_CODES.has(status)) return true;
  const code = err?.code;
  if (!code) return false;
  if (RETRY_ERROR_CODES.has(code)) return true;
  for (const p of RETRY_ERROR_CODE_PREFIXES) {
    if (typeof code === 'string' && code.startsWith(p)) return true;
  }
  return false;
}

/**
 * Зовёт внешний headless-сервис (relevance_fetcher / Playwright).
 * Возвращает структуру { ok, html?, reason?, status? } всегда — никогда null,
 * чтобы вызывающая сторона могла категоризировать причину failed-headless'а
 * как `headless_fail` / `headless_unavailable`, а не молча терять её в `unknown`.
 */
async function _headlessFetch(url, proxyUrl = null) {
  if (!HEADLESS_FETCHER_URL) {
    return { ok: false, reason: 'headless_unavailable: RELEVANCE_HEADLESS_FETCHER_URL not set' };
  }
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
    const status = Number(res?.data?.status || 0);
    if (!html.trim()) {
      return { ok: false, reason: `headless_fail: empty body (status=${status || 'n/a'})`, status };
    }
    if (_looksLikeWafChallenge(html)) {
      return { ok: false, reason: 'headless_fail: WAF challenge in headless body', status, html };
    }
    return { ok: true, html, status };
  } catch (e) {
    const status = e?.response?.status || 0;
    return { ok: false, reason: `headless_fail: ${e?.code || e?.message || 'unknown'}`, status };
  }
}

async function fetchOne(url, opts = {}) {
  const r = await _fetchOneInner(url, opts);
  if (r && r.html) {
    // Per-domain память: запоминаем сработавший метод, чтобы при повторных
    // анализах начинать с этого уровня эскалации.
    _rememberDomainMethod(url, r.method);
  } else if (r) {
    r.category = categoryOf(r.code, r.error);
  }
  return r;
}

async function _fetchOneInner(url, opts = {}) {
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

  // helper: вернуть успех (если headless вернул HTML), иначе null. Также
  // мутирует `lastHeadlessReason` — чтобы при финальном фейле передать его
  // как finalErr.code и категоризовать как `headless_fail`/`headless_unavailable`.
  let lastHeadlessReason = null;
  const _tryHeadless = async (reasonMethod) => {
    if (!HEADLESS_FETCHER_URL) {
      lastHeadlessReason = 'headless_unavailable: RELEVANCE_HEADLESS_FETCHER_URL not set';
      return null;
    }
    const hh = await _headlessFetch(url, proxyUrl);
    if (hh && hh.ok && hh.html) {
      return { url, html: hh.html, method: `headless_${reasonMethod}`, retries_used: retries };
    }
    if (hh && hh.reason) lastHeadlessReason = hh.reason;
    return null;
  };

  // helper: средний уровень эскалации — curl_cffi TLS-impersonation (Mode A).
  // Дешевле headless'а; пробуем ПЕРЕД Playwright при WAF/403/429.
  let curlTried = false;
  let lastCurlReason = null;
  const _tryCurlCffi = async (reasonMethod) => {
    if (!CURL_CFFI_ENABLED || curlTried) return null;
    curlTried = true;
    const cc = await _curlCffiFetch(url, proxyUrl);
    if (cc && cc.ok && cc.html) {
      return { url, html: cc.html, method: `curl_cffi_${reasonMethod}`, retries_used: retries };
    }
    if (cc && cc.reason) lastCurlReason = cc.reason;
    return null;
  };

  // Per-domain память: если для этого домена в прошлый раз сработал более
  // высокий уровень эскалации — начинаем сразу с него, не тратя время на
  // заведомо провальные попытки axios'ом.
  const startTier = _recommendedTier(url);
  if (startTier === 1) {
    const cc = await _tryCurlCffi('remembered');
    if (cc) return cc;
  } else if (startTier >= 2) {
    const hh = await _tryHeadless('remembered');
    if (hh) return hh;
  }

  // Попытка №1 — реальный Chrome + cookie jar (Cloudflare cf_clearance ловится).
  let firstErr = null;
  try {
    const res = await _doFetch(client, url, primaryUa, { proxyAgent });
    const html = String(res.data || '');
    if (!html.trim()) {
      throw Object.assign(new Error('empty body'), { code: 'EMPTY_BODY' });
    }
    // Антибот-челлендж — эскалация: сначала curl_cffi (дешёвый TLS-обход),
    // потом headless (axios даже на retry его не пробьёт, нужно реальное
    // JS-исполнение либо «настоящий» TLS-fingerprint).
    if (_looksLikeWafChallenge(html)) {
      const cc = await _tryCurlCffi('cf_challenge');
      if (cc) return cc;
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
  // IP+TLS). Эскалация: curl_cffi (TLS-impersonation) → headless.
  const firstStatus = firstErr?.response?.status;
  if (firstStatus && FORCE_HEADLESS_STATUSES.has(firstStatus)) {
    const cc = await _tryCurlCffi(`http_${firstStatus}`);
    if (cc) return cc;
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

  // Финальная эскалация: curl_cffi (если ещё не пробовали), затем headless.
  // Это покрывает статические сайты под TLS-fingerprint-фильтром (curl_cffi),
  // SPA, которые без JS вообще ничего не отдают, и WAF-страницы, где axios
  // подряд получает 403/503 (Playwright+stealth).
  {
    const cc = await _tryCurlCffi('last_resort');
    if (cc) return cc;
  }
  if (HEADLESS_FETCHER_URL) {
    const hh = await _headlessFetch(url, proxyUrl);
    if (hh && hh.ok && hh.html) {
      return { url, html: hh.html, method: 'headless_last_resort', retries_used: retries };
    }
    if (hh && hh.reason) lastHeadlessReason = hh.reason;
  }

  const finalErr = secondErr || firstErr;
  // Стратегия итоговой причины:
  //   • Если axios имеет реальный HTTP-статус (404/410/etc) — это и есть
  //     понятная причина, отдаём её.
  //   • Если axios упал с сетевой/timeout/WAF-ошибкой и headless тоже не
  //     помог — отдаём headless-reason: оператору важно видеть, что мы
  //     пробовали и почему всё-таки не получилось.
  const axiosStatus = finalErr?.response?.status;
  const preferHeadlessReason = !!lastHeadlessReason && !axiosStatus;
  result.error = (() => {
    if (preferHeadlessReason) {
      return String(lastHeadlessReason).slice(0, 200);
    }
    const status = axiosStatus || finalErr?.code || 'ERR';
    const msg    = String(finalErr?.message || 'fetch failed').slice(0, 140);
    return `${status}: ${msg}`;
  })();
  if (preferHeadlessReason) {
    result.code = lastHeadlessReason.startsWith('headless_unavailable')
      ? 'headless_unavailable'
      : 'headless_fail';
  } else {
    result.code = _categorize(finalErr);
  }
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
        category: r.category || categoryOf(r.code, r.error),
        retries_used: r.retries_used || 0,
      });
    }
  }
  return { successes, failures };
}

/**
 * fetchHeadlessOnly(urls) — второй проход: дёргаем только headless-сервис
 * для URL, на которых первая стадия (`fetchPages`) не получила HTML.
 * Используется пайплайном, чтобы добрать `successes.length` ближе к
 * `serp.length` — без этого мы остаёмся с «3 из 20» и считаем релевантность
 * по 3 точкам, что и было основной болью оператора.
 *
 * Возвращает контракт идентичный `fetchPages`.
 */
async function fetchHeadlessOnly(urls, opts = {}) {
  const list = (Array.isArray(urls) ? urls : [])
    .map((u) => String(u || '').trim())
    .filter(Boolean);
  if (list.length === 0 || !HEADLESS_FETCHER_URL) {
    return {
      successes: [],
      failures: list.map((u) => ({
        url: u,
        error: 'headless_unavailable: RELEVANCE_HEADLESS_FETCHER_URL not set',
        code: 'headless_unavailable',
        retries_used: 0,
      })),
    };
  }
  const concurrency = Math.max(1, Math.min(FETCH_CONCURRENCY, 4));
  const proxiesEnabled = opts && opts.proxiesEnabled;
  const all = await pMap(list, concurrency, async (u) => {
    const proxyUrl = _pickProxy(proxiesEnabled);
    const hh = await _headlessFetch(u, proxyUrl);
    if (hh && hh.ok && hh.html) {
      return { url: u, html: hh.html, method: 'headless_second_pass', retries_used: 0 };
    }
    return {
      url: u,
      error: (hh && hh.reason) || 'headless_fail: unknown',
      code: hh && hh.reason && hh.reason.startsWith('headless_unavailable')
        ? 'headless_unavailable' : 'headless_fail',
      category: 'headless',
      retries_used: 0,
    };
  });
  const successes = [];
  const failures = [];
  for (const r of all) {
    if (r && r.html) {
      _rememberDomainMethod(r.url, r.method);
      successes.push(r);
    } else failures.push(r);
  }
  return { successes, failures };
}

/**
 * checkHeadlessHealth() — best-effort GET /health внешнего headless-сервиса.
 * Возвращает { available, ok, error?, info? }. Никогда не бросает.
 */
async function checkHeadlessHealth() {
  if (!HEADLESS_FETCHER_URL) {
    return { available: false, ok: false, error: 'RELEVANCE_HEADLESS_FETCHER_URL is empty' };
  }
  try {
    // /fetch вызываем через POST, но /health у `relevance_fetcher` — GET.
    // HEADLESS_FETCHER_URL в конфигах обычно указывают на `/fetch` —
    // подменим хвост на `/health`, чтобы не требовать ещё одной env-переменной.
    const u = new URL(HEADLESS_FETCHER_URL);
    u.pathname = u.pathname.replace(/\/(fetch|fetch_html)\/?$/, '/health');
    const res = await axios.get(u.toString(), {
      timeout: 5000,
      validateStatus: (s) => s >= 200 && s < 300,
      headers: RELEVANCE_INTERNAL_TOKEN
        ? { 'X-Internal-Token': RELEVANCE_INTERNAL_TOKEN } : undefined,
    });
    const info = res?.data || {};
    return { available: true, ok: !!info.ok, info };
  } catch (e) {
    return {
      available: true,
      ok: false,
      error: String(e?.code || e?.message || 'unknown').slice(0, 200),
    };
  }
}

module.exports = {
  fetchPages,
  fetchOne,
  fetchHeadlessOnly,
  checkHeadlessHealth,
  categoryOf,
  FETCH_CONCURRENCY,
  FETCH_TIMEOUT_MS,
  HEADLESS_FETCHER_URL,
  FETCH_HTML_URL,
  CURL_CFFI_ENABLED,
  COOKIE_JAR_AVAILABLE: !!_cookieJarSupport,
  PROXY_AVAILABLE,
  USER_AGENT_POOL,
  // Внутренние помощники per-domain памяти — экспортируем для unit-тестов.
  _tierOfMethod,
  _rememberDomainMethod,
  _recommendedTier,
  _domainMethodStats,
};
