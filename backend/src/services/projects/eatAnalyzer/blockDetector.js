'use strict';

/**
 * eatAnalyzer/blockDetector — детектирует из чего состоит страница (п.5 ТЗ:
 * «определяем из каких блоков состоят страницы нашего сайта»).
 *
 * Работает по уже скачанному представлению страницы (markdown + hiddenLayers
 * из parser/scraper, переиспользуем — без повторного fetch). Детектирует блоки
 * E-E-A-T-значимости: author, reviews, contacts, certificates, price, faq,
 * breadcrumbs, guarantees, legal, social, media. Детерминированно.
 */

// Сигнальные подстроки (рус/eng) для текстовых блоков. Регистронезависимо.
const BLOCK_SIGNALS = {
  author: ['автор статьи', 'об авторе', 'эксперт:', 'автор:', 'проверено экспертом',
    'медицинский редактор', 'author', 'reviewed by', 'written by'],
  reviews: ['отзыв', 'отзывы', 'оставить отзыв', 'оценка клиентов', 'review', 'rating',
    'рейтинг', 'звёзд', 'звезд'],
  certificates: ['сертификат', 'лицензия', 'аккредитац', 'награда', 'диплом', 'сертификаты',
    'certificate', 'license'],
  contacts: ['контакты', 'наш адрес', 'режим работы', 'график работы', 'позвоните',
    'напишите нам', 'email', 'e-mail', 'phone'],
  guarantees: ['гарантия', 'гарантии', 'возврат', 'обмен товара', 'warranty', 'money back'],
  legal: ['ооо', 'ип ', 'инн', 'огрн', 'политика конфиденциальности', 'оферта',
    'юридический адрес', 'privacy policy', 'terms'],
  faq: ['частые вопросы', 'вопрос-ответ', 'вопросы и ответы', 'faq', 'часто задаваемые'],
  price: ['цена', 'стоимость', 'руб', '₽', 'прайс', 'тариф', 'price', 'от ', 'купить'],
  delivery: ['доставка', 'оплата', 'самовывоз', 'delivery', 'payment', 'оплатить'],
  cases: ['кейс', 'наши работы', 'портфолио', 'примеры работ', 'до и после', 'case study',
    'выполненные проекты'],
  social: ['vk.com', 't.me', 'telegram', 'instagram', 'youtube.com', 'wa.me', 'whatsapp'],
};

function _norm(s) { return String(s || '').toLowerCase().replace(/ё/g, 'е'); }

/**
 * Собирает все @type из JSON-LD (рекурсивно по @graph / массивам).
 * @returns {string[]}
 */
function collectJsonLdTypes(jsonld) {
  const types = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node['@type']) {
      const t = node['@type'];
      if (Array.isArray(t)) t.forEach((x) => types.push(String(x)));
      else types.push(String(t));
    }
    if (node['@graph']) walk(node['@graph']);
    Object.keys(node).forEach((k) => {
      if (k !== '@type' && k !== '@graph' && typeof node[k] === 'object') walk(node[k]);
    });
  };
  walk(jsonld);
  return Array.from(new Set(types));
}

/**
 * Детектирует блоки страницы.
 *
 * @param {object} page { markdown, title, hiddenLayers }
 * @returns {{blocks:object, schema_types:string[], has_media:boolean,
 *            has_author_schema:boolean, has_review_schema:boolean,
 *            has_breadcrumb_schema:boolean, text_len:number}}
 */
function detectBlocks(page = {}) {
  const text = _norm(`${page.title || ''}\n${page.markdown || ''}`);
  const hl = page.hiddenLayers || {};
  const sd = hl.structured_data || {};
  const schemaTypes = [];
  (sd.jsonld || []).forEach((j) => collectJsonLdTypes(j).forEach((t) => schemaTypes.push(t)));
  (sd.microdata || []).forEach((m) => {
    if (m && m.value && /schema\.org\//i.test(String(m.value))) {
      schemaTypes.push(String(m.value).split('/').pop());
    }
  });
  const uniqTypes = Array.from(new Set(schemaTypes));
  const lc = uniqTypes.map((t) => t.toLowerCase());

  const blocks = {};
  Object.entries(BLOCK_SIGNALS).forEach(([name, signals]) => {
    blocks[name] = signals.some((sig) => text.includes(sig));
  });

  // Усиливаем сигналы микроразметкой.
  const hasReviewSchema = lc.some((t) => /review|aggregaterating|rating/.test(t));
  const hasAuthorSchema = lc.some((t) => /person|author/.test(t))
    || (sd.jsonld || []).some((j) => JSON.stringify(j).toLowerCase().includes('"author"'));
  const hasBreadcrumb = lc.includes('breadcrumblist');
  if (hasReviewSchema) blocks.reviews = true;
  blocks.breadcrumbs = hasBreadcrumb;

  // Медиа (фото/видео) — Experience-сигнал.
  const og = hl.meta_signals && hl.meta_signals.og;
  const hasMedia = Boolean(og && og.image)
    || /!\[[^\]]*\]\([^)]+\)/.test(String(page.markdown || ''))
    || lc.some((t) => /imageobject|videoobject/.test(t));

  return {
    blocks,
    schema_types: uniqTypes,
    has_media: hasMedia,
    has_author_schema: hasAuthorSchema,
    has_review_schema: hasReviewSchema,
    has_breadcrumb_schema: hasBreadcrumb,
    text_len: text.length,
  };
}

module.exports = { detectBlocks, collectJsonLdTypes, BLOCK_SIGNALS };
