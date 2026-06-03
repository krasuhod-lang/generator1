'use strict';

/**
 * geoSchema — общий эмиттер JSON-LD блоков для всех генераторов
 * (infoArticle / linkArticle / categoryLead) в рамках стратегии SEO/GEO 2026.
 *
 * Цель: на 100% соответствовать требованиям аналитики — Article/BlogPosting,
 * Author, FAQPage, HowTo, BreadcrumbList, Organization. Контент с корректной
 * микроразметкой имеет в 2,5× более высокий шанс попасть в AI Overviews.
 *
 * Принципы:
 *   • без сторонних зависимостей (только stdlib);
 *   • строгая санитизация (никаких <, > в строках; только http/https URL);
 *   • пустые / некорректные блоки → null (НЕ эмитятся);
 *   • стабильный JSON-вывод (фиксированный порядок ключей).
 *
 * API:
 *   buildArticleJsonLd({...})       → object | null
 *   buildFaqPageJsonLd(faq)         → object | null
 *   buildHowToJsonLd({name, steps}) → object | null
 *   buildBreadcrumbListJsonLd(it)   → object | null
 *   buildOrganizationJsonLd({...})  → object | null
 *   buildItemListJsonLd({...})      → object | null
 *   assembleJsonLdScripts([...])    → string[] (готовые <script> теги)
 *   serializeJsonLdScript(block)    → string   (один <script> тег)
 *   sanitizeText(s)                 → string
 *   sanitizeUrl(s)                  → string | null
 */

const URL_RE = /^https?:\/\/[^\s<>"]+$/i;
const MAX_TEXT = 5000;
const MAX_HEADLINE = 200;
const MAX_DESCRIPTION = 600;

function _isStr(v) {
  return typeof v === 'string';
}

function _isNonEmptyStr(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Очищает строку: убирает HTML-теги (грубо), управляющие символы,
 * литеральные < > которые могут сломать <script>-обёртку, схлопывает пробелы.
 */
function sanitizeText(value, maxLen = MAX_TEXT) {
  if (!_isStr(value)) return '';
  let s = value;
  // Убираем HTML-теги (по простому, без полноценного парсера).
  s = s.replace(/<[^>]*>/g, ' ');
  // Декодируем самые частые HTML entities.
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&');
  // Удаляем управляющие символы (кроме \t \n).
  s = s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
  // Если в строке остались литералы < или >, удалим — они опасны внутри <script>.
  s = s.replace(/[<>]/g, '');
  // Схлопываем пробелы.
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s;
}

/** Проверяет/нормализует URL. Возвращает строку или null. */
function sanitizeUrl(value) {
  if (!_isNonEmptyStr(value)) return null;
  const v = value.trim();
  if (v.length > 2048) return null;
  if (!URL_RE.test(v)) return null;
  return v;
}

/** Нормализует ISO-дату; пропускает только валидные значения. */
function sanitizeDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (!_isNonEmptyStr(value)) return null;
  const v = value.trim();
  // Принимаем YYYY-MM-DD или ISO-8601 с временем/таймзоной.
  if (!/^\d{4}-\d{2}-\d{2}([Tt][\d:.+\-Zz]+)?$/.test(v)) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Article / BlogPosting / NewsArticle.
 */
function buildArticleJsonLd(args = {}) {
  const headline = sanitizeText(args.headline, MAX_HEADLINE);
  if (!headline) return null;

  const out = {
    '@context': 'https://schema.org',
    '@type': args.articleType === 'BlogPosting' || args.articleType === 'NewsArticle'
      ? args.articleType
      : 'Article',
    headline,
  };

  const description = sanitizeText(args.description, MAX_DESCRIPTION);
  if (description) out.description = description;

  const datePublished = sanitizeDate(args.datePublished);
  if (datePublished) out.datePublished = datePublished;

  const dateModified = sanitizeDate(args.dateModified) || datePublished;
  if (dateModified) out.dateModified = dateModified;

  const inLanguage = sanitizeText(args.inLanguage, 16);
  if (inLanguage) out.inLanguage = inLanguage;

  const mainEntityUrl = sanitizeUrl(args.mainEntityOfPage);
  if (mainEntityUrl) {
    out.mainEntityOfPage = { '@type': 'WebPage', '@id': mainEntityUrl };
  }

  // Author — обязательный сигнал E-E-A-T.
  if (args.author && _isNonEmptyStr(args.author.name)) {
    const author = {
      '@type': 'Person',
      name: sanitizeText(args.author.name, 200),
    };
    const authorUrl = sanitizeUrl(args.author.url);
    if (authorUrl) author.url = authorUrl;
    const authorJobTitle = sanitizeText(args.author.jobTitle, 200);
    if (authorJobTitle) author.jobTitle = authorJobTitle;
    out.author = author;
  }

  if (args.publisher && _isNonEmptyStr(args.publisher.name)) {
    const publisher = {
      '@type': 'Organization',
      name: sanitizeText(args.publisher.name, 200),
    };
    const pubUrl = sanitizeUrl(args.publisher.url);
    if (pubUrl) publisher.url = pubUrl;
    const logoUrl = sanitizeUrl(args.publisher.logo);
    if (logoUrl) {
      publisher.logo = { '@type': 'ImageObject', url: logoUrl };
    }
    out.publisher = publisher;
  }

  const imgs = []
    .concat(Array.isArray(args.image) ? args.image : [args.image])
    .map(sanitizeUrl)
    .filter(Boolean);
  if (imgs.length === 1) out.image = imgs[0];
  else if (imgs.length > 1) out.image = imgs;

  return out;
}

/**
 * FAQPage. faq — массив {question, answer}.
 */
function buildFaqPageJsonLd(faq) {
  if (!Array.isArray(faq) || faq.length === 0) return null;
  const items = [];
  for (const item of faq) {
    if (!item || typeof item !== 'object') continue;
    const q = sanitizeText(item.question, 500);
    const a = sanitizeText(item.answer, 2000);
    if (!q || !a) continue;
    items.push({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    });
  }
  if (items.length === 0) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items,
  };
}

/**
 * HowTo. steps — массив {name?, text} или строк.
 * Возвращает null если шагов < 2.
 */
function buildHowToJsonLd(args = {}) {
  const name = sanitizeText(args.name, MAX_HEADLINE);
  const description = sanitizeText(args.description, MAX_DESCRIPTION);
  const stepsArr = Array.isArray(args.steps) ? args.steps : [];
  const steps = [];
  for (let i = 0; i < stepsArr.length; i += 1) {
    const raw = stepsArr[i];
    if (!raw) continue;
    const stepText = sanitizeText(
      typeof raw === 'string' ? raw : raw.text || raw.description,
      2000,
    );
    if (!stepText) continue;
    const step = {
      '@type': 'HowToStep',
      position: i + 1,
      text: stepText,
    };
    if (typeof raw === 'object') {
      const stepName = sanitizeText(raw.name, 200);
      if (stepName) step.name = stepName;
    }
    steps.push(step);
  }
  if (steps.length < 2) return null;
  if (!name) return null;
  const out = {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name,
    step: steps,
  };
  if (description) out.description = description;
  return out;
}

/**
 * BreadcrumbList. items — массив {name, url}.
 */
function buildBreadcrumbListJsonLd(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (!it || typeof it !== 'object') continue;
    const name = sanitizeText(it.name, 200);
    if (!name) continue;
    const entry = { '@type': 'ListItem', position: i + 1, name };
    const itemUrl = sanitizeUrl(it.url);
    if (itemUrl) entry.item = itemUrl;
    out.push(entry);
  }
  if (out.length === 0) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: out,
  };
}

/**
 * Organization — entity-сигнал.
 */
function buildOrganizationJsonLd(args = {}) {
  const name = sanitizeText(args.name, 200);
  if (!name) return null;
  const out = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name,
  };
  const url = sanitizeUrl(args.url);
  if (url) out.url = url;
  const logo = sanitizeUrl(args.logo);
  if (logo) out.logo = logo;
  if (Array.isArray(args.sameAs)) {
    const sameAs = args.sameAs.map(sanitizeUrl).filter(Boolean);
    if (sameAs.length > 0) out.sameAs = sameAs;
  }
  return out;
}

/**
 * ItemList — для категорий (перечень фасетов/подкатегорий).
 */
function buildItemListJsonLd(args = {}) {
  const name = sanitizeText(args.name, 200);
  const itemsRaw = Array.isArray(args.items) ? args.items : [];
  const items = [];
  for (let i = 0; i < itemsRaw.length; i += 1) {
    const it = itemsRaw[i];
    if (!it) continue;
    const itemName = sanitizeText(typeof it === 'string' ? it : it.name, 200);
    if (!itemName) continue;
    const entry = { '@type': 'ListItem', position: i + 1, name: itemName };
    const itemUrl = sanitizeUrl(typeof it === 'string' ? null : it.url);
    if (itemUrl) entry.url = itemUrl;
    items.push(entry);
  }
  if (items.length === 0) return null;
  const out = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: items,
  };
  if (name) out.name = name;
  if (Array.isArray(args.about)) {
    const about = args.about.map((s) => sanitizeText(s, 200)).filter(Boolean);
    if (about.length) out.about = about;
  }
  if (_isNonEmptyStr(args.keywords)) {
    out.keywords = sanitizeText(args.keywords, 500);
  }
  return out;
}

/**
 * Безопасная сериализация одного блока внутрь <script type="application/ld+json">.
 */
function serializeJsonLdScript(block) {
  if (!block || typeof block !== 'object') return '';
  let json;
  try {
    json = JSON.stringify(block);
  } catch (_) {
    return '';
  }
  json = json
    .replace(/<\/script/gi, '<\\/script')
    .replace(/<!--/g, '<\\!--')
    .replace(/--!?>/g, '--\\>')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `<script type="application/ld+json">${json}</script>`;
}

/** Сборка нескольких блоков → массив <script>-строк (null/пустые отфильтрованы). */
function assembleJsonLdScripts(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks
    .filter((b) => b && typeof b === 'object')
    .map(serializeJsonLdScript)
    .filter(Boolean);
}

module.exports = {
  buildArticleJsonLd,
  buildFaqPageJsonLd,
  buildHowToJsonLd,
  buildBreadcrumbListJsonLd,
  buildOrganizationJsonLd,
  buildItemListJsonLd,
  assembleJsonLdScripts,
  serializeJsonLdScript,
  sanitizeText,
  sanitizeUrl,
  sanitizeDate,
};
