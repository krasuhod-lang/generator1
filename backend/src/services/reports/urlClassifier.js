'use strict';

/**
 * reports/urlClassifier.js — детерминированная классификация URL на
 * информационные и коммерческие страницы по сегментам пути.
 *
 * Мотивация (ТЗ-правка): классификация запроса по интенту (commercial vs
 * informational) работает плохо — один и тот же запрос может быть и тем, и
 * другим. Зато структура URL почти всегда честно говорит, что за страница:
 * /blog/, /guide/, /wiki/ — это контент (информация), а /catalog/, /category/,
 * /cart/, /services/ — это коммерция. Поэтому интент страницы определяем по
 * URL, а всё, что не попало в информационные маркеры, считаем коммерцией
 * («все остальное это коммерция»).
 *
 * Чистый модуль: без БД/сети. Используется в dataAggregator для пометки
 * top-страниц отчёта.
 */

// --- Информационные маркеры (контент, база знаний, новости, медиа, ниши) ---
// Каждый элемент сопоставляется с сегментом пути целиком (между слэшами),
// поэтому /articles/ матчится, а /particles/ — нет.
const INFORMATIONAL_SEGMENTS = new Set([
  // 1. Форматы контента и жанры статей
  'blog', 'blogs',
  'article', 'articles',
  'guide', 'guides',
  'tutorial', 'tutorials',
  'journal',
  'story', 'stories',
  'insight', 'insights',
  'case', 'cases', 'casestudies', 'case-studies', 'case-study',
  'review', 'reviews',
  'interview', 'interviews',
  'digest', 'digests',
  'opinion', 'opinions',
  // 2. База знаний, обучение и поддержка
  'wiki',
  'glossary',
  'academy', 'school',
  'learn', 'learning',
  'hub',
  'faq', 'help',
  'resources', 'resource-center', 'resource',
  'docs', 'documentation',
  'manual', 'manuals',
  'knowledge', 'knowledge-base', 'kb',
  // 3. Новости и актуальная информация
  'news',
  'press', 'press-room', 'press-center', 'pressroom',
  'updates',
  'events', 'event',
  'trends',
  'releases',
  // 4. Мультимедийные и нестандартные форматы
  'media',
  'video', 'videos', 'vlog',
  'podcast', 'podcasts',
  'webinar', 'webinars',
  'whitepapers', 'whitepaper',
  'research',
  // 5. Отраслевые/тематические разделы (часто используются вместо «блог»)
  'tech',
  'design',
  'marketing',
  'business',
  'lifestyle',
  'health',
]);

// --- Явные коммерческие маркеры ---
// Нужны, чтобы коммерческие разделы не утекали в «прочее» и чтобы можно было
// отличить уверенную коммерцию (catalog/cart/...) от страниц без маркеров,
// которые мы тоже считаем коммерцией, но с меньшей уверенностью.
const COMMERCIAL_SEGMENTS = new Set([
  // 1. Каталог и навигация
  'catalog', 'catalogue',
  'category', 'categories', 'c',
  'shop', 'store',
  'products', 'product', 'p',
  'services', 'service',
  // 2. Спецпредложения и статусы товаров
  'sale', 'sales',
  'discount', 'discounts',
  'outlet',
  'promo', 'promotions', 'promotion',
  'new-arrivals',
  'bestsellers', 'hits',
  'brands', 'brand',
  // 3. Функциональные и служебные страницы e-commerce
  'cart', 'basket',
  'checkout', 'order', 'orders',
  'delivery', 'shipping',
  'payment',
  'return', 'returns', 'refund',
  'guarantee', 'warranty',
  'compare',
  'wishlist', 'favorites',
  // 4. B2B и оптовые продажи
  'b2b',
  'wholesale',
  'dealers', 'partners',
  'franchise',
]);

const INFORMATIONAL = 'informational';
const COMMERCIAL = 'commercial';

/**
 * Извлечь сегменты пути URL в нижнем регистре.
 * Принимает как абсолютный URL, так и относительный путь.
 */
function _pathSegments(rawUrl) {
  if (!rawUrl) return [];
  let pathname = String(rawUrl);
  try {
    // Абсолютный URL → берём pathname. Относительный — оставляем как есть.
    if (/^https?:\/\//i.test(pathname)) {
      pathname = new URL(pathname).pathname;
    } else {
      // отрезаем возможные query/hash у относительного пути
      pathname = pathname.split(/[?#]/)[0];
    }
  } catch (_) {
    pathname = pathname.split(/[?#]/)[0];
  }
  return pathname
    .split('/')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Классифицировать URL.
 * @param {string} url
 * @returns {{intent: 'informational'|'commercial', confident: boolean, marker: string|null}}
 *   intent     — итоговый интент страницы.
 *   confident  — true, если найден явный маркер (инфо- или коммерческий
 *                сегмент). false — когда маркеров нет и страница отнесена к
 *                коммерции по умолчанию.
 *   marker     — сегмент-маркер, по которому принято решение (для отладки/UI).
 */
function classifyUrl(url) {
  const segments = _pathSegments(url);
  for (const seg of segments) {
    if (INFORMATIONAL_SEGMENTS.has(seg)) {
      return { intent: INFORMATIONAL, confident: true, marker: seg };
    }
    if (COMMERCIAL_SEGMENTS.has(seg)) {
      return { intent: COMMERCIAL, confident: true, marker: seg };
    }
  }
  // Нет маркеров — по умолчанию коммерция («все остальное это коммерция»).
  return { intent: COMMERCIAL, confident: false, marker: null };
}

/** Удобный шорткат: true, если URL — информационная страница. */
function isInformationalUrl(url) {
  return classifyUrl(url).intent === INFORMATIONAL;
}

module.exports = {
  classifyUrl,
  isInformationalUrl,
  INFORMATIONAL,
  COMMERCIAL,
  INFORMATIONAL_SEGMENTS,
  COMMERCIAL_SEGMENTS,
};
