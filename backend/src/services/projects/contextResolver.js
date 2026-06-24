'use strict';

const crypto = require('crypto');
const db = require('../../config/db');

/**
 * contextResolver — единая точка сборки «контекста проекта» для авто-
 * предзаполнения форм создания задач (ТЗ §8).
 *
 * Цель: пользователь выбирает проект в `ProjectPicker` → форма создания
 * (info-article, link-article, meta-tags, …) подтягивает бренд, регион,
 * сферу и факты из самого свежего анализа проекта. Backend-сторона
 * контроллеров тоже зовёт этот резолвер, если поля не пришли с фронта —
 * чтобы источник истины оставался один (БД).
 *
 * Возвращаемая форма (ТЗ v2 §1.2):
 *   {
 *     project: { id, name, site_url, region, niche, audience,
 *                default_year, default_currency, pricing_notes,
 *                content_criteria, updated_at },
 *     brand:   { name, aliases, tokens, facts, tone, target_pages[] },
 *     market:  { competitors[], commercial_share, top_intent, brand_share },
 *     signals: { gsc, ydx, cannibalization[], striking_distance[] },
 *     history: { published_topics[], recent_meta_titles[] },
 *     last_analysis_at, snapshot_id,
 *     context_version: <sha1 от ключевых полей — для UI плашек>
 *   }
 *
 * Любая отсутствующая часть отдаётся как null или [] — потребитель должен
 * проверять. Никогда не бросает: если БД молчит, вернём минимальный объект
 * с проектом и пустыми блоками.
 */
const { deriveBrandTokens } = require('./commercialIntent');

async function buildProjectContext(projectId, userId) {
  const project = await _loadProject(projectId, userId);
  if (!project) return null;

  const [pageSnapshot, lastAnalysis, publishedTopics] = await Promise.all([
    _loadLatestPageSnapshot(projectId).catch(() => null),
    _loadLatestAnalysis(projectId).catch(() => null),
    _loadPublishedTopics(project, userId).catch(() => []),
  ]);

  const brand = _buildBrand(project, pageSnapshot);
  const gscCommercial = lastAnalysis?.gsc_snapshot?.commercial || null;
  const ydxCommercial = lastAnalysis?.ydx_snapshot?.commercial || null;
  const gsc = _summarizeCommercial(gscCommercial);
  const ydx = _summarizeCommercial(ydxCommercial);

  const cannibalization = _extractCannibalization(lastAnalysis?.gsc_snapshot);
  const strikingDistance = _extractStrikingDistance(lastAnalysis?.gsc_snapshot);
  const market = _buildMarket(lastAnalysis, gsc);

  const ctx = {
    project: {
      id: project.id,
      name: project.name,
      site_url: project.url || project.gsc_site_url || null,
      region: project.region || pageSnapshot?.detected_region || null,
      niche: project.niche || pageSnapshot?.niche || null,
      audience: project.audience || pageSnapshot?.audience || null,
      default_year: project.default_year || null,
      default_currency: project.default_currency || null,
      pricing_notes: project.pricing_notes || null,
      content_criteria: project.content_criteria || null,
      updated_at: project.updated_at || null,
    },
    brand,
    market,
    signals: {
      gsc,
      ydx,
      cannibalization,
      striking_distance: strikingDistance,
    },
    history: {
      published_topics: publishedTopics,
      recent_meta_titles: [],
    },
    last_analysis_at: lastAnalysis?.completed_at || lastAnalysis?.created_at || null,
    snapshot_id: pageSnapshot?.id || null,
  };

  ctx.context_version = computeContextVersion(ctx);
  return ctx;
}

/**
 * Хэш-версия контекста для UI-плашки «контекст устарел» (ТЗ §1.3 / §3.2).
 * Берём только поля, изменение которых должно вызвать предупреждение
 * («год, валюта, цены, факты, конкуренты, регион, ниша, аудитория, дата
 * последнего анализа»). Незначимые поля (snapshot_id, updated_at чистого
 * проекта) — не включаем, иначе плашка будет дребезжать.
 */
function computeContextVersion(ctx) {
  if (!ctx || !ctx.project) return null;
  const payload = {
    p: {
      year: ctx.project.default_year || null,
      cur: ctx.project.default_currency || null,
      pn: ctx.project.pricing_notes || null,
      cc: ctx.project.content_criteria || null,
      region: ctx.project.region || null,
      niche: ctx.project.niche || null,
      audience: ctx.project.audience || null,
    },
    b: {
      name: ctx.brand?.name || null,
      facts: ctx.brand?.facts || [],
      tone: ctx.brand?.tone || null,
    },
    m: {
      competitors: ctx.market?.competitors || [],
      top_intent: ctx.market?.top_intent || null,
    },
    la: ctx.last_analysis_at ? new Date(ctx.last_analysis_at).toISOString() : null,
  };
  const json = _stableStringify(payload);
  return crypto.createHash('sha1').update(json).digest('hex').slice(0, 16);
}

/** Стабильная сериализация: сортируем ключи на всех уровнях, чтобы хэш
 *  не зависел от порядка вставки полей. */
function _stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(_stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + _stableStringify(value[k])).join(',') + '}';
}

async function _loadProject(id, userId) {
  const { rows } = await db.query(
    `SELECT * FROM projects WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] || null;
}

/**
 * project_page_snapshots — кеш targetPageAnalyzer (мигр. 067 в основном
 * deployment'е). Если таблицы нет — вернём null без шума.
 */
async function _loadLatestPageSnapshot(projectId) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM project_page_snapshots
        WHERE project_id = $1
        ORDER BY created_at DESC NULLS LAST
        LIMIT 1`,
      [projectId],
    );
    return rows[0] || null;
  } catch (e) {
    // Таблицы может не быть на старых деплоях — это не повод падать.
    if (e.code === '42P01') return null;
    throw e;
  }
}

async function _loadLatestAnalysis(projectId) {
  const { rows } = await db.query(
    `SELECT id, completed_at, created_at, gsc_snapshot, ydx_snapshot
       FROM project_analyses
      WHERE project_id = $1 AND status = 'completed'
      ORDER BY completed_at DESC NULLS LAST, created_at DESC
      LIMIT 1`,
    [projectId],
  );
  return rows[0] || null;
}

/**
 * История опубликованных тем по brand_key проекта (ТЗ §1.2 / §2.3).
 * brand_key вычисляется из имени проекта / бренда на последнем page-snapshot.
 * Возвращает массив `{ topic_title_canon, intent_facet, created_at }` —
 * compactProjectSnapshot и projectContextBlock уже умеют его рендерить.
 */
async function _loadPublishedTopics(project, userId) {
  try {
    const { normalizeBrandKey } = require('../articleTopics/brandKey');
    // Бренд-ключ: имя проекта — единственная стабильная подсказка на
    // этом уровне. Если у проекта есть pageSnapshot.brand_name — он бы
    // приоритетнее, но pageSnapshot грузится параллельно; здесь
    // достаточно name.
    const brandKey = normalizeBrandKey(project.name || project.url || '');
    if (!brandKey || !userId) return [];
    const { rows } = await db.query(
      `SELECT topic_title_canon, intent_facet, created_at
         FROM article_topics_brand_history
        WHERE user_id = $1 AND brand_key = $2
          AND created_at > NOW() - INTERVAL '730 days'
        ORDER BY created_at DESC
        LIMIT 500`,
      [userId, brandKey],
    );
    return rows;
  } catch (e) {
    if (e && e.code === '42P01') return []; // таблицы нет
    return [];
  }
}

function _extractCannibalization(gscSnapshot) {
  if (!gscSnapshot || typeof gscSnapshot !== 'object') return [];
  const plan = gscSnapshot.action_plan || null;
  if (!plan || !Array.isArray(plan.cannibalization)) return [];
  return plan.cannibalization.slice(0, 50).map((c) => ({
    query: c.query || null,
    intent: c.intent || null,
    best_position: c.best_position ?? null,
    verdict: c.verdict || null,
    pages: Array.isArray(c.pages) ? c.pages.slice(0, 5) : [],
  }));
}

function _extractStrikingDistance(gscSnapshot) {
  if (!gscSnapshot || typeof gscSnapshot !== 'object') return [];
  const plan = gscSnapshot.action_plan || null;
  if (!plan || !Array.isArray(plan.striking_distance)) return [];
  return plan.striking_distance.slice(0, 50).map((s) => ({
    query: s.query || null,
    position: s.position ?? null,
    page: s.page || null,
  }));
}

function _buildMarket(lastAnalysis, gscSummary) {
  const competitors = [];
  const gsc = lastAnalysis?.gsc_snapshot || {};
  if (Array.isArray(gsc.competitors)) {
    for (const c of gsc.competitors.slice(0, 8)) {
      if (typeof c === 'string') competitors.push(c);
      else if (c && c.domain) competitors.push(c.domain);
    }
  }
  return {
    competitors,
    commercial_share: gscSummary?.commercial_share ?? null,
    top_intent: gscSummary?.top_intent || null,
    brand_share: gscSummary?.brand_share ?? null,
  };
}

function _buildBrand(project, pageSnapshot) {
  const name = pageSnapshot?.brand_name || project.name || null;
  const facts = Array.isArray(pageSnapshot?.brand_facts) ? pageSnapshot.brand_facts
              : (pageSnapshot?.brand_facts ? [pageSnapshot.brand_facts] : []);
  const tokens = deriveBrandTokens({
    name,
    siteUrl: project.gsc_site_url,
    url: project.url,
  });
  const aliases = Array.isArray(pageSnapshot?.brand_aliases) ? pageSnapshot.brand_aliases : [];
  return {
    name,
    aliases,
    tokens,
    facts,
    tone: pageSnapshot?.tone || project.brand_tone || null,
  };
}

function _summarizeCommercial(commercial) {
  if (!commercial || typeof commercial !== 'object') return null;
  // Срез intent_distribution: { transactional: N, commercial: N, ... }.
  // Берём 1-й по убыванию — он определяет основной интент трафика.
  let topIntent = null;
  const dist = commercial.intent_distribution || null;
  if (dist && typeof dist === 'object') {
    let best = -1;
    for (const [k, v] of Object.entries(dist)) {
      const n = Number(v) || 0;
      if (n > best) { best = n; topIntent = k; }
    }
  }
  return {
    commercial_share: commercial.commercial_share_pct ?? commercial.commercial_share ?? null,
    top_intent: topIntent,
    brand_share: commercial.brand_share_pct ?? commercial.brand_share ?? null,
  };
}

module.exports = {
  buildProjectContext,
  computeContextVersion,
  _summarizeCommercial,
  _buildBrand,
};
