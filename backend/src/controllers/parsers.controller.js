'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../config/db');
const {
  normalizeUrls,
  createParserTask,
  updateTaskProgress,
  finalizeParserTask,
} = require('../services/parser/parserTaskService');
const { enqueueOutbox, publishPendingOutbox } = require('../services/tasks/reliability');

async function getTask(taskId) {
  const { rows } = await db.query(
    `SELECT id, user_id, status, progress, total, results, error, file_path,
            heartbeat_at, lease_until, recovery_attempts, updated_at, finished_at
       FROM parser_tasks WHERE id=$1`, [taskId]);
  return rows[0] || null;
}

async function getProgress(taskId) {
  const { rows } = await db.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status IN ('completed','partial','failed'))::int AS processed,
       COUNT(*) FILTER (WHERE status='completed')::int AS completed,
       COUNT(*) FILTER (WHERE status='partial')::int AS partial,
       COUNT(*) FILTER (WHERE status='failed')::int AS failed,
       COUNT(*) FILTER (WHERE status IN ('queued','running','retry_wait'))::int AS pending
     FROM parser_task_items WHERE task_id=$1`, [taskId]);
  return rows[0] || { total: 0, processed: 0, completed: 0, partial: 0, failed: 0, pending: 0 };
}

exports.startParsing = async (req, res) => {
  try {
    const options = (req.body && req.body.options) || {};
    const rawUrls = Array.isArray(req.body?.urls) ? req.body.urls : [];
    const validUrls = normalizeUrls(rawUrls);
    if (!validUrls.length && !options.search_query) {
      return res.status(400).json({ error: 'List of URLs or search_query is required' });
    }
    if (rawUrls.length && !validUrls.length && !options.search_query) {
      return res.status(400).json({ error: 'No valid URLs were provided' });
    }

    const taskId = uuidv4();
    const userId = req.user?.id || null;
    await createParserTask({ taskId, userId, urls: rawUrls, options });
    const total = validUrls.length || 0;
    res.status(202).json({ task_id: taskId, status: 'queued', total });
  } catch (error) {
    console.error('[parsers.startParsing]', error.stack || error.message);
    res.status(500).json({ error: error.message || 'internal_error' });
  }
};

exports.getTaskStatus = async (req, res) => {
  try {
    const task = await getTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const progress = await getProgress(task.id);
    const heartbeatAgeMs = task.heartbeat_at ? Date.now() - new Date(task.heartbeat_at).getTime() : null;
    res.json({
      id: task.id,
      status: task.status,
      progress: progress.processed,
      total: progress.total || task.total || 0,
      progress_detail: progress,
      error: task.error,
      recovery_attempts: task.recovery_attempts || 0,
      heartbeat_at: task.heartbeat_at,
      heartbeat_stale: heartbeatAgeMs != null && heartbeatAgeMs > 90000,
      updated_at: task.updated_at,
      finished_at: task.finished_at,
    });
  } catch (error) {
    console.error('[parsers.getTaskStatus]', error.message);
    res.status(500).json({ error: 'internal_error' });
  }
};

exports.cancelTask = async (req, res) => {
  try {
    const taskId = req.params.taskId;
    const { rowCount } = await db.query(
      `UPDATE parser_tasks SET status='cancelled', error='Отменено пользователем',
              finished_at=NOW(), updated_at=NOW(), heartbeat_at=NOW()
        WHERE id=$1 AND status NOT IN ('done','error','cancelled')`, [taskId]);
    await db.query(
      `UPDATE parser_task_items SET status='cancelled', lease_token=NULL, lease_until=NULL,
              heartbeat_at=NOW(), updated_at=NOW(), finished_at=NOW()
        WHERE task_id=$1 AND status IN ('queued','running','retry_wait')`, [taskId]);
    res.json({ id: taskId, status: rowCount ? 'cancelled' : 'unchanged' });
  } catch (error) {
    console.error('[parsers.cancelTask]', error.message);
    res.status(500).json({ error: 'internal_error' });
  }
};

exports.retryFailed = async (req, res) => {
  try {
    const taskId = req.params.taskId;
    const { rows } = await db.query(
      `UPDATE parser_task_items
          SET status='queued', attempts=0, error_code=NULL, error_message=NULL,
              next_attempt_at=NULL, finished_at=NULL, updated_at=NOW()
        WHERE task_id=$1 AND status='failed'
        RETURNING id`, [taskId]);
    await db.query(
      `UPDATE parser_tasks SET status='queued', error=NULL, finished_at=NULL, updated_at=NOW()
        WHERE id=$1 AND status IN ('done','error','partial','cancelled')`, [taskId]);
    for (const row of rows) {
      await enqueueOutbox({
        queueName: 'parser-scans',
        jobName: 'parse-url',
        jobId: `parser:${taskId}:${row.id}:manual:${Date.now()}`,
        payload: { taskId, itemId: row.id },
      });
    }
    await publishPendingOutbox(db, 100);
    res.json({ id: taskId, queued: rows.length });
  } catch (error) {
    console.error('[parsers.retryFailed]', error.message);
    res.status(500).json({ error: 'internal_error' });
  }
};

exports.downloadReport = async (req, res) => {
  try {
    const task = await getTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.status !== 'done' || !task.file_path) {
      // A crash during finalization should not discard already persisted items.
      const progress = await updateTaskProgress(task.id);
      if (progress.pending === 0 && progress.total > 0) {
        await finalizeParserTask(task.id);
      }
    }
    const fresh = await getTask(req.params.taskId);
    if (!fresh || fresh.status !== 'done' || !fresh.file_path) {
      return res.status(409).json({ error: 'Report not ready', status: fresh?.status || 'not_found' });
    }
    res.download(fresh.file_path, `parsers_report.xlsx`);
  } catch (error) {
    console.error('[parsers.downloadReport]', error.message);
    res.status(500).json({ error: error.message || 'internal_error' });
  }
};

module.exports = exports;
