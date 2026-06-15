'use strict';

/**
 * Поиск страницы контактов на сайте.
 *
 * Стратегия (Step 2 ТЗ):
 *   1. На главной странице ищем все <a> с href или текстом, содержащими
 *      ключи: контакты / contact / о нас / about / реквизиты / связаться.
 *   2. Дедуплицируем, нормализуем относительные URL, исключаем mailto:/tel:/#.
 *   3. Сортируем по «силе» сигнала: точное совпадение пути > совпадение
 *      слова в href > слово в тексте.
 *   4. Если ни одна ссылка не найдена — пайплайн возьмёт контакты с
 *      главной (часто из футера).
 */

const cheerio = require('cheerio');

// Ключевые слова в href / тексте — порядок задаёт приоритет.
const CONTACT_KEYWORDS = [
  // RU
  'контакт', 'контакты', 'связаться', 'связь',
  'реквизит', 'реквизиты', 'о компании', 'о нас', 'о&nbsp;нас',
  'about', 'about-us', 'aboutus',
  // EN
  'contact', 'contacts', 'get-in-touch', 'reach-us',
];

// Точные «канонические» пути — самый сильный сигнал.
const STRONG_PATH_RE = /(^|\/)(contacts?|kontakty|kontakti|contact-us|contact_us|svyaz|svyazatsya|company\/contacts|about(?:-us)?|o-?nas|o-kompani[ie]|requisites|rekvizity)\/?$/i;

const MAX_RESULTS = 6;

function _abs(href, base) {
  try {
    return new URL(href, base).toString();
  } catch (_) {
    return null;
  }
}

function _scoreLink(absUrl, text, baseHost) {
  if (!absUrl) return -1;
  let url;
  try { url = new URL(absUrl); } catch (_) { return -1; }
  // Не уходим на чужие хосты (соцсети, мессенджеры) — контакты ищем
  // строго на том же сайте.
  if (url.hostname.replace(/^www\./, '') !== baseHost.replace(/^www\./, '')) return -1;
  let score = 0;
  const path = url.pathname.toLowerCase();
  if (STRONG_PATH_RE.test(path)) score += 10;
  const lowText = (text || '').toLowerCase();
  for (const k of CONTACT_KEYWORDS) {
    if (path.includes(k)) score += 4;
    if (lowText.includes(k)) score += 2;
  }
  // /contacts/ короче /faq/contacts/feedback — короткий путь предпочтительнее.
  if (score > 0) score -= Math.min(3, Math.floor(path.length / 50));
  return score;
}

/**
 * Возвращает массив URL потенциальных страниц контактов, отсортированный
 * по убыванию релевантности. Никогда не бросает — при ошибках парсинга
 * возвращает пустой массив.
 *
 * @param {string} html — сырой HTML главной (или любой) страницы
 * @param {string} baseUrl — URL, относительно которого нормализуем href
 */
function findContactLinks(html, baseUrl) {
  if (!html || !baseUrl) return [];
  let $;
  try { $ = cheerio.load(html); } catch (_) { return []; }
  let baseHost;
  try { baseHost = new URL(baseUrl).hostname; } catch (_) { return []; }

  const candidates = new Map(); // absUrl → bestScore
  $('a[href]').each((_, el) => {
    const $el = $(el);
    const href = ($el.attr('href') || '').trim();
    if (!href) return;
    const abs = _abs(href, baseUrl);
    if (!abs) return;
    // Принимаем ТОЛЬКО http(s) — это блокирует javascript:, data:, vbscript:,
    // mailto:, tel:, file:, ftp:, blob:, и любую другую неожиданную схему,
    // полученную через href.
    let absUrl;
    try { absUrl = new URL(abs); } catch (_) { return; }
    if (!/^https?:$/i.test(absUrl.protocol)) return;
    const text = ($el.text() || '').trim();
    const sc = _scoreLink(abs, text, baseHost);
    if (sc <= 0) return;
    const prev = candidates.get(abs);
    if (prev == null || sc > prev) candidates.set(abs, sc);
  });

  return [...candidates.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_RESULTS)
    .map(([url]) => url);
}

module.exports = {
  findContactLinks,
  CONTACT_KEYWORDS,
};
