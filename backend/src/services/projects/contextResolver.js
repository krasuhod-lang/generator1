'use strict';

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
 * Возвращаемая форма:
 *   {
 *     project: { id, name, site_url, region, niche, audience },
 *     brand:   { name, tokens, facts, tone },
 *     gsc:     { commercial_share, top_intent, brand_share } | null,
 *     ydx:     { commercial_share, top_intent } | null,
 *     last_analysis_at, snapshot_id
 *   }
 *
 * Источники:
 *  - projects                — название, URL, регион, ниша, аудитория
 *  - project_analyses (last) — gsc_snapshot.commercial, ydx_snapshot.commercial
 *  - project_page_snapshots  — targetPageAnalyzer-факты (бренд, тон, факты)
 *  - commercialIntent.deriveBrandTokens — токены вычисляются на лету
 *
 * Любая отсутствующая часть отдаётся как null — потребитель должен
 * проверять. Никогда не бросает: если БД молчит, вернём минимальный объект
 * с проектом и пустыми блоками.
 */
const { deriveBrandTokens } = require('./commercialIntent');

async function buildProjectContext(projectId, userId) {
  const project = await _loadProject(projectId, userId);
  if (!project) return null;

  const [pageSnapshot, lastAnalysis] = await Promise.all([
    _loadLatestPageSnapshot(projectId).catch(() => null),
    _loadLatestAnalysis(projectId).catch(() => null),
  ]);

  const brand = _buildBrand(project, pageSnapshot);
  const gsc = _summarizeCommercial(lastAnalysis?.gsc_snapshot?.commercial);
  const ydx = _summarizeCommercial(lastAnalysis?.ydx_snapshot?.commercial);

  return {
    project: {
      id: project.id,
      name: project.name,
      site_url: project.url || project.gsc_site_url || null,
      region: project.region || pageSnapshot?.detected_region || null,
      niche: project.niche || pageSnapshot?.niche || null,
      audience: project.audience || pageSnapshot?.audience || null,
    },
    brand,
    gsc,
    ydx,
    last_analysis_at: lastAnalysis?.completed_at || lastAnalysis?.created_at || null,
    snapshot_id: pageSnapshot?.id || null,
  };
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

function _buildBrand(project, pageSnapshot) {
  const name = pageSnapshot?.brand_name || project.name || null;
  const facts = Array.isArray(pageSnapshot?.brand_facts) ? pageSnapshot.brand_facts
              : (pageSnapshot?.brand_facts ? [pageSnapshot.brand_facts] : []);
  const tokens = deriveBrandTokens({
    name,
    siteUrl: project.gsc_site_url,
    url: project.url,
  });
  return {
    name,
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
  _summarizeCommercial,
  _buildBrand,
};
