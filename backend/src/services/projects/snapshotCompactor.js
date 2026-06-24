'use strict';

/**
 * compactProjectSnapshot — превращает полный объект, возвращаемый
 * buildProjectContext, в компактный JSONB-слепок ≤ 32 КБ для записи
 * в project_context_snapshot задачи (ТЗ §1.2).
 *
 * Зачем:
 *  • Полный контекст может содержать тяжёлые массивы (raw GSC, конкуренты,
 *    history тем — сотни записей). Хранить это в каждой задаче =
 *    раздуть БД до терабайтов (см. ТЗ §4 «Decoupling слепков»).
 *  • В слепок попадает ТОЛЬКО то, что реально ушло в промт + метаданные
 *    для UI-плашек («контекст устарел», «проект удалён»).
 *
 * Алгоритм:
 *  1. Сериализуем урезанную форму (см. _compact).
 *  2. Если JSON > MAX_SNAPSHOT_BYTES — рекурсивно режем массивы по
 *     приоритетам: history → 100, competitors → 5, cannibalization → 15,
 *     facts → 8, brand_facts строкой ≤ 200 симв.
 *  3. Если всё ещё > лимита — оставляем только базовые поля проекта и
 *     ставим флаг `_truncated_aggressively: true`.
 *
 * Возвращает: { snapshot: <object>, truncated: boolean, sizeBytes: number }.
 */

const MAX_SNAPSHOT_BYTES = 32 * 1024;          // 32 КБ — целевой лимит.
const HARD_DB_LIMIT      = 60 * 1024;          // CHECK в БД — 64 КБ; держим запас.

function compactProjectSnapshot(ctx) {
  if (!ctx || typeof ctx !== 'object') {
    return { snapshot: null, truncated: false, sizeBytes: 0 };
  }
  let snap = _compact(ctx);
  let bytes = _byteLen(snap);
  let truncated = false;

  // Постепенное сжатие при переполнении.
  const steps = [
    (s) => { if (s.history?.published_topics) s.history.published_topics = s.history.published_topics.slice(0, 100); },
    (s) => { if (s.signals?.cannibalization) s.signals.cannibalization = s.signals.cannibalization.slice(0, 15); },
    (s) => { if (s.market?.competitors) s.market.competitors = s.market.competitors.slice(0, 3); },
    (s) => { if (s.brand?.facts) s.brand.facts = s.brand.facts.slice(0, 8).map((f) => String(f).slice(0, 200)); },
    (s) => { if (s.history?.published_topics) s.history.published_topics = s.history.published_topics.slice(0, 50); },
    (s) => { if (s.signals?.striking_distance) s.signals.striking_distance = []; },
    (s) => { if (s.history?.recent_meta_titles) s.history.recent_meta_titles = []; },
    (s) => { if (s.signals?.cannibalization) s.signals.cannibalization = s.signals.cannibalization.slice(0, 5); },
    (s) => { if (s.history?.published_topics) s.history.published_topics = s.history.published_topics.slice(0, 20); },
  ];
  for (const step of steps) {
    if (bytes <= MAX_SNAPSHOT_BYTES) break;
    step(snap);
    truncated = true;
    bytes = _byteLen(snap);
  }

  // Жёсткий fallback — оставляем только проект + бренд-имя + version.
  if (bytes > HARD_DB_LIMIT) {
    snap = {
      project: snap.project || null,
      brand: snap.brand ? { name: snap.brand.name || null } : null,
      context_version: snap.context_version || null,
      captured_at: snap.captured_at,
      _truncated_aggressively: true,
    };
    truncated = true;
    bytes = _byteLen(snap);
  } else if (truncated) {
    snap._truncated = true;
  }

  return { snapshot: snap, truncated, sizeBytes: bytes };
}

function _compact(ctx) {
  const project = ctx.project || {};
  const brand = ctx.brand || {};
  const market = ctx.market || {};
  const signals = ctx.signals || {};
  const history = ctx.history || {};

  // Только то, что реально пойдёт в промт + аудит.
  return {
    project: {
      id: project.id || null,
      name: project.name || null,
      site_url: project.site_url || null,
      region: project.region || null,
      niche: project.niche || null,
      audience: project.audience || null,
      default_year: project.default_year || null,
      default_currency: project.default_currency || null,
      pricing_notes: _str(project.pricing_notes, 500),
      content_criteria: project.content_criteria || null,
      updated_at: project.updated_at || null,
    },
    brand: {
      name: brand.name || null,
      aliases: _arr(brand.aliases, 8).map((a) => _str(a, 80)),
      tokens: _arr(brand.tokens, 16).map((t) => _str(t, 60)),
      facts: _arr(brand.facts, 12).map((f) => _str(f, 300)),
      tone: _str(brand.tone, 120),
    },
    market: {
      competitors: _arr(market.competitors, 5).map((c) => (typeof c === 'string' ? _str(c, 120) : c)),
      commercial_share: market.commercial_share ?? null,
      top_intent: market.top_intent || null,
      brand_share: market.brand_share ?? null,
    },
    signals: {
      cannibalization: _arr(signals.cannibalization, 30).map((c) => ({
        query: _str(c.query, 200),
        verdict: c.verdict || null,
        pages_count: Array.isArray(c.pages) ? c.pages.length : (c.pages_count || null),
      })),
      striking_distance: _arr(signals.striking_distance, 30).map((s) => ({
        query: _str(s.query, 200),
        position: s.position ?? null,
      })),
      gsc_summary: signals.gsc || null,
      ydx_summary: signals.ydx || null,
    },
    history: {
      published_topics: _arr(history.published_topics, 150).map((t) => ({
        title: _str(t.topic_title_canon || t.title || t, 200),
        intent_facet: t.intent_facet || null,
      })),
      recent_meta_titles: _arr(history.recent_meta_titles, 30).map((m) => _str(m, 200)),
    },
    last_analysis_at: ctx.last_analysis_at || null,
    snapshot_id: ctx.snapshot_id || null,
    context_version: ctx.context_version || null,
    captured_at: new Date().toISOString(),
  };
}

function _arr(v, n) { return Array.isArray(v) ? v.slice(0, n) : []; }
function _str(v, n) {
  if (v == null) return null;
  const s = String(v);
  return s.length > n ? s.slice(0, n) : s;
}
function _byteLen(obj) {
  try { return Buffer.byteLength(JSON.stringify(obj), 'utf-8'); }
  catch (_) { return 0; }
}

module.exports = {
  compactProjectSnapshot,
  MAX_SNAPSHOT_BYTES,
  HARD_DB_LIMIT,
};
