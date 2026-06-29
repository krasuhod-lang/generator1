'use strict';

/**
 * controllers/siteCrawler.controller.js — REST для модуля «парсер сайта»
 * (задача 3). Все handler-ы требуют auth (req.user.id), привязка к project_id
 * опциональна — если указана, проверяем грант через projectGrants (задача 1).
 *
 *   POST   /api/site-crawler/tasks                 — создать задачу (запускает в фоне)
 *   GET    /api/site-crawler/tasks                 — список задач пользователя
 *   GET    /api/site-crawler/tasks/:id             — статус + stats
 *   GET    /api/site-crawler/tasks/:id/pages       — табличный вывод (paginated)
 *   GET    /api/site-crawler/tasks/:id/tree        — JSON-дерево URL
 *   GET    /api/site-crawler/tasks/:id/export.csv  — стрим CSV
 *   GET    /api/site-crawler/tasks/:id/export.xlsx — стрим XLSX
 *   POST   /api/site-crawler/tasks/:id/cancel      — soft-cancel
 *   DELETE /api/site-crawler/tasks/:id             — удалить задачу
 */

const db        = require('../config/db');
const crawler   = require('../services/siteCrawler/crawler');
const urlN      = require('../services/siteCrawler/urlNormalizer');
const tree      = require('../services/siteCrawler/treeBuilder');
const csvExp    = require('../services/siteCrawler/exporters/csv');
const xlsxExp   = require('../services/siteCrawler/exporters/xlsx');
const { loadAccessibleProject, canAct } = require('../services/projects/projectGrants');

const MAX_CONCURRENT_TASKS = 2;
const PAGE_COLUMNS = [
  'url','depth','parent_url','http_status','content_type','title','h1',
  'description','canonical','robots','fetched_at','duration_ms','error',
];

async function _loadTask(taskId, userId, opts = {}) {
  const { rows } = await db.query(
    `SELECT id, user_id, project_id, start_url, options, status, stats, error,
            created_at, started_at, finished_at
       FROM site_crawl_tasks
      WHERE id = $1`, [taskId],
  );
  if (!rows.length) { const e = new Error('task_not_found'); e.status = 404; throw e; }
  const t = rows[0];
  if (t.user_id !== userId && !(opts.allowAdmin && opts.isAdmin)) {
    const e = new Error('forbidden'); e.status = 403; throw e;
  }
  return t;
}

async function createTask(req, res) {
  const userId    = req.user && req.user.id;
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  const startRaw  = req.body && req.body.start_url;
  const projectId = (req.body && req.body.project_id) || null;
  const options   = (req.body && req.body.options) || {};

  const start = urlN.normalize(startRaw);
  if (!start) return res.status(400).json({ error: 'invalid_start_url' });

  if (projectId) {
    try {
      const access = await loadAccessibleProject(projectId, userId);
      if (!access) return res.status(403).json({ error: 'project_forbidden' });
      if (!canAct(access, 'read', 'analyses') && !access.isOwner) {
        return res.status(403).json({ error: 'project_forbidden' });
      }
    } catch (_) { return res.status(403).json({ error: 'project_forbidden' }); }
  }

  // per-user limit на одновременные задачи
  const { rows: running } = await db.query(
    `SELECT COUNT(*)::int AS n FROM site_crawl_tasks
       WHERE user_id=$1 AND status IN ('queued','running')`, [userId],
  );
  if ((running[0] && running[0].n) >= MAX_CONCURRENT_TASKS) {
    return res.status(429).json({ error: 'too_many_running_tasks',
      limit: MAX_CONCURRENT_TASKS });
  }

  const { rows } = await db.query(
    `INSERT INTO site_crawl_tasks (user_id, project_id, start_url, options, status)
     VALUES ($1, $2, $3, $4::jsonb, 'queued')
     RETURNING id, status, created_at`,
    [userId, projectId, start, JSON.stringify(options || {})],
  );
  const taskId = rows[0].id;

  // Запуск в фоне — паттерн репозитория (см. setImmediate в analysisRunner).
  setImmediate(() => {
    crawler.runCrawl({ taskId, startUrl: start, options })
      .catch(async (e) => {
        try {
          await db.query(
            `UPDATE site_crawl_tasks
                SET status='error', error=$2, finished_at=NOW()
              WHERE id=$1 AND status NOT IN ('done','cancelled')`,
            [taskId, e.message.slice(0, 500)],
          );
        } catch (_) {}
        // eslint-disable-next-line no-console
        console.warn('[siteCrawler] runCrawl failed:', e.message);
      });
  });

  res.status(201).json({ id: taskId, status: 'queued', start_url: start });
}

async function listTasks(req, res) {
  const userId = req.user.id;
  const { rows } = await db.query(
    `SELECT id, project_id, start_url, status, stats,
            created_at, started_at, finished_at, error
       FROM site_crawl_tasks
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 200`, [userId],
  );
  res.json({ items: rows });
}

async function getTask(req, res) {
  try {
    const t = await _loadTask(Number(req.params.id), req.user.id);
    res.json(t);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
}

async function listPages(req, res) {
  try {
    const t = await _loadTask(Number(req.params.id), req.user.id);
    const page  = Math.max(1,   Number(req.query.page)  || 1);
    const limit = Math.max(1,   Math.min(500, Number(req.query.limit) || 100));
    const search = (req.query.search || '').toString().trim();
    const params = [t.id];
    let where = `task_id = $1`;
    if (search) {
      params.push('%' + search + '%');
      where += ` AND (url ILIKE $${params.length} OR title ILIKE $${params.length} OR h1 ILIKE $${params.length})`;
    }
    const offset = (page - 1) * limit;
    const { rows } = await db.query(
      `SELECT ${PAGE_COLUMNS.join(', ')}
         FROM site_crawl_pages
        WHERE ${where}
        ORDER BY depth ASC, url ASC
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    const { rows: totalRows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM site_crawl_pages WHERE ${where}`, params,
    );
    res.json({ items: rows, page, limit, total: totalRows[0].n });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
}

async function getTree(req, res) {
  try {
    const t = await _loadTask(Number(req.params.id), req.user.id);
    const { rows } = await db.query(
      `SELECT url, http_status, title, h1, description
         FROM site_crawl_pages WHERE task_id = $1`, [t.id],
    );
    const origin = (() => { try { return new URL(t.start_url).origin; } catch (_) { return null; } })();
    const { tree: built } = tree.buildTree(rows, origin);
    res.json({ origin, tree: built });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
}

async function _streamPagesQuery(taskId) {
  const { rows } = await db.query(
    `SELECT ${PAGE_COLUMNS.join(', ')}
       FROM site_crawl_pages
      WHERE task_id = $1
      ORDER BY depth ASC, url ASC`, [taskId],
  );
  return rows;
}

async function exportCsv(req, res) {
  try {
    const t = await _loadTask(Number(req.params.id), req.user.id);
    const rows = await _streamPagesQuery(t.id);
    const csv = csvExp.buildCsv(rows, { headers: PAGE_COLUMNS });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="site-crawl-${t.id}.csv"`);
    res.send(csv);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
}

async function exportXlsx(req, res) {
  try {
    const t = await _loadTask(Number(req.params.id), req.user.id);
    const rows = await _streamPagesQuery(t.id);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="site-crawl-${t.id}.xlsx"`);
    await xlsxExp.streamXlsx(rows, { headers: PAGE_COLUMNS, sheet: 'pages' }, res);
  } catch (e) {
    if (!res.headersSent) res.status(e.status || 500).json({ error: e.message });
  }
}

async function cancelTask(req, res) {
  try {
    const t = await _loadTask(Number(req.params.id), req.user.id);
    if (t.status === 'done' || t.status === 'error' || t.status === 'cancelled') {
      return res.json({ id: t.id, status: t.status });
    }
    await db.query(
      `UPDATE site_crawl_tasks
          SET status='cancelled', finished_at=COALESCE(finished_at, NOW())
        WHERE id=$1`, [t.id],
    );
    res.json({ id: t.id, status: 'cancelled' });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
}

async function deleteTask(req, res) {
  try {
    const t = await _loadTask(Number(req.params.id), req.user.id);
    await db.query(`DELETE FROM site_crawl_tasks WHERE id=$1`, [t.id]);
    res.json({ id: t.id, deleted: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
}

module.exports = {
  createTask, listTasks, getTask, listPages, getTree,
  exportCsv, exportXlsx, cancelTask, deleteTask,
};
