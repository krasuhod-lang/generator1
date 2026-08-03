'use strict';

/**
 * contentGapPlanner/existingContent — индекс «что уже есть на сайте».
 *
 * ЗАЧЕМ: темы для блога нельзя придумывать в вакууме. Если по теме уже есть
 * статья/страница, новая публикация создаёт дубль тематики (каннибализация
 * запросов + расход ресурса впустую). Поэтому перед генерацией тем строим
 * индекс существующего контента и:
 *   • отсеиваем «дыры», которые на самом деле уже закрыты страницей сайта;
 *   • отдаём такие кандидаты отдельным списком «обновить существующее».
 *
 * Источники (все уже есть в снапшоте анализа, сети не требуют):
 *   • queryPage — матрица запрос × посадочная страница из GSC (главный сигнал:
 *     если запрос уже приземляется на инфо-страницу, тема закрыта);
 *   • topPages — топ страниц сайта (URL → слаг как текстовый сигнал);
 *   • pageMetaAudit.pages — распарсенные title/H1 страниц;
 *   • siteCrawlPages — краул сайта (url/title/h1), если передан.
 *
 * Сравнение детерминированное: canonTitle + stemWord (общие хелперы из
 * articleTopics/brandKey), Jaccard по множеству стеммов значимых слов.
 */

const { canonTitle, stemWord } = require('../../articleTopics/brandKey');

// Стоп-слова: служебные части речи и вопросительные слова не несут тематики.
const STOP_WORDS = new Set([
  'и', 'в', 'во', 'на', 'с', 'со', 'по', 'за', 'из', 'от', 'до', 'для', 'к', 'у',
  'о', 'об', 'при', 'над', 'под', 'без', 'же', 'ли', 'бы', 'не', 'ни', 'а', 'но',
  'или', 'что', 'как', 'где', 'когда', 'почему', 'зачем', 'чем', 'это', 'этот',
  'the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'and', 'or', 'how', 'what',
  'why', 'is', 'are', 'be', 'with',
]);

/** Маркеры информационных (блоговых) разделов в URL. */
const INFO_URL_RE = /\/(blog|articles?|stat[ья]i?|stati|news|novosti|poleznoe|useful|guide|guides|help|faq|wiki|journal|baza-znanij|knowledge)\b/i;

/** Маркеры коммерческих разделов — такие страницы не закрывают инфо-тему. */
const COMMERCE_URL_RE = /\/(catalog|category|product|tovar|shop|cart|checkout|uslugi|services|price|prices|cena|ceny|kupit|zakaz)\b/i;

function _norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/ё/g, 'е').trim(); }

/** Множество значимых стеммов строки (для Jaccard). */
function topicTokens(raw) {
  const canon = canonTitle(raw);
  if (!canon) return new Set();
  const out = new Set();
  canon.split(/\s+/).forEach((w) => {
    if (!w || w.length < 3) return;
    if (STOP_WORDS.has(w)) return;
    const st = stemWord(w);
    if (st && st.length >= 3) out.add(st);
  });
  return out;
}

/** Jaccard-схожесть двух множеств стеммов (0..1). */
function jaccard(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  a.forEach((t) => { if (b.has(t)) inter += 1; });
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Покрытие темы страницей: доля значимых стеммов темы, встречающихся в
 * заголовке/слаге/запросах страницы. Именно containment, а не Jaccard: у
 * страницы обычно больше слов («Как выбрать насос: подробный гид»), и Jaccard
 * занижал бы очевидный дубль. Возвращает {score, inter}.
 */
function containment(qTokens, pageTokens) {
  if (!qTokens || !pageTokens || qTokens.size === 0 || pageTokens.size === 0) return { score: 0, inter: 0 };
  let inter = 0;
  qTokens.forEach((t) => { if (pageTokens.has(t)) inter += 1; });
  return { score: inter / qTokens.size, inter };
}

/** Текстовый сигнал из URL: слаг последнего сегмента как набор слов. */
function _slugText(url) {
  try {
    const u = new URL(String(url));
    const parts = u.pathname.split('/').filter(Boolean);
    if (!parts.length) return '';
    return decodeURIComponent(parts[parts.length - 1])
      .replace(/\.(html?|php|aspx?)$/i, '')
      .replace(/[-_+]+/g, ' ')
      .trim();
  } catch (_) {
    return '';
  }
}

function _isInfoUrl(url) {
  const u = String(url || '');
  if (!u) return false;
  if (COMMERCE_URL_RE.test(u)) return false;
  return INFO_URL_RE.test(u);
}

/**
 * Строит индекс существующего контента сайта.
 *
 * @param {object} args { queryPage:[], topPages:[], pageMetaAudit, siteCrawlPages:[] }
 * @returns {{pages:Array, byQuery:Map, size:number, findCoverage:Function}}
 */
function buildExistingContentIndex({
  queryPage = [], topPages = [], pageMetaAudit = null, siteCrawlPages = [],
} = {}) {
  /** url → { url, title, h1, tokens, is_info, queries:Set } */
  const pages = new Map();

  const touch = (url) => {
    const key = String(url || '').trim();
    if (!key) return null;
    if (!pages.has(key)) {
      pages.set(key, {
        url: key,
        title: '',
        h1: '',
        slug: _slugText(key),
        is_info: _isInfoUrl(key),
        queries: new Set(),
        tokens: new Set(),
      });
    }
    return pages.get(key);
  };

  (topPages || []).forEach((p) => { touch(p && (p.key || p.page || p.url)); });

  // Матрица «запрос × страница»: главный сигнал реального покрытия темы.
  const byQuery = new Map();
  (queryPage || []).forEach((r) => {
    if (!r) return;
    const q = r.query || r.key;
    const url = r.page || r.url;
    if (!q || !url) return;
    const entry = touch(url);
    if (!entry) return;
    entry.queries.add(String(q));
    const nq = _norm(q);
    const prev = byQuery.get(nq);
    const imp = Number(r.impressions) || 0;
    if (!prev || imp > prev.impressions) byQuery.set(nq, { url, impressions: imp, position: Number(r.position) || null });
  });

  // Распарсенные мета-теги страниц (title/H1).
  const metaPages = (pageMetaAudit && Array.isArray(pageMetaAudit.pages)) ? pageMetaAudit.pages : [];
  metaPages.forEach((p) => {
    const entry = touch(p && p.url);
    if (!entry) return;
    const before = p.before || {};
    if (before.title) entry.title = String(before.title);
    if (before.h1) entry.h1 = String(before.h1);
  });

  // Краул сайта (если доступен) — самый полный источник заголовков.
  (siteCrawlPages || []).forEach((p) => {
    const entry = touch(p && (p.url || p.page));
    if (!entry) return;
    if (p.title) entry.title = String(p.title);
    if (p.h1) entry.h1 = String(p.h1);
  });

  // Финальные токены страницы: title + H1 + слаг + собственные запросы GSC.
  pages.forEach((entry) => {
    const text = [entry.title, entry.h1, entry.slug].filter(Boolean).join(' ');
    entry.tokens = topicTokens(text);
    entry.queries.forEach((q) => { topicTokens(q).forEach((t) => entry.tokens.add(t)); });
  });

  const list = Array.from(pages.values());

  /**
   * Ищет страницу, которая уже закрывает тему запроса.
   * @returns {null|{url, match:'landing'|'similar', score:number, title:string}}
   */
  function findCoverage(query, opts = {}) {
    const minSimilarity = Number(opts.minSimilarity) || 0.6;
    const q = String(query || '').trim();
    if (!q) return null;

    // 1) Запрос уже приземляется на информационную страницу — тема закрыта.
    const landing = byQuery.get(_norm(q));
    if (landing && _isInfoUrl(landing.url)) {
      const page = pages.get(landing.url);
      return {
        url: landing.url,
        match: 'landing',
        score: 1,
        title: (page && (page.title || page.h1)) || '',
        position: landing.position,
      };
    }

    // 2) Схожесть темы с заголовком/слагом существующей информационной страницы.
    // Требуем минимум 2 общих значимых стемма — иначе однословные запросы
    // ложно «покрывались» бы любой страницей с этим словом.
    const qTokens = topicTokens(q);
    if (qTokens.size === 0) return null;
    let best = null;
    list.forEach((page) => {
      if (!page.is_info) return;
      const { score, inter } = containment(qTokens, page.tokens);
      if (inter < 2) return;
      if (score >= minSimilarity && (!best || score > best.score)) {
        best = { url: page.url, match: 'similar', score, title: page.title || page.h1 || '' };
      }
    });
    return best;
  }

  return {
    pages: list,
    byQuery,
    size: list.length,
    info_pages_count: list.filter((p) => p.is_info).length,
    findCoverage,
  };
}

module.exports = {
  buildExistingContentIndex,
  topicTokens,
  jaccard,
  containment,
  _isInfoUrl,
  _slugText,
};
