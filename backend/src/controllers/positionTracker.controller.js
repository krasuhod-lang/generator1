'use strict';

/**
 * Controller для модуля Position Tracker — съём позиций через XMLStock.
 *
 * Маршруты (см. routes/positionTracker.routes.js):
 *   POST   /api/position-tracker/projects
 *   GET    /api/position-tracker/projects
 *   GET    /api/position-tracker/projects/:id
 *   PATCH  /api/position-tracker/projects/:id
 *   DELETE /api/position-tracker/projects/:id
 *
 *   POST   /api/position-tracker/projects/:id/keywords
 *   DELETE /api/position-tracker/projects/:id/keywords/:kwId
 *
 *   POST   /api/position-tracker/projects/:id/runs
 *   GET    /api/position-tracker/projects/:id/runs
 *
 *   GET    /api/position-tracker/projects/:id/summary
 *   GET    /api/position-tracker/projects/:id/series
 *   GET    /api/position-tracker/projects/:id/keywords/:kwId/series
 *   GET    /api/position-tracker/projects/:id/keywords-table
 *   GET    /api/position-tracker/projects/:id/movers
 */

const db = require('../config/db');
const { runPositionRun } = require('../services/positionTracker/runner');
const analytics = require('../services/positionTracker/analytics');
const { normalizeHost } = require('../services/positionTracker/xmlstockSerp');

// ── валидация ──────────────────────────────────────────────────────

const ENGINES   = new Set(['yandex', 'google', 'both']);
const DEVICES   = new Set(['desktop', 'mobile']);
const SCHEDULES = new Set(['daily', 'weekly', 'manual']);
const REGION_RE = /^\d{1,6}$/;

function _clip(s, n) {
  if (s == null) return '';
  return String(s).slice(0, n).trim();
}

async function _ownProject(req, res) {
  const id = req.params.id;
  const { rows } = await db.query(
    `SELECT id, user_id, name, domain, engine::text AS engine,
            geo_lr, geo_loc, device::text AS device,
            schedule::text AS schedule, last_run_at, created_at, updated_at
       FROM position_projects
      WHERE id = $1`,
    [id],
  );
  const p = rows[0];
  if (!p) { res.status(404).json({ error: 'Проект не найден' }); return null; }
  if (p.user_id !== req.user.id) { res.status(403).json({ error: 'Нет доступа' }); return null; }
  return p;
}

// ── Projects CRUD ──────────────────────────────────────────────────

async function listProjects(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT p.id, p.name, p.domain, p.engine::text AS engine,
              p.geo_lr, p.geo_loc, p.device::text AS device,
              p.schedule::text AS schedule, p.last_run_at, p.created_at,
              (SELECT COUNT(*)::int FROM position_keywords k
                 WHERE k.project_id = p.id AND k.is_active = TRUE) AS keywords_active
         FROM position_projects p
        WHERE p.user_id = $1
        ORDER BY p.created_at DESC
        LIMIT 200`,
      [req.user.id],
    );
    res.json({ projects: rows });
  } catch (err) { next(err); }
}

async function createProject(req, res, next) {
  try {
    const body = req.body || {};
    const name   = _clip(body.name, 200);
    const domain = normalizeHost(_clip(body.domain, 200));
    const engine = _clip(body.engine, 16).toLowerCase() || 'yandex';
    const geo_lr = _clip(body.geo_lr, 16);
    const geo_loc = _clip(body.geo_loc, 200);
    const device = _clip(body.device, 16).toLowerCase() || 'desktop';
    const schedule = _clip(body.schedule, 16).toLowerCase() || 'manual';

    if (!domain) return res.status(400).json({ error: 'Укажите домен' });
    if (!ENGINES.has(engine)) return res.status(400).json({ error: 'engine: yandex|google|both' });
    if (!DEVICES.has(device)) return res.status(400).json({ error: 'device: desktop|mobile' });
    if (!SCHEDULES.has(schedule)) return res.status(400).json({ error: 'schedule: daily|weekly|manual' });
    if (geo_lr && !REGION_RE.test(geo_lr)) return res.status(400).json({ error: 'geo_lr должен быть числовым кодом региона' });

    const { rows } = await db.query(
      `INSERT INTO position_projects (user_id, name, domain, engine, geo_lr, geo_loc, device, schedule)
       VALUES ($1,$2,$3,$4::position_engine,$5,$6,$7::position_device,$8::position_schedule)
       RETURNING id, name, domain, engine::text AS engine, geo_lr, geo_loc,
                 device::text AS device, schedule::text AS schedule, created_at`,
      [req.user.id, name || domain, domain, engine, geo_lr, geo_loc, device, schedule],
    );
    res.status(201).json({ project: rows[0] });
  } catch (err) { next(err); }
}

async function getProject(req, res, next) {
  try {
    const project = await _ownProject(req, res);
    if (!project) return;
    const { rows: kws } = await db.query(
      `SELECT id, query, target_url, tags, is_active, created_at
         FROM position_keywords
        WHERE project_id = $1
        ORDER BY created_at ASC`,
      [project.id],
    );
    res.json({ project, keywords: kws });
  } catch (err) { next(err); }
}

async function updateProject(req, res, next) {
  try {
    const project = await _ownProject(req, res);
    if (!project) return;
    const body = req.body || {};
    const fields = [];
    const params = [];
    function add(col, val, cast) {
      params.push(val);
      fields.push(`${col} = $${params.length}${cast ? `::${cast}` : ''}`);
    }
    if (typeof body.name === 'string')   add('name',   _clip(body.name, 200));
    if (typeof body.domain === 'string') add('domain', normalizeHost(_clip(body.domain, 200)));
    if (typeof body.engine === 'string') {
      const e = body.engine.toLowerCase();
      if (!ENGINES.has(e)) return res.status(400).json({ error: 'engine: yandex|google|both' });
      add('engine', e, 'position_engine');
    }
    if (typeof body.geo_lr === 'string')  {
      if (body.geo_lr && !REGION_RE.test(body.geo_lr)) return res.status(400).json({ error: 'geo_lr' });
      add('geo_lr', _clip(body.geo_lr, 16));
    }
    if (typeof body.geo_loc === 'string') add('geo_loc', _clip(body.geo_loc, 200));
    if (typeof body.device === 'string') {
      const d = body.device.toLowerCase();
      if (!DEVICES.has(d)) return res.status(400).json({ error: 'device: desktop|mobile' });
      add('device', d, 'position_device');
    }
    if (typeof body.schedule === 'string') {
      const s = body.schedule.toLowerCase();
      if (!SCHEDULES.has(s)) return res.status(400).json({ error: 'schedule' });
      add('schedule', s, 'position_schedule');
    }
    if (!fields.length) return res.json({ project });
    fields.push('updated_at = NOW()');
    params.push(project.id);
    const sql = `UPDATE position_projects SET ${fields.join(', ')}
                  WHERE id = $${params.length}
                  RETURNING id, name, domain, engine::text AS engine, geo_lr, geo_loc,
                            device::text AS device, schedule::text AS schedule, last_run_at`;
    const { rows } = await db.query(sql, params);
    res.json({ project: rows[0] });
  } catch (err) { next(err); }
}

async function deleteProject(req, res, next) {
  try {
    const project = await _ownProject(req, res);
    if (!project) return;
    await db.query(`DELETE FROM position_projects WHERE id = $1`, [project.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
}

// ── Keywords ───────────────────────────────────────────────────────

async function addKeywords(req, res, next) {
  try {
    const project = await _ownProject(req, res);
    if (!project) return;
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
        [project.id, q, targetUrl, JSON.stringify(tags)],
      );
      inserted.push(rows[0]);
    }
    res.status(201).json({ keywords: inserted });
  } catch (err) { next(err); }
}

async function deleteKeyword(req, res, next) {
  try {
    const project = await _ownProject(req, res);
    if (!project) return;
    await db.query(
      `DELETE FROM position_keywords WHERE id = $1 AND project_id = $2`,
      [req.params.kwId, project.id],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
}

// ── Runs ───────────────────────────────────────────────────────────

async function startRun(req, res, next) {
  try {
    const project = await _ownProject(req, res);
    if (!project) return;
    const engine = req.body?.engine ? String(req.body.engine).toLowerCase() : null;
    if (engine && !ENGINES.has(engine)) {
      return res.status(400).json({ error: 'engine: yandex|google|both' });
    }
    // Запускаем асинхронно — не блокируем HTTP-ответ.
    res.status(202).json({ ok: true, status: 'started' });
    runPositionRun(project.id, engine ? { engine } : {}).catch((err) => {
      console.warn(`[positionTracker] run for project ${project.id} failed:`, err.message);
    });
  } catch (err) { next(err); }
}

async function listRuns(req, res, next) {
  try {
    const project = await _ownProject(req, res);
    if (!project) return;
    const { rows } = await db.query(
      `SELECT id, engine, status::text AS status, error,
              keywords_total, keywords_done, started_at, finished_at
         FROM position_runs
        WHERE project_id = $1
        ORDER BY started_at DESC
        LIMIT 50`,
      [project.id],
    );
    res.json({ runs: rows });
  } catch (err) { next(err); }
}

// ── Analytics ──────────────────────────────────────────────────────

async function getSummary(req, res, next) {
  try {
    const project = await _ownProject(req, res);
    if (!project) return;
    const period = String(req.query.period || 'week');
    const engine = req.query.engine ? String(req.query.engine) : undefined;
    const summary = await analytics.getProjectSummary(project.id, { period, engine });
    res.json({ summary, period });
  } catch (err) { next(err); }
}

async function getProjectSeries(req, res, next) {
  try {
    const project = await _ownProject(req, res);
    if (!project) return;
    const { granularity = 'day', from, to, engine } = req.query || {};
    const series = await analytics.getProjectSeries(project.id, { granularity, from, to, engine });
    res.json({ series, granularity });
  } catch (err) { next(err); }
}

async function getKeywordSeries(req, res, next) {
  try {
    const project = await _ownProject(req, res);
    if (!project) return;
    // удостоверимся, что keyword принадлежит проекту
    const { rows } = await db.query(
      `SELECT id, query FROM position_keywords WHERE id = $1 AND project_id = $2`,
      [req.params.kwId, project.id],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Keyword not found' });
    const { granularity = 'day', from, to, engine } = req.query || {};
    const series = await analytics.getKeywordSeries(rows[0].id, { granularity, from, to, engine });
    res.json({ keyword: rows[0], series, granularity });
  } catch (err) { next(err); }
}

async function getMovers(req, res, next) {
  try {
    const project = await _ownProject(req, res);
    if (!project) return;
    const direction = String(req.query.direction || 'down');
    const period = String(req.query.period || 'week');
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const engine = req.query.engine ? String(req.query.engine) : undefined;
    const movers = await analytics.getMovers(project.id, { direction, period, limit, engine });
    res.json({ movers, direction, period });
  } catch (err) { next(err); }
}

async function getKeywordsTable(req, res, next) {
  try {
    const project = await _ownProject(req, res);
    if (!project) return;
    const period = String(req.query.period || 'week');
    const engine = req.query.engine ? String(req.query.engine) : undefined;
    const rows = await analytics.getKeywordsTable(project.id, { period, engine });
    res.json({ keywords: rows, period });
  } catch (err) { next(err); }
}

module.exports = {
  listProjects, createProject, getProject, updateProject, deleteProject,
  addKeywords, deleteKeyword,
  startRun, listRuns,
  getSummary, getProjectSeries, getKeywordSeries, getMovers, getKeywordsTable,
};
