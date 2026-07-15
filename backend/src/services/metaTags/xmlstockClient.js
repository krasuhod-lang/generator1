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

// ── Бесперебойность парсинга ───────────────────────────────────────────────
// XMLStock обрабатывает запрос асинхронно: сразу после постановки в очередь он
// может вернуть «мягкую» ошибку <error>Запрос еще не обработан, попробуйте
// позже</error>. Это НЕ фатальная ошибка — нужно подождать и повторить тот же
// запрос (поллинг). Раньше клиент делал только 3 быстрые попытки с паузой 3s и
// при не успевшей обработке отдавал ошибку наружу («Запрос еще не обработан»),
// из-за чего падали ВСЕ функции на базе SERP (релевантность, мета-теги,
// serp-evidence, проверка каннибализации). Теперь такие транзиентные ошибки
// поллим отдельно — с увеличенным числом попыток и нарастающей паузой.
const _envInt = (name, def) => {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : def;
};

// Сетевые/5xx сбои — короткий ретрай (как и раньше).
const NETWORK_RETRIES = _envInt('XMLSTOCK_NETWORK_RETRIES', 3);
const NETWORK_DELAY_MS = _envInt('XMLSTOCK_NETWORK_DELAY_MS', 3000);
// Транзиентные API-ошибки («ещё не обработан») — поллинг с бэкоффом.
const TRANSIENT_RETRIES = _envInt('XMLSTOCK_TRANSIENT_RETRIES', 8);
const TRANSIENT_BASE_DELAY_MS = _envInt('XMLSTOCK_TRANSIENT_DELAY_MS', 3000);
const TRANSIENT_MAX_DELAY_MS = _envInt('XMLSTOCK_TRANSIENT_MAX_DELAY_MS', 15000);

// Сигнатуры «мягких» (транзиентных) ошибок XMLStock — запрос принят, но ещё не
// готов / временный лимит. Их нужно ПОЛЛИТЬ, а не падать. Исчерпание квоты
// («Превышен лимит», «Not enough money») сюда НЕ входит — это фатально.
const TRANSIENT_ERROR_PATTERNS = [
  /не\s+обработан/i,
  /попробуйте\s+(?:позже|поздней|чуть\s+позже|через)/i,
  /повторите\s+(?:запрос|попытку|позже)/i,
  /в\s+очеред/i, // «запрос в очереди»
  /not\s+(?:yet\s+)?(?:ready|processed|complete)/i,
  /try\s+again\s+later/i,
  /temporar/i, // temporarily unavailable
  /still\s+processing/i,
];

function _isTransientErrorMessage(msg) {
  const text = String(msg || '');
  return TRANSIENT_ERROR_PATTERNS.some((re) => re.test(text));
}

/** Пауза с экспоненциальным бэкоффом (с потолком) для поллинга XMLStock. */
function _transientDelay(attempt) {
  const ms = TRANSIENT_BASE_DELAY_MS * 2 ** (attempt - 1);
  return Math.min(ms, TRANSIENT_MAX_DELAY_MS);
}

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
 * Детерминированно размечает тип сниппета и видимые SERP-фичи.
 */
function _deriveSerpFeatures(titleOrDescription, maybeDescription) {
  const description = maybeDescription == null ? titleOrDescription : maybeDescription;
  const text = maybeDescription == null
    ? String(titleOrDescription || '')
    : `${titleOrDescription || ''} ${maybeDescription || ''}`;
  return {
    type: String(description || '').length > 160 ? 'extended' : 'regular',
    has_date: /(?:\b20\d{2}\b|\b\d{1,2}[./-]\d{1,2}[./-](?:20)?\d{2}\b)/i.test(text),
    has_price: /(?:руб(?:\.|лей)?|₽|цен[ауы]?|(?:^|\s)от\s+\d)/i.test(text),
    has_rating: /(?:★|рейтинг|отзыв|\b\d[.,]\d\s+из\s+5\b)/i.test(text),
  };
}

/**
 * Разбирает одну XML-страницу ответа xmlstock (общий формат для Яндекса и
 * Google) в массив {title, snippet, url, serp_title, serp_description,
 * serp_features}. Бросает при <error> от API.
 */
function _extractDocsFromXml(xmlText) {
  // cheerio с xmlMode корректно парсит namespace-free XML xmlstock.
  const $ = cheerio.load(String(xmlText || ''), { xmlMode: true });

  // xmlstock при ошибке возвращает <error>текст</error>
  const errNode = $('error').first();
  if (errNode.length) {
    const msg = errNode.text().trim();
    const err = new Error(`XMLStock API error: ${msg}`);
    // Помечаем «мягкие» ошибки (запрос ещё не обработан) — их поллим, а не падаем.
    err.transient = _isTransientErrorMessage(msg);
    throw err;
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
    if (title) {
      docs.push({
        title,
        snippet,
        url: link,
        serp_title: title,
        serp_description: snippet,
        serp_features: _deriveSerpFeatures(title, snippet),
        serp_position: docs.length + 1,
      });
    }
  });
  return docs;
}

/**
 * Бесперебойно тянет ОДНУ страницу XMLStock по готовому URL и парсит её в
 * массив doc'ов. Транзиентные ошибки («Запрос ещё не обработан») поллит с
 * нарастающей паузой; сетевые/5xx — короткий ретрай. Бросает только когда все
 * попытки исчерпаны или ошибка фатальна (например, исчерпан лимит ключа).
 *
 * @param {string} url       — полный URL запроса к XMLStock
 * @param {string} [label]   — префикс для логов (yandex|google)
 * @returns {Promise<Array<{title, snippet, url}>>}
 */
async function _fetchSerpPage(url, label = 'xmlstock') {
  let lastErr = null;
  // Транзиентные попытки считаем отдельно от сетевых, чтобы «не обработан»
  // поллился долго, а сетевой сбой не висел бесконечно.
  let transientAttempt = 0;
  let networkAttempt = 0;

  // Общий потолок итераций — защита от бесконечного цикла.
  const maxIters = TRANSIENT_RETRIES + NETWORK_RETRIES + 2;
  for (let iter = 0; iter < maxIters; iter += 1) {
    try {
      const res = await axios.get(url, {
        timeout: 30000,
        // XMLStock возвращает XML — отдаём строкой, не пытаемся auto-parse.
        responseType: 'text',
        transformResponse: [(d) => d],
        validateStatus: (s) => s >= 200 && s < 300,
      });
      return _extractDocsFromXml(String(res.data || ''));
    } catch (err) {
      lastErr = err;
      if (err && err.transient) {
        transientAttempt += 1;
        if (transientAttempt > TRANSIENT_RETRIES) break;
        const delay = _transientDelay(transientAttempt);
        // eslint-disable-next-line no-console
        console.warn(
          `[${label}] запрос ещё не обработан (попытка ${transientAttempt}/${TRANSIENT_RETRIES}), `
          + `ждём ${delay}ms и повторяем…`,
        );
        await sleep(delay);
        continue;
      }
      // Сетевая/прочая ошибка — короткий ретрай.
      networkAttempt += 1;
      if (networkAttempt > NETWORK_RETRIES) break;
      await sleep(NETWORK_DELAY_MS);
    }
  }
  throw lastErr || new Error('XMLStock: unknown error');
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

  // Каждую страницу тянем бесперебойно (с поллингом транзиентных ошибок).
  // Накапливаем результат постранично — успешно полученные страницы не
  // теряются, даже если последняя не наберётся.
  const extracted = [];
  let lastErr = null;
  for (let page = startPage; page < startPage + pages; page += 1) {
    const lrPart = lr ? `&lr=${encodeURIComponent(String(lr).trim())}` : '';
    const url =
      `${baseUrl}${sep}query=${encodeURIComponent(keyword)}` +
      `&groupby=${groupBy}${lrPart}&page=${page}`;
    try {
      const docs = await _fetchSerpPage(url, 'yandex');
      for (const d of docs) extracted.push({ ...d, serp_position: extracted.length + 1 });
    } catch (err) {
      lastErr = err;
      // Если хоть что-то уже набрали — не валим весь запрос из-за одной
      // недобравшейся страницы (best-effort добор).
      if (extracted.length) break;
    }
  }

  if (extracted.length === 0) {
    throw new Error(`XMLStock: ${lastErr?.message || 'Пустой SERP (нет результатов от XMLStock)'}`);
  }
  return extracted;
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
    pages = 2, startPage = 0, lr = '', domain = '', device = '', loc = '',
  } = opts;
  const baseUrl = GOOGLE_XMLSTOCK_URL;
  const groupBy =
    'attr%3D%22%22.mode%3Dflat.groups-on-page%3D10.docs-in-group%3D1';
  const sep = baseUrl.includes('?') ? '&' : '?';

  const extracted = [];
  let lastErr = null;
  for (let page = startPage; page < startPage + pages; page += 1) {
    const lrPart = lr ? `&lr=${encodeURIComponent(String(lr).trim())}` : '';
    const domainPart = domain
      ? `&domain=${encodeURIComponent(String(domain).trim())}` : '';
    const devicePart = device
      ? `&device=${encodeURIComponent(String(device).trim())}` : '';
    // Google-вариант гео — параметр `loc` (строка вида "Moscow,Moscow,Russia").
    const locPart = loc
      ? `&loc=${encodeURIComponent(String(loc).trim())}` : '';
    const url =
      `${baseUrl}${sep}query=${encodeURIComponent(keyword)}` +
      `&groupby=${groupBy}${lrPart}${domainPart}${devicePart}${locPart}&page=${page}`;
    try {
      const docs = await _fetchSerpPage(url, 'google');
      for (const d of docs) extracted.push({ ...d, serp_position: extracted.length + 1 });
    } catch (err) {
      lastErr = err;
      if (extracted.length) break;
    }
  }

  if (extracted.length === 0) {
    throw new Error(`XMLStock(Google): ${lastErr?.message || 'Пустой SERP (нет результатов от XMLStock/Google)'}`);
  }
  return extracted;
}

module.exports = {
  fetchYandexSerp, fetchGoogleSerp, XMLSTOCK_URL, GOOGLE_XMLSTOCK_URL,
  _extractDocsFromXml, _deriveSerpFeatures,
};
