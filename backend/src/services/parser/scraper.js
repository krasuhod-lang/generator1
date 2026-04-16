'use strict';

const axios           = require('axios');
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
// scrapeUrl(url, timeout?)
// Возвращает { url, title, markdown }
// -----------------------------------------------------------------
async function scrapeUrl(url, timeout = 20000) {
  const userAgent = getRandomUA();

  let responseData;
  let finalUrl = url;

  try {
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
    });
    responseData = response.data;
    finalUrl     = response.request?.res?.responseUrl || url;
  } catch (err) {
    throw new Error(`scrapeUrl fetch failed for ${url}: ${err.message}`);
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
// Параллельный парсинг — возвращает массив { url, content, title, error, timedOut }
// Один провалившийся URL не убивает весь пайплайн.
// -----------------------------------------------------------------
async function scrapeCompetitors(urls, timeoutMs = 20000) {
  const results = await Promise.allSettled(
    urls.map(url => scrapeUrl(url, timeoutMs))
  );

  return results.map((result, i) => {
    if (result.status === 'fulfilled') {
      return {
        url:      urls[i],
        content:  result.value.markdown,
        title:    result.value.title,
        error:    null,
        timedOut: false,
      };
    }

    const errMsg    = result.reason?.message || String(result.reason);
    const isTimeout = errMsg.toLowerCase().includes('timeout') ||
                      errMsg.toLowerCase().includes('econnaborted') ||
                      errMsg.toLowerCase().includes('etimedout');

    // WARNING-лог идёт в консоль воркера; ошибку отдаём в error для SSE-лога
    if (isTimeout) {
      console.warn(`[scraper] Timeout (${timeoutMs}ms) for ${urls[i]} — skipped`);
    } else {
      console.warn(`[scraper] Failed to fetch ${urls[i]}: ${errMsg}`);
    }

    return {
      url:      urls[i],
      content:  '',
      title:    '',
      error:    isTimeout ? `Таймаут ${timeoutMs / 1000}s — ${urls[i]}` : errMsg,
      timedOut: isTimeout,
    };
  });
}

module.exports = { scrapeUrl, scrapeCompetitors };
