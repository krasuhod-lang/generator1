'use strict';

/**
 * Controller для SERP B2B Crawler & Contact Extractor.
 *
 *   GET    /api/serp-b2b              — список задач пользователя
 *   POST   /api/serp-b2b              — создать и запустить задачу
 *   GET    /api/serp-b2b/:id          — детальная задача (поллинг прогресса)
 *   DELETE /api/serp-b2b/:id          — удалить
 *   GET    /api/serp-b2b/:id/export.xlsx — выгрузить результаты в Excel
 */

const db = require('../config/db');
const { processSerpB2bTask } = require('../services/serpB2b/pipeline');
const { buildXlsx } = require('../services/serpB2b/xlsxExporter');
const { withUserSlot } = require('../utils/perUserConcurrency');
const { resolveOwnedProjectId } = require('../services/projects/projectOwnership');

const MAX_QUERY_LEN = 200;
const MIN_DEPTH = 1;
const MAX_DEPTH = 10;

const ALLOWED_ENGINES = new Set(['yandex', 'google']);

// Регион принимаем как код Яндекс-региона (lr): пустая строка или
// строка из 1..6 цифр. Этого формата достаточно и для Google (xmlstock
// также пропускает `lr` параметр).
const REGION_RE = /^\d{1,6}$/;

function _clip(s, n) {
  if (s == null) return '';
  return String(s).slice(0, n).trim();
}

function _safeFileName(name, fallback) {
  return String(name || fallback)
    .replace(/[^a-zA-Z0-9_\-а-яА-ЯёЁ]+/g, '_')
    .slice(0, 80) || fallback;
}

// ─── GET /api/serp-b2b ────────────────────────────────────────────
async function listSerpB2bTasks(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, name, query, search_engine, depth_pages, region, status,
              error_message, total_sites, processed_sites,
              created_at, started_at, completed_at
         FROM serp_b2b_tasks
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 200`,
      [req.user.id],
    );
    return res.json({ tasks: rows });
  } catch (err) {
    return next(err);
  }
}

// ─── POST /api/serp-b2b ───────────────────────────────────────────
async function createSerpB2bTask(req, res, next) {
  try {
    const body = req.body || {};
    const query = _clip(body.keyword || body.query, MAX_QUERY_LEN);
    const searchEngine = _clip(body.search_engine, 16).toLowerCase() || 'yandex';
    const depthPages = Math.min(
      MAX_DEPTH,
      Math.max(MIN_DEPTH, parseInt(body.depth_pages, 10) || 1),
    );
    const name = _clip(body.name, 200) || query;
    const region = _clip(body.region, 16);

    if (!query) {
      return res.status(400).json({ error: 'Укажите поисковый запрос (keyword)' });
    }
    if (!ALLOWED_ENGINES.has(searchEngine)) {
      return res.status(400).json({
        error: `search_engine должен быть одним из: ${[...ALLOWED_ENGINES].join(', ')}`,
      });
    }
    if (region && !REGION_RE.test(region)) {
      return res.status(400).json({
        error: 'region должен быть числовым кодом Яндекс-региона (lr), например 213 (Москва)',
      });
    }

    const inputs = { query, search_engine: searchEngine, depth_pages: depthPages, region };
    // ТЗ §5: явная привязка задачи к SEO-проекту (опциональная).
    const projectId = await resolveOwnedProjectId(req.body.project_id, req.user.id);

    const { rows } = await db.query(
      `INSERT INTO serp_b2b_tasks
          (user_id, name, query, search_engine, depth_pages, region, status, inputs, project_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7::jsonb, $8)
       RETURNING id, name, query, search_engine, depth_pages, region, status,
                 total_sites, processed_sites, project_id, created_at`,
      [req.user.id, name, query, searchEngine, depthPages, region, JSON.stringify(inputs), projectId],
    );
    const task = rows[0];

    setImmediate(() => {
      withUserSlot(req.user.id, () => processSerpB2bTask(task.id)).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[serpB2b] background task failed:', err.message);
      });
    });

    return res.status(201).json({ task });
  } catch (err) {
    return next(err);
  }
}

// ─── GET /api/serp-b2b/:id ────────────────────────────────────────
async function getSerpB2bTask(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, name, query, search_engine, depth_pages, region, status,
              error_message, results, total_sites, processed_sites,
              diagnostics, created_at, started_at, completed_at, updated_at
         FROM serp_b2b_tasks
        WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (!rows.length) return res.status(404).json({ error: 'Задача не найдена' });
    return res.json({ task: rows[0] });
  } catch (err) {
    return next(err);
  }
}

// ─── DELETE /api/serp-b2b/:id ─────────────────────────────────────
async function deleteSerpB2bTask(req, res, next) {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM serp_b2b_tasks WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Задача не найдена' });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
}

// ─── GET /api/serp-b2b/:id/export.xlsx ────────────────────────────
async function exportSerpB2bXlsx(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, name, query, results FROM serp_b2b_tasks
        WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (!rows.length) return res.status(404).json({ error: 'Задача не найдена' });

    const task = rows[0];
    const buf = await buildXlsx(task);

    const fname = `${_safeFileName(task.name || task.query, 'serp-b2b')}_${Date.now()}.xlsx`;
    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    return res.send(buf);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  listSerpB2bTasks,
  createSerpB2bTask,
  getSerpB2bTask,
  deleteSerpB2bTask,
  exportSerpB2bXlsx,
};
