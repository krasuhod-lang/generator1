'use strict';

const { v4: uuidv4 } = require('uuid');
const dbDefault = require('../../config/db');
const urlN = require('../siteCrawler/urlNormalizer');

const DEFAULT_RETRY_LIMIT = 2;
const DEFAULT_STALE_MS = 2 * 60 * 1000;

function withScheme(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^(mailto|tel|javascript|vbscript|data|file):/i.test(value)) return '';
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function normalizeScanUrls(urls) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(urls) ? urls : []) {
    if (typeof raw !== 'string') continue;
    const input = raw.trim();
    if (!input) continue;
    const inputWithScheme = withScheme(input);
    if (!inputWithScheme) continue;
    const normalized = urlN.normalize(inputWithScheme);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ input_url: inputWithScheme, normalized_url: normalized });
  }
  return out;
}

function retryLimit(options = {}) {
  return Math.max(0, Math.min(5, Number(options.retry_limit ?? DEFAULT_RETRY_LIMIT) || 0));
}

async function createScan({ userId, projectId = null, urls, options = {} }, db = dbDefault) {
  const items = normalizeScanUrls(urls);
  if (!items.length) {
    const err = new Error('no_valid_urls');
    err.status = 400;
    throw err;
  }

  const taskId = uuidv4();
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO parser_scan_tasks (id, user_id, project_id, status, options, total)
       VALUES ($1, $2, $3, 'queued', $4::jsonb, $5)
       RETURNING *`,
      [taskId, userId, projectId, JSON.stringify(options || {}), items.length],
    );
    for (const item of items) {
      await client.query(
        `INSERT INTO parser_scan_items (id, task_id, input_url, normalized_url, status)
         VALUES ($1, $2, $3, $4, 'queued')
         ON CONFLICT (task_id, normalized_url) DO NOTHING`,
        [uuidv4(), taskId, item.input_url, item.normalized_url],
      );
    }
    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::int AS total FROM parser_scan_items WHERE task_id = $1`,
      [taskId],
    );
    await client.query(
      `UPDATE parser_scan_tasks SET total=$2 WHERE id=$1`,
      [taskId, countRows[0].total],
    );
    await client.query('COMMIT');
    return { ...rows[0], total: countRows[0].total };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function loadTask(taskId, userId, db = dbDefault) {
  const { rows } = await db.query(
    `SELECT * FROM parser_scan_tasks WHERE id=$1 AND user_id=$2`,
    [taskId, userId],
  );
  if (!rows.length) {
    const err = new Error('scan_not_found');
    err.status = 404;
    throw err;
  }
  return rows[0];
}

async function listScans(userId, { limit = 100 } = {}, db = dbDefault) {
  const { rows } = await db.query(
    `SELECT id, project_id, status, total, processed, succeeded, failed,
            options, error, created_at, started_at, finished_at, heartbeat_at
       FROM parser_scan_tasks
      WHERE user_id=$1
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, Math.max(1, Math.min(200, Number(limit) || 100))],
  );
  return rows;
}

async function listItems(taskId, userId, { status, limit = 100, offset = 0 } = {}, db = dbDefault) {
  await loadTask(taskId, userId, db);
  const params = [taskId];
  let where = 'task_id=$1';
  if (status) {
    params.push(status);
    where += ` AND status=$${params.length}`;
  }
  params.push(Math.max(1, Math.min(500, Number(limit) || 100)));
  const limitPos = params.length;
  params.push(Math.max(0, Number(offset) || 0));
  const offsetPos = params.length;
  const { rows } = await db.query(
    `SELECT id, task_id, input_url, normalized_url, status, attempts, result,
            field_status, evidence, stats, error_code, error_message,
            started_at, heartbeat_at, finished_at, created_at, updated_at
       FROM parser_scan_items
      WHERE ${where}
      ORDER BY created_at ASC
      LIMIT $${limitPos} OFFSET $${offsetPos}`,
    params,
  );
  return rows;
}

async function listAllItems(taskId, userId, db = dbDefault) {
  // Keep the public listItems cap at 500, but let exports fetch every item in
  // deterministic batches. This avoids a silent truncation while preserving
  // the existing pagination contract used by the UI.
  await loadTask(taskId, userId, db);
  const all = [];
  const batchSize = 500;
  let offset = 0;
  while (true) {
    const batch = await listItems(taskId, userId, {
      limit: batchSize,
      offset,
    }, db);
    all.push(...batch);
    if (batch.length < batchSize) break;
    offset += batch.length;
  }
  return all;
}

async function getItem(taskId, itemId, userId, db = dbDefault) {
  await loadTask(taskId, userId, db);
  const { rows } = await db.query(
    `SELECT * FROM parser_scan_items WHERE task_id=$1 AND id=$2`,
    [taskId, itemId],
  );
  if (!rows.length) {
    const err = new Error('item_not_found');
    err.status = 404;
    throw err;
  }
  return rows[0];
}

async function recomputeTaskCounters(taskId, db = dbDefault) {
  const { rows } = await db.query(
    `WITH s AS (
       SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status IN ('done','partial','error','cancelled'))::int AS processed,
         COUNT(*) FILTER (WHERE status IN ('done','partial'))::int AS succeeded,
         COUNT(*) FILTER (WHERE status='error')::int AS failed,
         COUNT(*) FILTER (WHERE status IN ('queued','running'))::int AS pending
       FROM parser_scan_items
       WHERE task_id=$1
     )
     UPDATE parser_scan_tasks t
        SET total=s.total,
            processed=s.processed,
            succeeded=s.succeeded,
            failed=s.failed,
            status=CASE
              WHEN t.status='cancelled' THEN 'cancelled'
              WHEN s.total > 0 AND s.pending = 0 AND s.failed > 0 AND s.succeeded > 0 THEN 'partial'
              WHEN s.total > 0 AND s.pending = 0 AND s.failed > 0 THEN 'error'
              WHEN s.total > 0 AND s.pending = 0 THEN 'done'
              WHEN s.processed > 0 THEN 'running'
              ELSE t.status
            END,
            finished_at=CASE
              WHEN t.status='cancelled' THEN COALESCE(t.finished_at, NOW())
              WHEN s.total > 0 AND s.pending = 0 THEN COALESCE(t.finished_at, NOW())
              ELSE t.finished_at
            END
       FROM s
      WHERE t.id=$1
      RETURNING t.*`,
    [taskId],
  );
  return rows[0] || null;
}

async function recoverStale({ staleMs = DEFAULT_STALE_MS } = {}, db = dbDefault) {
  const staleSeconds = Math.max(10, Math.floor(Number(staleMs) / 1000 || DEFAULT_STALE_MS / 1000));
  const { rows } = await db.query(
    `UPDATE parser_scan_items
        SET status='queued',
            next_attempt_at=NOW(),
            error_code='stale_worker',
            error_message='Worker heartbeat expired',
            updated_at=NOW()
      WHERE status='running'
        AND COALESCE(heartbeat_at, started_at, created_at) < NOW() - ($1::text || ' seconds')::interval
      RETURNING task_id`,
    [String(staleSeconds)],
  );
  const taskIds = [...new Set(rows.map((r) => r.task_id))];
  for (const taskId of taskIds) await recomputeTaskCounters(taskId, db);
  return rows.length;
}

async function claimItem({ workerId, staleMs = DEFAULT_STALE_MS } = {}, db = dbDefault) {
  await recoverStale({ staleMs }, db);
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `WITH picked AS (
         SELECT i.id
           FROM parser_scan_items i
           JOIN parser_scan_tasks t ON t.id=i.task_id
          WHERE i.status='queued'
            AND t.status IN ('queued','running')
            AND (i.next_attempt_at IS NULL OR i.next_attempt_at <= NOW())
          ORDER BY t.created_at ASC, i.created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE parser_scan_items i
          SET status='running',
              attempts=i.attempts + 1,
              started_at=COALESCE(i.started_at, NOW()),
              heartbeat_at=NOW(),
              updated_at=NOW()
         FROM picked
        WHERE i.id=picked.id
        RETURNING i.*`,
    );
    if (!rows.length) {
      await client.query('COMMIT');
      return null;
    }
    const item = rows[0];
    await client.query(
      `UPDATE parser_scan_tasks
          SET status='running',
              started_at=COALESCE(started_at, NOW()),
              heartbeat_at=NOW(),
              worker_id=$2
        WHERE id=$1`,
      [item.task_id, workerId || null],
    );
    const { rows: taskRows } = await client.query(
      `SELECT * FROM parser_scan_tasks WHERE id=$1`,
      [item.task_id],
    );
    await client.query('COMMIT');
    return { ...item, task: taskRows[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function heartbeat(itemId, workerId, db = dbDefault) {
  const { rows } = await db.query(
    `UPDATE parser_scan_items
        SET heartbeat_at=NOW(), updated_at=NOW()
      WHERE id=$1 AND status='running'
      RETURNING task_id`,
    [itemId],
  );
  if (rows[0]) {
    await db.query(
      `UPDATE parser_scan_tasks SET heartbeat_at=NOW(), worker_id=$2 WHERE id=$1`,
      [rows[0].task_id, workerId || null],
    );
  }
}

function itemStatusFromResult(result = {}) {
  if (result.status === 'partial') return 'partial';
  if (result.status === 'fetch_error' || result.status === 'llm_error' || result.status === 'blocked') return 'error';
  if (result.status === 'cancelled') return 'cancelled';
  return 'done';
}

async function completeItem(itemId, result, db = dbDefault) {
  const status = itemStatusFromResult(result);
  const { rows } = await db.query(
    `UPDATE parser_scan_items
        SET status=$2,
            result=$3::jsonb,
            field_status=$4::jsonb,
            evidence=$5::jsonb,
            stats=$6::jsonb,
            error_code=$7,
            error_message=$8,
            finished_at=NOW(),
            updated_at=NOW()
      WHERE id=$1
      RETURNING task_id`,
    [
      itemId,
      status,
      JSON.stringify(result || {}),
      JSON.stringify(result?.field_status || {}),
      JSON.stringify(result?.evidence || []),
      JSON.stringify(result?.stats || {}),
      result?.status && status === 'error' ? result.status : null,
      result?.error || null,
    ],
  );
  if (rows[0]) await recomputeTaskCounters(rows[0].task_id, db);
}

async function failItem(item, error, { options = {} } = {}, db = dbDefault) {
  const limit = retryLimit(options);
  const canRetry = item.attempts <= limit;
  const nextDelaySeconds = Math.min(300, 10 * Math.pow(2, Math.max(0, item.attempts - 1)));
  const status = canRetry ? 'queued' : 'error';
  const { rows } = await db.query(
    `UPDATE parser_scan_items
        SET status=$2,
            next_attempt_at=CASE WHEN $2='queued' THEN NOW() + ($3::text || ' seconds')::interval ELSE NULL END,
            error_code=$4,
            error_message=$5,
            finished_at=CASE WHEN $2='error' THEN NOW() ELSE finished_at END,
            updated_at=NOW()
      WHERE id=$1
      RETURNING task_id`,
    [
      item.id,
      status,
      String(nextDelaySeconds),
      error.code || 'worker_error',
      String(error.message || error).slice(0, 1000),
    ],
  );
  if (rows[0]) await recomputeTaskCounters(rows[0].task_id, db);
}

async function cancelScan(taskId, userId, db = dbDefault) {
  const task = await loadTask(taskId, userId, db);
  await db.query(
    `UPDATE parser_scan_tasks SET status='cancelled', finished_at=COALESCE(finished_at, NOW()) WHERE id=$1`,
    [task.id],
  );
  await db.query(
    `UPDATE parser_scan_items
        SET status='cancelled', finished_at=COALESCE(finished_at, NOW()), updated_at=NOW()
      WHERE task_id=$1 AND status IN ('queued','running')`,
    [task.id],
  );
  return recomputeTaskCounters(task.id, db);
}

async function retryFailedItems(taskId, userId, db = dbDefault) {
  const task = await loadTask(taskId, userId, db);
  await db.query(
    `UPDATE parser_scan_items
        SET status='queued',
            next_attempt_at=NOW(),
            error_code=NULL,
            error_message=NULL,
            finished_at=NULL,
            updated_at=NOW()
      WHERE task_id=$1 AND status='error'`,
    [task.id],
  );
  await db.query(
    `UPDATE parser_scan_tasks SET status='queued', finished_at=NULL, error=NULL WHERE id=$1 AND status <> 'cancelled'`,
    [task.id],
  );
  return recomputeTaskCounters(task.id, db);
}

module.exports = {
  normalizeScanUrls,
  retryLimit,
  createScan,
  loadTask,
  listScans,
  listItems,
  listAllItems,
  getItem,
  claimItem,
  heartbeat,
  completeItem,
  failItem,
  cancelScan,
  retryFailedItems,
  recoverStale,
  recomputeTaskCounters,
  itemStatusFromResult,
};
