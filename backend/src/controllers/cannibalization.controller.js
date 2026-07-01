'use strict';

/**
 * controllers/cannibalization.controller.js — REST для модуля «Сканер
 * каннибализации» (SERP-overlap по H1 краулера).
 *
 *   POST   /api/cannibalization/tasks                 — создать (запускает в фоне)
 *   GET    /api/cannibalization/tasks                 — список задач пользователя
 *   GET    /api/cannibalization/tasks/:id             — статус + stats
 *   GET    /api/cannibalization/tasks/:id/result      — кластеры + матрица
 *   GET    /api/cannibalization/tasks/:id/export.csv  — CSV матрицы/кластеров
 *   GET    /api/cannibalization/tasks/:id/export.xlsx — XLSX
 *   POST   /api/cannibalization/tasks/:id/cancel      — soft-cancel
 *   DELETE /api/cannibalization/tasks/:id             — удалить
 */

const db      = require('../config/db');
const runner  = require('../services/cannibalization/runner');
const csvExp   = require('../services/siteCrawler/exporters/csv');
const xlsxExp  = require('../services/siteCrawler/exporters/xlsx');
const { loadAccessibleProject, canAct } = require('../services/projects/projectGrants');

const MAX_CONCURRENT_TASKS = 2;
const ENGINES = new Set(['yandex', 'google']);

function _sanitizeOptions(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    minCommonUrls: Math.min(10, Math.max(1, Number(o.minCommonUrls) || 4)),
    topN:          Math.min(30, Math.max(3, Number(o.topN) || 10)),
    maxQueries:    Math.min(1000, Math.max(1, Number(o.maxQueries) || 300)),
    excludeOwnDomain: !!o.excludeOwnDomain,
    useAI:         !!o.useAI,
  };
}

async function _loadTask(taskId, userId) {
  const { rows } = await db.query(
    `SELECT id, user_id, project_id, crawl_task_id, lr, engine, options,
            status, stats, result, error, created_at, started_at, finished_at
       FROM cannibalization_tasks WHERE id = $1`, [taskId],
  );
  if (!rows.length) { const e = new Error('task_not_found'); e.status = 404; throw e; }
  const t = rows[0];
  if (t.user_id !== userId) { const e = new Error('forbidden'); e.status = 403; throw e; }
  return t;
}

async function createTask(req, res) {
  try {
    const userId = req.user && req.user.id;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const crawlTaskId = Number(req.body && req.body.crawl_task_id);
    if (!crawlTaskId) return res.status(400).json({ error: 'crawl_task_id_required' });

    const engine = ENGINES.has(req.body && req.body.engine) ? req.body.engine : 'yandex';
    const lr     = (req.body && req.body.lr != null) ? String(req.body.lr).trim() : '';
    const options = _sanitizeOptions(req.body && req.body.options);

    // Проверяем, что crawl-задача принадлежит пользователю и имеет H1.
    const { rows: crawlRows } = await db.query(
      `SELECT id, user_id, project_id FROM site_crawl_tasks WHERE id = $1`, [crawlTaskId],
    );
    if (!crawlRows.length) return res.status(404).json({ error: 'crawl_task_not_found' });
    if (crawlRows[0].user_id !== userId) return res.status(403).json({ error: 'forbidden' });
    const projectId = crawlRows[0].project_id || null;

    if (projectId) {
      try {
        const accessRow = await loadAccessibleProject(projectId, userId);
        if (!accessRow) return res.status(403).json({ error: 'project_forbidden' });
        const acc = accessRow.access || accessRow;
        if (!acc.isOwner && !canAct(acc, 'read', 'analyses')) {
          return res.status(403).json({ error: 'project_forbidden' });
        }
      } catch (_) { return res.status(403).json({ error: 'project_forbidden' }); }
    }

    const { rows: running } = await db.query(
      `SELECT COUNT(*)::int AS n FROM cannibalization_tasks
        WHERE user_id=$1 AND status IN ('queued','running')`, [userId],
    );
    if ((running[0] && running[0].n) >= MAX_CONCURRENT_TASKS) {
      return res.status(429).json({ error: 'too_many_running_tasks', limit: MAX_CONCURRENT_TASKS });
    }

    const { rows } = await db.query(
      `INSERT INTO cannibalization_tasks
         (user_id, project_id, crawl_task_id, lr, engine, options, status)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,'queued')
       RETURNING id, status, created_at`,
      [userId, projectId, crawlTaskId, lr || null, engine, JSON.stringify(options)],
    );
    const taskId = rows[0].id;

    setImmediate(() => {
      runner.runTask({ taskId }).catch(async (e) => {
        try {
          await db.query(
            `UPDATE cannibalization_tasks
                SET status='error', error=$2, finished_at=NOW()
              WHERE id=$1 AND status NOT IN ('done','cancelled')`,
            [taskId, (e.message || 'error').slice(0, 500)],
          );
        } catch (_) {}
        // eslint-disable-next-line no-console
        console.warn('[cannibalization] runTask failed:', e.message);
      });
    });

    res.status(201).json({ id: taskId, status: 'queued', engine, lr: lr || null, options });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[cannibalization.createTask]', e.stack || e.message);
    res.status(e.status || 500).json({ error: e.message || 'internal_error' });
  }
}

async function listTasks(req, res) {
  try {
    const userId = req.user.id;
    const { rows } = await db.query(
      `SELECT id, project_id, crawl_task_id, lr, engine, options, status, stats,
              error, created_at, started_at, finished_at
         FROM cannibalization_tasks
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 200`, [userId],
    );
    res.json({ items: rows });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[cannibalization.listTasks]', e.stack || e.message);
    res.status(e.status || 500).json({ error: e.message || 'internal_error' });
  }
}

async function getTask(req, res) {
  try {
    const t = await _loadTask(Number(req.params.id), req.user.id);
    // Не гоним тяжёлый result в статус-поллинге.
    delete t.result;
    res.json(t);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
}

async function getResult(req, res) {
  try {
    const t = await _loadTask(Number(req.params.id), req.user.id);
    res.json({ id: t.id, status: t.status, stats: t.stats, result: t.result || null });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
}

// Строки для CSV/XLSX: матрица пар (запрос_A, запрос_B, общих_URL, кластер, под_слияние).
function _matrixRows(result) {
  if (!result) return [];
  const clusterOf = new Map();          // query → cluster id
  for (const c of (result.clusters || [])) {
    for (const m of c.members) clusterOf.set(m.query, c.id);
  }
  const rows = [];
  for (const m of (result.matrix || [])) {
    const merge = (clusterOf.has(m.a) && clusterOf.get(m.a) === clusterOf.get(m.b));
    rows.push({
      query_a: m.a,
      url_a: m.a_url || '',
      query_b: m.b,
      url_b: m.b_url || '',
      common_urls: m.common,
      cluster: merge ? clusterOf.get(m.a) : '',
      under_merge: merge ? 'да' : '',
      shared_urls: (m.sharedUrls || []).join(' | '),
    });
  }
  rows.sort((x, y) => y.common_urls - x.common_urls);
  return rows;
}

const EXPORT_COLUMNS = [
  'query_a', 'url_a', 'query_b', 'url_b', 'common_urls', 'cluster', 'under_merge', 'shared_urls',
];

async function exportCsv(req, res) {
  try {
    const t = await _loadTask(Number(req.params.id), req.user.id);
    const rows = _matrixRows(t.result);
    const csv = csvExp.buildCsv(rows, { headers: EXPORT_COLUMNS });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="cannibalization-${t.id}.csv"`);
    res.send(csv);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
}

async function exportXlsx(req, res) {
  try {
    const t = await _loadTask(Number(req.params.id), req.user.id);
    const rows = _matrixRows(t.result);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="cannibalization-${t.id}.xlsx"`);
    await xlsxExp.streamXlsx(rows, { headers: EXPORT_COLUMNS, sheet: 'cannibalization' }, res);
  } catch (e) {
    if (!res.headersSent) res.status(e.status || 500).json({ error: e.message });
  }
}

async function cancelTask(req, res) {
  try {
    const t = await _loadTask(Number(req.params.id), req.user.id);
    if (['done', 'error', 'cancelled'].includes(t.status)) {
      return res.json({ id: t.id, status: t.status });
    }
    await db.query(
      `UPDATE cannibalization_tasks
          SET status='cancelled', finished_at=COALESCE(finished_at, NOW())
        WHERE id=$1`, [t.id],
    );
    res.json({ id: t.id, status: 'cancelled' });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
}

async function deleteTask(req, res) {
  try {
    const t = await _loadTask(Number(req.params.id), req.user.id);
    await db.query(`DELETE FROM cannibalization_tasks WHERE id=$1`, [t.id]);
    res.json({ id: t.id, deleted: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
}

module.exports = {
  createTask, listTasks, getTask, getResult,
  exportCsv, exportXlsx, cancelTask, deleteTask,
  _matrixRows, _sanitizeOptions, EXPORT_COLUMNS,
};
