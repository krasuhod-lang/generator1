'use strict';

/**
 * Поиск страниц с контактами / реквизитами на сайте.
 *
 * Стратегия (Step 2 ТЗ):
 *   1. На главной странице ищем все <a> с href или текстом, содержащими
 *      ключи нескольких категорий: contacts / requisites / about /
 *      privacy-policy / terms-agreement.
 *   2. Дедуплицируем, нормализуем относительные URL, исключаем
 *      mailto:/tel:/javascript:/# и любые ссылки на чужие хосты.
 *   3. Ранжируем по «силе» сигнала и группе: contacts > requisites >
 *      about > privacy > terms. Юрлицо/ИНН компании чаще всего
 *      указаны именно на политике конфиденциальности или странице
 *      «О компании», поэтому возвращаем сразу несколько кандидатов.
 *   4. Если ни одна ссылка не найдена — пайплайн возьмёт контакты с
 *      главной (часто из футера).
 */

const cheerio = require('cheerio');

// Категория → список ключей в href / тексте. Порядок групп задаёт
// приоритет (выше — сильнее сигнал).
const CATEGORY_KEYWORDS = {
  contacts: [
    'контакт', 'контакты', 'связаться', 'связь',
    'contact', 'contacts', 'get-in-touch', 'reach-us',
  ],
  requisites: [
    'реквизит', 'реквизиты', 'requisites', 'rekvizity',
  ],
  about: [
    'о компании', 'о нас', 'о&nbsp;нас', 'про нас', 'про компани',
    'about', 'about-us', 'aboutus', 'company',
  ],
  policy: [
    'политика', 'конфиденциальн', 'персональных данных',
    'privacy', 'privacy-policy', 'privacypolicy', 'personal-data',
    'обработк', 'обработка персональных',
  ],
  terms: [
    'оферта', 'соглашение', 'пользовательское соглашение',
    'условия использования', 'правила', 'agreement',
    'terms', 'terms-of-use', 'terms-of-service', 'tos', 'eula',
  ],
};

// Точные «канонические» пути — самый сильный сигнал по группам.
const STRONG_PATH_BY_CATEGORY = {
  contacts: /(^|\/)(contacts?|kontakty|kontakti|contact-us|contact_us|svyaz|svyazatsya|company\/contacts)\/?$/i,
  requisites: /(^|\/)(requisites|rekvizity|company\/requisites)\/?$/i,
  about: /(^|\/)(about(?:-us)?|o-?nas|o-kompani[ie]|company\/?(?:about)?)\/?$/i,
  policy: /(^|\/)(privacy(?:-policy)?|privacypolicy|policy|personal-?data|politika(?:-konfidentsialnosti)?|konfidentsialnost|soglasie-na-obrabotku)\/?$/i,
  terms: /(^|\/)(terms(?:-of-(?:use|service))?|tos|agreement|oferta|publichnaya-oferta|user-agreement|polzovatelskoe-soglashenie|pravila)\/?$/i,
};

// Бонус группы — определяет приоритет между группами при равном score.
const CATEGORY_BONUS = {
  contacts: 0,
  requisites: -1,
  about: -2,
  policy: -3,
  terms: -4,
};

const MAX_RESULTS = 8;

function _abs(href, base) {
  try {
    return new URL(href, base).toString();
  } catch (_) {
    return null;
  }
}

function _scoreLinkForCategory(absUrl, text, baseHost, category) {
  if (!absUrl) return -1;
  let url;
  try { url = new URL(absUrl); } catch (_) { return -1; }
  if (url.hostname.replace(/^www\./, '') !== baseHost.replace(/^www\./, '')) return -1;
  let score = 0;
  const path = url.pathname.toLowerCase();
  const lowText = (text || '').toLowerCase();
  const strong = STRONG_PATH_BY_CATEGORY[category];
  if (strong && strong.test(path)) score += 10;
  for (const k of CATEGORY_KEYWORDS[category]) {
    if (path.includes(k)) score += 4;
    if (lowText.includes(k)) score += 2;
  }
  if (score > 0) score -= Math.min(3, Math.floor(path.length / 50));
  return score;
}

/**
 * Возвращает массив URL потенциальных страниц контактов / реквизитов /
 * политики, отсортированный по убыванию релевантности (с учётом
 * приоритета категории). Никогда не бросает.
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

  // absUrl → { score, category }
  const candidates = new Map();
  $('a[href]').each((_, el) => {
    const $el = $(el);
    const href = ($el.attr('href') || '').trim();
    if (!href) return;
    const abs = _abs(href, baseUrl);
    if (!abs) return;
    let absUrl;
    try { absUrl = new URL(abs); } catch (_) { return; }
    if (!/^https?:$/i.test(absUrl.protocol)) return;
    const text = ($el.text() || '').trim();
    let bestScore = 0;
    let bestCategory = null;
    for (const cat of Object.keys(CATEGORY_KEYWORDS)) {
      const sc = _scoreLinkForCategory(abs, text, baseHost, cat);
      // Бонус группы как тай-брейкер.
      const adj = sc > 0 ? sc + (CATEGORY_BONUS[cat] || 0) : sc;
      if (adj > bestScore) { bestScore = adj; bestCategory = cat; }
    }
    if (bestScore <= 0) return;
    const prev = candidates.get(abs);
    if (prev == null || bestScore > prev.score) {
      candidates.set(abs, { score: bestScore, category: bestCategory });
    }
  });

  return [...candidates.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, MAX_RESULTS)
    .map(([url, meta]) => ({ url, category: meta.category }));
}

// Все ключевые слова списком (для обратной совместимости в тестах/импортах).
const CONTACT_KEYWORDS = Object.values(CATEGORY_KEYWORDS).flat();

module.exports = {
  findContactLinks,
  CONTACT_KEYWORDS,
  CATEGORY_KEYWORDS,
};
