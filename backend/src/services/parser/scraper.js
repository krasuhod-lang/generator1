'use strict';

const axios           = require('axios');
const https           = require('https');
const cheerio         = require('cheerio');
const { Readability } = require('@mozilla/readability');
const { JSDOM }       = require('jsdom');
const TurndownService = require('turndown');

// -----------------------------------------------------------------
// User-Agent rotation
// -----------------------------------------------------------------
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
];

const getRandomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// -----------------------------------------------------------------
// Утилиты валидации и нормализации URL
// -----------------------------------------------------------------

// Коды ошибок цепочки SSL — для них допускаем мягкую повторную попытку.
const SSL_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_NOT_YET_VALID',
]);

// Сетевые ошибки, на которых имеет смысл ретраить.
const RETRYABLE_NET_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN',
  'ENOTFOUND', 'EPIPE', 'ECONNREFUSED', 'EHOSTUNREACH', 'EPROTO',
]);

// Мягкий HTTPS-агент с отключённой проверкой сертификата.
// Используется ИСКЛЮЧИТЕЛЬНО как fallback при ошибках цепочки SSL
// (см. SSL_ERROR_CODES) для скрейпинга публичного HTML конкурентов.
// Никаких чувствительных данных мы наружу не отправляем — только GET.
// codeql[js/disabling-certificate-validation] — осознанный fallback для парсера.
const sslAgent = new https.Agent({ rejectUnauthorized: false });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Нормализует строку в валидный URL или возвращает null.
 * Поддерживает:
 *   - голый домен ("example.com/page") → "https://example.com/page"
 *   - markdown-обёртку "[текст](url)" → url
 *   - HTML-обёртку <https://...> → https://...
 *   - trailing-знаки препинания и кавычки
 * Возвращает null для строк, которые не похожи на URL (например, "Sputnik8", "Трипсе").
 */
function sanitizeUrl(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;

  // Markdown link [text](url) — берём url
  const mdMatch = s.match(/\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/i);
  if (mdMatch) s = mdMatch[1];

  // Угловые скобки <url>
  s = s.replace(/^<+|>+$/g, '');

  // Маркеры списка / нумерация / кавычки в начале
  s = s.replace(/^[\s\-*•·#0-9.)\]\u2022>"'«»]+/, '');
  // Хвостовая пунктуация
  s = s.replace(/[\s,;.!?»"'><)\]]+$/g, '');

  if (!s) return null;

  // Если нет схемы — пробуем добавить https://
  let candidate = s;
  if (!/^https?:\/\//i.test(candidate)) {
    // Должен быть похож на домен: содержит точку и не содержит пробелов / кириллицы вне IDN
    if (!/^[^\s]+\.[^\s]+$/.test(candidate)) return null;
    candidate = 'https://' + candidate;
  }

  try {
    const u = new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname || !u.hostname.includes('.')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------
// Один запрос (без ретраев) — возвращает { responseData, finalUrl } или бросает.
// -----------------------------------------------------------------
async function fetchOnce(url, timeout, { insecureSSL = false } = {}) {
  const userAgent = getRandomUA();
  const response = await axios.get(url, {
    timeout,
    headers: {
      'User-Agent':      userAgent,
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control':   'no-cache',
    },
    maxRedirects: 5,
    responseType: 'text',
    httpsAgent:   insecureSSL ? sslAgent : undefined,
    // По умолчанию axios считает 4xx/5xx ошибками — оставляем как есть.
  });
  return {
    responseData: response.data,
    finalUrl:     response.request?.res?.responseUrl || url,
  };
}

function classifyError(err) {
  const code   = err?.code || err?.cause?.code || '';
  const status = err?.response?.status;
  const msg    = (err?.message || '').toLowerCase();

  if (code && SSL_ERROR_CODES.has(code))                         return 'ssl';
  if (msg.includes('unable to verify') || msg.includes('certificate')) return 'ssl';
  if (code === 'ECONNABORTED' || msg.includes('timeout'))        return 'timeout';
  if (RETRYABLE_NET_CODES.has(code))                             return 'network';
  if (status === 429 || (status >= 500 && status <= 599))        return 'http_retry';
  if (status >= 400 && status < 500)                             return 'http_client';
  return 'other';
}

// -----------------------------------------------------------------
// scrapeUrl(url, timeout?)
// Возвращает { url, title, markdown }.
// Делает до 3 попыток (1 базовая + 2 ретрая) с экспоненциальным backoff
// на сетевых ошибках, 429 и 5xx. На SSL-ошибке цепочки делает одну
// дополнительную мягкую попытку с rejectUnauthorized:false.
// -----------------------------------------------------------------
async function scrapeUrl(url, timeout = 30000) {
  let responseData;
  let finalUrl = url;

  const maxAttempts = 3;
  // Один раз за весь жизненный цикл запроса разрешаем мягкий SSL-фоллбек.
  // Если сертификат битый — пробуем с rejectUnauthorized:false. Если и это
  // упало с сетевой ошибкой/5xx — продолжаем обычные ретраи (уже без
  // сброса флага), не останавливаем процесс на одном плохом ответе.
  let sslFallbackUsed = false;

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      ({ responseData, finalUrl } = await fetchOnce(url, timeout, { insecureSSL: sslFallbackUsed }));
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      const kind = classifyError(err);

      // SSL-ошибка цепочки → один раз пробуем без проверки сертификата
      // прямо сейчас, не сжигая ретрай.
      if (kind === 'ssl' && !sslFallbackUsed) {
        sslFallbackUsed = true;
        try {
          ({ responseData, finalUrl } = await fetchOnce(url, timeout, { insecureSSL: true }));
          lastErr = null;
          break;
        } catch (err2) {
          lastErr = err2;
          const kind2 = classifyError(err2);
          // Если и в insecure-режиме это не сетевая/5xx — выходим.
          if (kind2 !== 'network' && kind2 !== 'timeout' && kind2 !== 'http_retry') {
            throw new Error(`scrapeUrl fetch failed for ${url}: ${err2.message}`);
          }
          // Иначе — продолжим обычный ретрай-цикл (sslFallbackUsed=true сохранится).
        }
      } else if (kind !== 'network' && kind !== 'timeout' && kind !== 'http_retry') {
        // Не ретраим клиентские 4xx (кроме 429), повторные SSL и неклассифицируемые.
        throw new Error(`scrapeUrl fetch failed for ${url}: ${err.message}`);
      }

      if (attempt === maxAttempts) {
        throw new Error(`scrapeUrl fetch failed for ${url}: ${lastErr.message}`);
      }

      // Backoff перед следующей попыткой:
      //   первая повторная попытка ≈ 600ms, вторая ≈ 1800ms (+ до 200ms джиттера)
      const backoff = 600 * Math.pow(3, attempt - 1) + Math.floor(Math.random() * 200);
      await sleep(backoff);
    }
  }

  if (lastErr && !responseData) {
    throw new Error(`scrapeUrl fetch failed for ${url}: ${lastErr.message}`);
  }

  // -----------------------------------------------------------------
  // Попытка 1: Mozilla Readability (чистит рекламу, боковые панели)
  // -----------------------------------------------------------------
  try {
    const dom    = new JSDOM(responseData, { url: finalUrl });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (article && article.content && article.content.length > 200) {
      const turndown = new TurndownService({
        headingStyle:     'atx',
        bulletListMarker: '-',
        codeBlockStyle:   'fenced',
      });
      // Убираем навигацию и таблицы, они дают мусор
      turndown.addRule('removeNav', {
        filter: ['nav', 'footer', 'aside'],
        replacement: () => '',
      });

      const markdown = turndown.turndown(article.content);

      return {
        url:      finalUrl,
        title:    article.title || '',
        markdown: markdown.substring(0, 12000),
      };
    }
  } catch (_) {
    // Readability упал — переходим к fallback
  }

  // -----------------------------------------------------------------
  // Попытка 2: Fallback через Cheerio — ручная очистка DOM
  // -----------------------------------------------------------------
  const $ = cheerio.load(responseData);

  // Удаляем мусорные элементы
  $(
    'script, style, noscript, nav, footer, header, ' +
    '.menu, .sidebar, .ads, .advertisement, .cookie, ' +
    '.popup, .modal, .banner, [role="navigation"], ' +
    '[role="banner"], [role="complementary"]'
  ).remove();

  const title    = $('title').text().trim() || $('h1').first().text().trim();
  const bodyText = $('body').text().replace(/\s{2,}/g, ' ').trim();

  return {
    url:      finalUrl,
    title,
    markdown: bodyText.substring(0, 12000),
  };
}

// -----------------------------------------------------------------
// scrapeCompetitors(urls[])
// Параллельный парсинг — возвращает массив:
//   { url, content, title, error, timedOut, invalidUrl, sslIssue }
// Невалидные строки (бренды без схемы, "Sputnik8" и т.п.) отсеиваются
// ДО сети с понятным сообщением. Один провалившийся URL не убивает всё.
// -----------------------------------------------------------------
async function scrapeCompetitors(rawUrls, timeoutMs = 30000) {
  // Пара: оригинальная строка → нормализованный URL (или null)
  const items = rawUrls.map(raw => ({
    raw:        raw,
    normalized: sanitizeUrl(raw),
  }));

  const results = await Promise.allSettled(
    items.map(item => item.normalized
      ? scrapeUrl(item.normalized, timeoutMs)
      : Promise.reject(new Error(`Invalid URL — "${item.raw}" не похоже на ссылку`))
    )
  );

  return results.map((result, i) => {
    const { raw, normalized } = items[i];
    const reportedUrl         = normalized || raw;

    if (result.status === 'fulfilled') {
      return {
        url:        result.value.url || reportedUrl,
        content:    result.value.markdown,
        title:      result.value.title,
        error:      null,
        timedOut:   false,
        invalidUrl: false,
        sslIssue:   false,
      };
    }

    const errMsg     = result.reason?.message || String(result.reason);
    const lowerMsg   = errMsg.toLowerCase();
    const invalidUrl = !normalized;
    const isTimeout  = !invalidUrl && (lowerMsg.includes('timeout') ||
                                       lowerMsg.includes('econnaborted') ||
                                       lowerMsg.includes('etimedout'));
    const isSSL      = !invalidUrl && (lowerMsg.includes('unable to verify') ||
                                       lowerMsg.includes('certificate') ||
                                       lowerMsg.includes('ssl'));

    if (invalidUrl) {
      console.warn(`[scraper] Invalid URL — skipped: "${raw}"`);
    } else if (isTimeout) {
      console.warn(`[scraper] Timeout (${timeoutMs}ms) for ${reportedUrl} — skipped`);
    } else {
      console.warn(`[scraper] Failed to fetch ${reportedUrl}: ${errMsg}`);
    }

    return {
      url:        reportedUrl,
      content:    '',
      title:      '',
      error:      isTimeout ? `Таймаут ${timeoutMs / 1000}s — ${reportedUrl}` : errMsg,
      timedOut:   isTimeout,
      invalidUrl,
      sslIssue:   isSSL,
    };
  });
}

module.exports = { scrapeUrl, scrapeCompetitors, sanitizeUrl };
