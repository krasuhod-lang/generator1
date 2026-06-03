'use strict';

/**
 * XMLStock client — server-side fetch ТОП-выдачи Яндекса по ключу.
 * Порт логики из beta-версии Title-v25.html (fetchYandexSerp).
 *
 * URL XMLStock с пользовательским ключом захардкожен по требованию заказчика;
 * можно переопределить через env XMLSTOCK_URL для смены аккаунта без правки кода.
 */

const axios   = require('axios');
const cheerio = require('cheerio');

const DEFAULT_XMLSTOCK_URL =
  'https://xmlstock.com/yandex/xml/?user=11366&key=c5749016aa8fa5f13378b6557c97d4e5';

const XMLSTOCK_URL = (process.env.XMLSTOCK_URL || DEFAULT_XMLSTOCK_URL).trim();

// Google-выдача снимается тем же аккаунтом xmlstock, отличается только путь
// (/google/xml/ вместо /yandex/xml/). По умолчанию выводим Google-URL из
// основного XMLSTOCK_URL (тот же user/key), но можно переопределить отдельно
// через env XMLSTOCK_GOOGLE_URL без правки кода.
const DEFAULT_GOOGLE_XMLSTOCK_URL = XMLSTOCK_URL.replace(
  /\/yandex\/xml\//i,
  '/google/xml/',
);

const GOOGLE_XMLSTOCK_URL =
  (process.env.XMLSTOCK_GOOGLE_URL || DEFAULT_GOOGLE_XMLSTOCK_URL).trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Сжимает пробелы в одну строку. cheerio `.text()` уже корректно убирает
 * любую XML-разметку (включая вложенные `<hlword>...</hlword>`-маркеры
 * подсветки от Яндекса), поэтому regex-стриппинг тегов нам не нужен —
 * это и безопаснее (нет риска неполной санитизации многосимвольных
 * последовательностей вроде `<scrip<script>t>`), и быстрее.
 */
function collapseWs(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Разбирает одну XML-страницу ответа xmlstock (общий формат для Яндекса и
 * Google) в массив {title, snippet, url}. Бросает при <error> от API.
 */
function _extractDocsFromXml(xmlText) {
  // cheerio с xmlMode корректно парсит namespace-free XML xmlstock.
  const $ = cheerio.load(String(xmlText || ''), { xmlMode: true });

  // xmlstock при ошибке возвращает <error>текст</error>
  const errNode = $('error').first();
  if (errNode.length) {
    throw new Error(`XMLStock API error: ${errNode.text().trim()}`);
  }

  const docs = [];
  $('doc').each((_, el) => {
    const $doc = $(el);
    // cheerio `.text()` рекурсивно собирает все текстовые узлы и полностью
    // игнорирует разметку — `<hlword>цена</hlword>` даст просто «цена».
    const title = collapseWs($doc.find('title').first().text());
    const link = $doc.find('url').first().text().trim();
    const headline = collapseWs($doc.find('headline').first().text());
    const passages = $doc.find('passages passage')
      .map((__, p) => collapseWs($(p).text()))
      .get()
      .filter(Boolean);
    const snippet = [headline, ...passages].filter(Boolean).join(' ');
    if (title) docs.push({ title, snippet, url: link });
  });
  return docs;
}

/**
 * Запрашивает страницы XMLStock (по 10 doc на странице) → итого до ~`pages*10`.
 * При сетевой ошибке/5xx делает до 3 попыток с паузой 3s.
 *
 * @param {string} keyword       — поисковый запрос
 * @param {object} [opts]
 * @param {string} [opts.lr]         — yandex region (если не задан — без &lr)
 * @param {number} [opts.pages]      — сколько страниц забирать (по умолчанию 2)
 * @param {number} [opts.startPage]  — индекс первой страницы XMLStock (по
 *   умолчанию 0). XMLStock индексирует страницы от 0: page=0 — позиции 1-10,
 *   page=1 — 11-20, page=2 — 21-30, и т.д. Используется для «добора» URL со
 *   страницы 3 SERP, когда после dedup осталось мало результатов.
 * @returns {Promise<Array<{title, snippet, url}>>}
 */
async function fetchYandexSerp(keyword, opts = {}) {
  const { lr = '', pages = 2, startPage = 0 } = opts;
  const baseUrl = XMLSTOCK_URL;
  // Параметры идентичны beta-версии:
  //   groupby=attr=''.mode=flat.groups-on-page=10.docs-in-group=1
  const groupBy =
    'attr%3D%22%22.mode%3Dflat.groups-on-page%3D10.docs-in-group%3D1';
  const sep = baseUrl.includes('?') ? '&' : '?';

  const maxRetries = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const extracted = [];
      for (let page = startPage; page < startPage + pages; page += 1) {
        const lrPart = lr ? `&lr=${encodeURIComponent(String(lr).trim())}` : '';
        const url =
          `${baseUrl}${sep}query=${encodeURIComponent(keyword)}` +
          `&groupby=${groupBy}${lrPart}&page=${page}`;

        const res = await axios.get(url, {
          timeout: 30000,
          // XMLStock возвращает XML — отдаём строкой, не пытаемся auto-parse.
          responseType: 'text',
          transformResponse: [(d) => d],
          // При 4xx/5xx бросаем — поймаем в catch и сделаем retry или выйдем.
          validateStatus: (s) => s >= 200 && s < 300,
        });

        const xmlText = String(res.data || '');
        const docs = _extractDocsFromXml(xmlText);
        for (const d of docs) extracted.push(d);
      }

      if (extracted.length === 0) {
        throw new Error('Пустой SERP (нет результатов от XMLStock)');
      }
      return extracted;
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        await sleep(3000);
      }
    }
  }
  throw new Error(`XMLStock: ${lastErr?.message || 'unknown error'}`);
}

/**
 * Запрашивает ТОП-выдачу Google через xmlstock (тот же аккаунт/ключ, путь
 * /google/xml/). Используется для верификации каннибализации/слияния разделов
 * по реальной поисковой выдаче. Формат ответа совпадает с Яндексом.
 *
 * @param {string} keyword       — поисковый запрос
 * @param {object} [opts]
 * @param {number} [opts.pages]      — сколько страниц забирать (по умолчанию 2 → топ-20)
 * @param {number} [opts.startPage]  — индекс первой страницы (xmlstock от 0)
 * @param {string} [opts.lr]         — регион/локация (если поддерживается аккаунтом)
 * @param {string} [opts.domain]     — google-домен (например google.ru)
 * @param {string} [opts.device]     — desktop|mobile|tablet
 * @returns {Promise<Array<{title, snippet, url}>>}
 */
async function fetchGoogleSerp(keyword, opts = {}) {
  const {
    pages = 2, startPage = 0, lr = '', domain = '', device = '',
  } = opts;
  const baseUrl = GOOGLE_XMLSTOCK_URL;
  const groupBy =
    'attr%3D%22%22.mode%3Dflat.groups-on-page%3D10.docs-in-group%3D1';
  const sep = baseUrl.includes('?') ? '&' : '?';

  const maxRetries = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const extracted = [];
      for (let page = startPage; page < startPage + pages; page += 1) {
        const lrPart = lr ? `&lr=${encodeURIComponent(String(lr).trim())}` : '';
        const domainPart = domain
          ? `&domain=${encodeURIComponent(String(domain).trim())}` : '';
        const devicePart = device
          ? `&device=${encodeURIComponent(String(device).trim())}` : '';
        const url =
          `${baseUrl}${sep}query=${encodeURIComponent(keyword)}` +
          `&groupby=${groupBy}${lrPart}${domainPart}${devicePart}&page=${page}`;

        const res = await axios.get(url, {
          timeout: 30000,
          responseType: 'text',
          transformResponse: [(d) => d],
          validateStatus: (s) => s >= 200 && s < 300,
        });

        const docs = _extractDocsFromXml(String(res.data || ''));
        for (const d of docs) extracted.push(d);
      }

      if (extracted.length === 0) {
        throw new Error('Пустой SERP (нет результатов от XMLStock/Google)');
      }
      return extracted;
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        await sleep(3000);
      }
    }
  }
  throw new Error(`XMLStock(Google): ${lastErr?.message || 'unknown error'}`);
}

module.exports = {
  fetchYandexSerp, fetchGoogleSerp, XMLSTOCK_URL, GOOGLE_XMLSTOCK_URL,
};
