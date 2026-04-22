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
 * Запрашивает 2 страницы XMLStock (по 10 doc на странице) → итого до ~20 результатов.
 * При сетевой ошибке/5xx делает до 3 попыток с паузой 3s.
 *
 * @param {string} keyword       — поисковый запрос
 * @param {object} [opts]
 * @param {string} [opts.lr]     — yandex region (если не задан — без &lr)
 * @param {number} [opts.pages]  — сколько страниц забирать (по умолчанию 2)
 * @returns {Promise<Array<{title, snippet, url}>>}
 */
async function fetchYandexSerp(keyword, opts = {}) {
  const { lr = '', pages = 2 } = opts;
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
      for (let page = 0; page < pages; page += 1) {
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
        // cheerio с xmlMode корректно парсит namespace-free XML XMLStock.
        const $ = cheerio.load(xmlText, { xmlMode: true });

        // XMLStock при ошибке возвращает <error>текст</error>
        const errNode = $('error').first();
        if (errNode.length) {
          throw new Error(`XMLStock API error: ${errNode.text().trim()}`);
        }

        $('doc').each((_, el) => {
          const $doc = $(el);
          // cheerio `.text()` рекурсивно собирает все текстовые узлы и
          // полностью игнорирует разметку — `<hlword>цена</hlword>` даст
          // просто «цена» без следов тегов.
          const title = collapseWs($doc.find('title').first().text());
          const link  = $doc.find('url').first().text().trim();
          const headline = collapseWs($doc.find('headline').first().text());
          const passages = $doc.find('passages passage')
            .map((__, p) => collapseWs($(p).text()))
            .get()
            .filter(Boolean);
          const snippet = [headline, ...passages].filter(Boolean).join(' ');
          if (title) {
            extracted.push({ title, snippet, url: link });
          }
        });
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

module.exports = { fetchYandexSerp, XMLSTOCK_URL };
