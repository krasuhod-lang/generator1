'use strict';

/**
 * projectContextBlock — рендерит партиал _projectContext.partial.txt в
 * готовый текстовый блок для инжекта в любой модульный промт (ТЗ §1.4).
 *
 * Ключевые свойства:
 *  • Один формат для всех модулей (info-article, link-article, meta-tags,
 *    article-topics, …) — чтобы LLM училась одной и той же структуре.
 *  • Жёсткий приоритет ЛОКАЛЬНЫХ полей задачи над контекстом проекта
 *    (текст правил впечатан в партиал — модель видит инструкцию явно).
 *  • Сжатие published_topics и cannibalization под бюджет символов,
 *    чтобы массивы на 500+ позиций не раздували промт (ТЗ §1.4.A).
 *  • Поддержка year_policy: explicit|implicit|omit в content_criteria —
 *    при omit строка про год заменяется на «Год: не упоминать в тексте».
 *
 * Использование:
 *   const block = buildProjectContextBlock(ctx, { maxBlockChars: 6000 });
 *   userPrompt = projectBlock + '\n\n' + moduleSpecificPrompt;
 *
 * Если ctx == null/falsy — вернёт пустую строку (без блока).
 */

const fs = require('fs');
const path = require('path');

const PARTIAL_PATH = path.join(__dirname, '..', '..', 'prompts', '_projectContext.partial.txt');
let _partialCache = null;
function _loadPartial() {
  if (_partialCache == null) {
    _partialCache = fs.readFileSync(PARTIAL_PATH, 'utf-8');
  }
  return _partialCache;
}

const DEFAULT_MAX_CHARS = 6000;
// Внутренние под-бюджеты (под опубликованные темы и каннибализацию).
const PUBLISHED_BUDGET_CHARS = 2500;
const CANN_BUDGET_CHARS      = 600;

function buildProjectContextBlock(ctx, opts = {}) {
  if (!ctx || !ctx.project) return '';
  const maxChars = Number(opts.maxBlockChars) || DEFAULT_MAX_CHARS;

  const project = ctx.project || {};
  const brand   = ctx.brand   || {};
  const market  = ctx.market  || {};
  const signals = ctx.signals || {};
  const history = ctx.history || {};
  const criteria = project.content_criteria || {};

  // Год: учитываем year_policy.
  const yearPolicy = (criteria.year_policy || 'explicit').toLowerCase();
  let yearLine;
  if (yearPolicy === 'omit') {
    yearLine = 'Актуальный год: не упоминать в тексте (year_policy=omit)';
  } else if (yearPolicy === 'implicit') {
    yearLine = `Актуальный год: ${project.default_year || '(не указан)'} — допустимо упоминать только при необходимости`;
  } else {
    yearLine = `Актуальный год: ${project.default_year || '(не указан)'}`;
  }

  // Алиасы — суффикс в скобках, если есть.
  const aliases = Array.isArray(brand.aliases) ? brand.aliases.filter(Boolean).slice(0, 6) : [];
  const aliasesSuffix = aliases.length ? ` (также: ${aliases.join(', ')})` : '';

  // Факты — список «- factX» по строкам, ≤ 8 шт.
  const facts = Array.isArray(brand.facts) ? brand.facts.filter(Boolean).slice(0, 8) : [];
  const factsText = facts.length
    ? '\n  - ' + facts.map((f) => String(f).slice(0, 300)).join('\n  - ')
    : '(не указано)';

  // Stop-words / дисклеймеры.
  const stopWords = Array.isArray(criteria.stop_words) ? criteria.stop_words.slice(0, 30) : [];
  const disclaimers = Array.isArray(criteria.required_disclaimers) ? criteria.required_disclaimers.slice(0, 10) : [];

  // Конкуренты.
  const competitors = Array.isArray(market.competitors) ? market.competitors.filter(Boolean).slice(0, 8) : [];

  // Intent summary.
  const gsc = signals.gsc || {};
  const ydx = signals.ydx || {};
  const intentSummaryParts = [];
  if (gsc.top_intent) intentSummaryParts.push(`GSC top_intent=${gsc.top_intent} (комм. доля ${_pct(gsc.commercial_share)}, бренд ${_pct(gsc.brand_share)})`);
  if (ydx.top_intent) intentSummaryParts.push(`Яндекс top_intent=${ydx.top_intent} (комм. доля ${_pct(ydx.commercial_share)})`);
  const intentSummary = intentSummaryParts.length ? intentSummaryParts.join('; ') : '(нет данных GSC/Яндекс)';

  // Published topics — сжатие под бюджет.
  const publishedRendered = _renderPublishedTopics(history.published_topics, PUBLISHED_BUDGET_CHARS);
  const cannRendered      = _renderCannibalization(signals.cannibalization, CANN_BUDGET_CHARS);

  const filled = _interpolate(_loadPartial(), {
    BRAND_NAME:          brand.name || project.name || '(не указан)',
    BRAND_ALIASES_SUFFIX: aliasesSuffix,
    SITE_URL:            project.site_url || '(не указан)',
    REGION:              project.region || '(не указан)',
    NICHE:               project.niche || '(не указано)',
    AUDIENCE:            project.audience || '(не указано)',
    YEAR_LINE:           yearLine,
    CURRENCY:            project.default_currency || '(не указано)',
    PRICING_NOTES:       project.pricing_notes ? String(project.pricing_notes).slice(0, 400) : '(не указано)',
    BRAND_FACTS:         factsText,
    BRAND_TONE:          brand.tone || '(нейтральный, экспертный)',
    CONTENT_STOPWORDS:   stopWords.length ? stopWords.join(', ') : '(нет)',
    CONTENT_DISCLAIMERS: disclaimers.length ? disclaimers.join(' | ') : '(нет)',
    COMPETITORS:         competitors.length ? competitors.join(', ') : '(не указаны)',
    INTENT_SUMMARY:      intentSummary,
    PUBLISHED_TOPICS_COMPRESSED: publishedRendered,
    CANNIBALIZATION_LIST:        cannRendered,
  });

  // Финальная защита по общему бюджету.
  if (filled.length <= maxChars) return filled;
  // Если переполнено целиком — обрезаем хвост, добавляем маркер.
  return filled.slice(0, maxChars - 50) + '\n// (контекст обрезан по бюджету)\n';
}

/**
 * Сжатие published_topics:
 *  1. Топ-N по сортировке: recency * 0.5 + intent_diversity 0.5.
 *     Если у темы нет created_at — она идёт в конец.
 *  2. Каждая тема выводится одной строкой «- canon (intent_facet?)».
 *  3. Хвост, не влезший в бюджет, сворачивается в строку
 *     «// + ещё N тем» с разбивкой по самым частым intent_facet.
 */
function _renderPublishedTopics(topics, budget) {
  if (!Array.isArray(topics) || !topics.length) return '(нет опубликованных тем)';
  // Сортировка: свежие сверху; intent_diversity достигается тем, что
  // мы выводим темы по очереди разных intent_facet.
  const enriched = topics.map((t, idx) => ({
    title: String(t.topic_title_canon || t.title || t || '').slice(0, 180),
    intent: t.intent_facet || null,
    ts: t.created_at ? new Date(t.created_at).getTime() : (Date.now() - idx * 1000),
  })).filter((t) => t.title);

  enriched.sort((a, b) => (b.ts || 0) - (a.ts || 0));

  // Round-robin по intent_facet для разнообразия.
  const buckets = new Map();
  for (const t of enriched) {
    const k = t.intent || '_';
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(t);
  }
  const ordered = [];
  let more = true;
  while (more) {
    more = false;
    for (const arr of buckets.values()) {
      if (arr.length) { ordered.push(arr.shift()); more = true; }
    }
  }

  const lines = [];
  let used = 0;
  let dropped = 0;
  for (const t of ordered) {
    const line = `- ${t.title}${t.intent ? ` (${t.intent})` : ''}`;
    if (used + line.length + 1 > budget) { dropped += 1; continue; }
    lines.push(line);
    used += line.length + 1;
  }
  if (dropped > 0) {
    // Подсчёт fold-кластеров по intent_facet — справочно.
    const intentCounts = new Map();
    for (const t of enriched.slice(lines.length)) {
      const k = t.intent || '(прочее)';
      intentCounts.set(k, (intentCounts.get(k) || 0) + 1);
    }
    const fold = [...intentCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, n]) => `${k}: ${n}`)
      .join('; ');
    lines.push(`// + ещё ${dropped} тем опущено для краткости (кластеры: ${fold || 'разное'})`);
  }
  return '\n  ' + lines.join('\n  ');
}

function _renderCannibalization(cann, budget) {
  if (!Array.isArray(cann) || !cann.length) return '(нет каннибализационных сигналов)';
  const lines = [];
  let used = 0;
  let dropped = 0;
  for (const c of cann) {
    const q = String(c.query || '').slice(0, 120);
    if (!q) continue;
    const pagesCount = Array.isArray(c.pages) ? c.pages.length : (c.pages_count || 0);
    const line = `- «${q}» — ${pagesCount} пересекающихся URL${c.verdict ? `, verdict=${c.verdict}` : ''}`;
    if (used + line.length + 1 > budget) { dropped += 1; continue; }
    lines.push(line);
    used += line.length + 1;
  }
  if (dropped > 0) lines.push(`// + ещё ${dropped} каннибализационных кластеров опущено`);
  return '\n  ' + lines.join('\n  ');
}

function _interpolate(template, values) {
  let out = template;
  for (const [k, v] of Object.entries(values)) {
    const safe = (v == null ? '' : String(v));
    out = out.replaceAll(`{{${k}}}`, safe);
  }
  return out;
}

function _pct(v) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  const n = Number(v);
  return n > 1 ? `${n.toFixed(0)}%` : `${(n * 100).toFixed(0)}%`;
}

module.exports = {
  buildProjectContextBlock,
  DEFAULT_MAX_CHARS,
};
