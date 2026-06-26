'use strict';

/**
 * positionsProxy.controller — прокси-эндпоинты «Съём позиций» внутри проекта.
 *
 * Раздаёт под `/api/projects/:id/positions/*` те же агрегаты, что и
 * автономный модуль `position-tracker`, но через цепочку:
 *   1) проверка владения SEO-проектом (user_id == req.user.id),
 *   2) ensureLinkedPositionProject — гарантия связанного position_projects
 *      с правильно заполненным gео (geo_lr/geo_loc из keys_so_region проекта),
 *   3) делегирование в positionTracker.runner / analytics.
 *
 * Преимущества vs прямой вызов /api/position-tracker:
 *   • один auth-контекст (нет необходимости разрешать «второй» проект),
 *   • дефолтное гео из SEO-проекта (а не пустое),
 *   • поверх можно навесить view-mode (см. share-секцию getSharedProject).
 */

const db = require('../config/db');
const {
  ensureLinkedPositionProject,
  updateLinkedPositionSettings,
} = require('../services/projects/positionBridge');
const analytics = require('../services/positionTracker/analytics');
const { runPositionRun } = require('../services/positionTracker/runner');
const { getProjectsConfig } = require('../services/projects/config');

const ENGINES   = new Set(['yandex', 'google', 'both']);
const DEVICES   = new Set(['desktop', 'mobile']);
const SCHEDULES = new Set(['daily', 'weekly', 'manual']);
const REGION_RE = /^\d{1,6}$/;

function _clip(s, n) {
  if (s == null) return '';
  return String(s).slice(0, n).trim();
}

/**
 * Загружает SEO-проект, проверяет владение, ensure-ит связанный
 * position_projects и возвращает { project, positionProject }.
 * Если нет прав/проект не найден — пишет ответ и возвращает null.
 */
async function _resolve(req, res) {
  const { rows } = await db.query(
    `SELECT id, user_id, name, url, keys_so_domain, keys_so_region,
            share_includes_positions
       FROM projects
      WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.id],
  );
  const project = rows[0];
  if (!project) { res.status(404).json({ error: 'Проект не найден' }); return null; }
  const positionProject = await ensureLinkedPositionProject(project);
  if (!positionProject) {
    res.status(500).json({ error: 'Не удалось инициализировать съём позиций' });
    return null;
  }
  return { project, positionProject };
}

async function _loadKeyword(positionProjectId, kwId) {
  const { rows } = await db.query(
    `SELECT id, query FROM position_keywords WHERE id = $1 AND project_id = $2`,
    [kwId, positionProjectId],
  );
  return rows[0] || null;
}

// ── GET /projects/:id/positions/overview ────────────────────────────
//   Сводка: связанный position-проект, последние 5 ранов, summary, кол-во
//   ключей. Грузится одним запросом для дешевизны UI-mount.
async function getOverview(req, res, next) {
  try {
    const ctx = await _resolve(req, res); if (!ctx) return;
    const { positionProject } = ctx;
    const period = String(req.query.period || 'week');
    const engine = req.query.engine ? String(req.query.engine) : undefined;
    const [summary, runsRes, keywordsCountRes] = await Promise.all([
      analytics.getProjectSummary(positionProject.id, { period, engine }),
      db.query(
        `SELECT id, engine, status::text AS status, error,
                keywords_total, keywords_done, started_at, finished_at
           FROM position_runs
          WHERE project_id = $1
          ORDER BY started_at DESC
          LIMIT 5`,
        [positionProject.id],
      ),
      db.query(
        `SELECT COUNT(*)::int AS n FROM position_keywords WHERE project_id = $1 AND is_active = TRUE`,
        [positionProject.id],
      ),
    ]);
    res.json({
      position_project: positionProject,
      summary,
      runs: runsRes.rows,
      keywords_active: keywordsCountRes.rows[0]?.n || 0,
      period,
      config: getProjectsConfig().positions,
    });
  } catch (err) { next(err); }
}

// ── GET /projects/:id/positions/keywords ────────────────────────────
async function getKeywordsTable(req, res, next) {
  try {
    const ctx = await _resolve(req, res); if (!ctx) return;
    const period = String(req.query.period || 'week');
    const engine = req.query.engine ? String(req.query.engine) : undefined;
    const rows = await analytics.getKeywordsTable(ctx.positionProject.id, { period, engine });
    res.json({ keywords: rows, period });
  } catch (err) { next(err); }
}

// ── POST /projects/:id/positions/keywords ───────────────────────────
async function addKeywords(req, res, next) {
  try {
    const ctx = await _resolve(req, res); if (!ctx) return;
    const body = req.body || {};
    let queries = body.queries;
    if (!Array.isArray(queries)) {
      const single = _clip(body.query, 500);
      queries = single ? [single] : [];
    }
    const targetUrl = body.target_url ? _clip(body.target_url, 500) : null;
    const tags = Array.isArray(body.tags) ? body.tags.slice(0, 20) : [];

    const cleaned = [];
    const seen = new Set();
    for (const q of queries) {
      const v = _clip(q, 500);
      if (!v) continue;
      const k = v.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      cleaned.push(v);
    }
    if (!cleaned.length) return res.status(400).json({ error: 'Список запросов пуст' });

    const inserted = [];
    for (const q of cleaned) {
      const { rows } = await db.query(
        `INSERT INTO position_keywords (project_id, query, target_url, tags)
         VALUES ($1,$2,$3,$4::jsonb)
         ON CONFLICT (project_id, query) DO UPDATE SET is_active = TRUE
         RETURNING id, query, target_url, tags, is_active, created_at`,
        [ctx.positionProject.id, q, targetUrl, JSON.stringify(tags)],
      );
      inserted.push(rows[0]);
    }
    res.status(201).json({ keywords: inserted });
  } catch (err) { next(err); }
}

// ── DELETE /projects/:id/positions/keywords/:kwId ───────────────────
async function deleteKeyword(req, res, next) {
  try {
    const ctx = await _resolve(req, res); if (!ctx) return;
    await db.query(
      `DELETE FROM position_keywords WHERE id = $1 AND project_id = $2`,
      [req.params.kwId, ctx.positionProject.id],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
}

// ── POST /projects/:id/positions/runs ───────────────────────────────
async function startRun(req, res, next) {
  try {
    const ctx = await _resolve(req, res); if (!ctx) return;
    const engine = req.body?.engine ? String(req.body.engine).toLowerCase() : null;
    if (engine && !ENGINES.has(engine)) {
      return res.status(400).json({ error: 'engine: yandex|google|both' });
    }
    res.status(202).json({ ok: true, status: 'started' });
    runPositionRun(ctx.positionProject.id, engine ? { engine } : {}).catch((err) => {
      console.warn(`[positionsProxy] run for project ${ctx.positionProject.id} failed:`, err.message);
    });
  } catch (err) { next(err); }
}

// ── GET /projects/:id/positions/runs ────────────────────────────────
async function listRuns(req, res, next) {
  try {
    const ctx = await _resolve(req, res); if (!ctx) return;
    const { rows } = await db.query(
      `SELECT id, engine, status::text AS status, error,
              keywords_total, keywords_done, started_at, finished_at
         FROM position_runs
        WHERE project_id = $1
        ORDER BY started_at DESC
        LIMIT 50`,
      [ctx.positionProject.id],
    );
    res.json({ runs: rows });
  } catch (err) { next(err); }
}

// ── GET /projects/:id/positions/series ──────────────────────────────
async function getProjectSeries(req, res, next) {
  try {
    const ctx = await _resolve(req, res); if (!ctx) return;
    const { granularity = 'day', from, to, engine } = req.query || {};
    const series = await analytics.getProjectSeries(ctx.positionProject.id, {
      granularity, from, to, engine,
    });
    res.json({ series, granularity });
  } catch (err) { next(err); }
}

// ── GET /projects/:id/positions/keywords/:kwId/series ───────────────
async function getKeywordSeries(req, res, next) {
  try {
    const ctx = await _resolve(req, res); if (!ctx) return;
    const kw = await _loadKeyword(ctx.positionProject.id, req.params.kwId);
    if (!kw) return res.status(404).json({ error: 'Keyword not found' });
    const { granularity = 'day', from, to, engine } = req.query || {};
    const series = await analytics.getKeywordSeries(kw.id, { granularity, from, to, engine });
    res.json({ keyword: kw, series, granularity });
  } catch (err) { next(err); }
}

// ── GET /projects/:id/positions/movers ──────────────────────────────
async function getMovers(req, res, next) {
  try {
    const ctx = await _resolve(req, res); if (!ctx) return;
    const direction = String(req.query.direction || 'down');
    const period = String(req.query.period || 'week');
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const engine = req.query.engine ? String(req.query.engine) : undefined;
    const movers = await analytics.getMovers(ctx.positionProject.id, {
      direction, period, limit, engine,
    });
    res.json({ movers, direction, period });
  } catch (err) { next(err); }
}

// ── GET /projects/:id/positions/tops-distribution ───────────────────
//   Stacked-area-данные для графика «распределение запросов по топам»
//   за текущий и предыдущий равный период.
async function getTopsDistribution(req, res, next) {
  try {
    const ctx = await _resolve(req, res); if (!ctx) return;
    const period = String(req.query.period || 'week');
    const engine = req.query.engine ? String(req.query.engine) : undefined;
    const cfgBuckets = getProjectsConfig().positions.topsBuckets;
    const dist = await analytics.getTopsDistribution(ctx.positionProject.id, {
      period, engine, buckets: cfgBuckets,
    });
    res.json({ ...dist, period });
  } catch (err) { next(err); }
}

// ── GET /projects/:id/positions/settings ────────────────────────────
async function getSettings(req, res, next) {
  try {
    const ctx = await _resolve(req, res); if (!ctx) return;
    res.json({
      settings: {
        engine:   ctx.positionProject.engine,
        device:   ctx.positionProject.device,
        schedule: ctx.positionProject.schedule,
        geo_lr:   ctx.positionProject.geo_lr || '',
        geo_loc:  ctx.positionProject.geo_loc || '',
        name:     ctx.positionProject.name,
        share_includes_positions: !!ctx.project.share_includes_positions,
      },
    });
  } catch (err) { next(err); }
}

// ── PATCH /projects/:id/positions/settings ──────────────────────────
async function updateSettings(req, res, next) {
  try {
    const ctx = await _resolve(req, res); if (!ctx) return;
    const body = req.body || {};
    const patch = {};
    if (typeof body.engine === 'string') {
      const v = body.engine.toLowerCase();
      if (!ENGINES.has(v)) return res.status(400).json({ error: 'engine: yandex|google|both' });
      patch.engine = v;
    }
    if (typeof body.device === 'string') {
      const v = body.device.toLowerCase();
      if (!DEVICES.has(v)) return res.status(400).json({ error: 'device: desktop|mobile' });
      patch.device = v;
    }
    if (typeof body.schedule === 'string') {
      const v = body.schedule.toLowerCase();
      if (!SCHEDULES.has(v)) return res.status(400).json({ error: 'schedule: daily|weekly|manual' });
      patch.schedule = v;
    }
    if (typeof body.geo_lr === 'string') {
      const v = body.geo_lr.trim();
      if (v && !REGION_RE.test(v)) return res.status(400).json({ error: 'geo_lr должен быть числовым кодом региона' });
      patch.geo_lr = v;
    }
    if (typeof body.geo_loc === 'string') patch.geo_loc = _clip(body.geo_loc, 200);
    if (typeof body.name === 'string')    patch.name    = _clip(body.name, 200);

    const updated = await updateLinkedPositionSettings(ctx.project.id, patch);

    // Параллельно: флаг видимости позиций в публичной (share) секции.
    // Живёт на projects.share_includes_positions, не на position_projects.
    if (typeof body.share_includes_positions === 'boolean') {
      await db.query(
        `UPDATE projects SET share_includes_positions = $2, updated_at = NOW()
          WHERE id = $1 AND user_id = $3`,
        [ctx.project.id, body.share_includes_positions, req.user.id],
      );
    }

    res.json({
      settings: updated ? {
        engine: updated.engine,
        device: updated.device,
        schedule: updated.schedule,
        geo_lr: updated.geo_lr || '',
        geo_loc: updated.geo_loc || '',
        name: updated.name,
      } : null,
    });
  } catch (err) { next(err); }
}

module.exports = {
  getOverview,
  getKeywordsTable,
  addKeywords,
  deleteKeyword,
  startRun,
  listRuns,
  getProjectSeries,
  getKeywordSeries,
  getMovers,
  getTopsDistribution,
  getSettings,
  updateSettings,
};
