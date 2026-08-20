'use strict';

const crypto = require('crypto');
const exceljs = require('exceljs');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dbDefault = require('../../config/db');
const { sanitizeUrl } = require('./scraper');
const { publishPendingOutbox } = require('../tasks/reliability');
const { makeBullJobId } = require('../../queue/jobIds');

function normalizeUrls(rawUrls) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(rawUrls) ? rawUrls : []) {
    if (typeof raw !== 'string') continue;
    const normalized = sanitizeUrl(raw.trim());
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ inputUrl: raw.trim(), normalizedUrl: normalized });
  }
  return out;
}

function jobIdFor(taskId, itemId, suffix = 'initial') {
  const digest = crypto.createHash('sha1').update(`${taskId}:${itemId}:${suffix}`).digest('hex').slice(0, 32);
  return makeBullJobId('parser', taskId, digest);
}

async function createParserTask({ taskId, userId, urls, options = {} }, db = dbDefault) {
  const items = normalizeUrls(urls);
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO parser_tasks
         (id, user_id, status, progress, total, options, input_urls, heartbeat_at, updated_at)
       VALUES ($1,$2,'queued',0,$3,$4::jsonb,$5::jsonb,NOW(),NOW())`,
      [taskId, userId || null, items.length, JSON.stringify(options || {}), JSON.stringify(items.map((x) => x.normalizedUrl))],
    );

    for (const item of items) {
      const { rows } = await client.query(
        `INSERT INTO parser_task_items (task_id, input_url, normalized_url)
         VALUES ($1,$2,$3)
         ON CONFLICT (task_id, normalized_url) DO UPDATE SET updated_at=NOW()
         RETURNING id`,
        [taskId, item.inputUrl, item.normalizedUrl],
      );
      if (rows[0]) {
        const jobId = jobIdFor(taskId, rows[0].id, 'initial');
        await client.query(
          `INSERT INTO generator_task_outbox (queue_name, job_name, job_id, payload)
           VALUES ('parser-scans','parse-url',$1,$2::jsonb)
           ON CONFLICT (queue_name, job_id) DO NOTHING`,
          [jobId, JSON.stringify({ taskId, itemId: rows[0].id })],
        );
      }
    }

    if (!items.length && options.search_query) {
      const jobId = makeBullJobId('parser', taskId, 'dispatch');
      await client.query(
        `INSERT INTO generator_task_outbox (queue_name, job_name, job_id, payload)
         VALUES ('parser-scans','dispatch-search',$1,$2::jsonb)
         ON CONFLICT (queue_name, job_id) DO NOTHING`,
        [jobId, JSON.stringify({ taskId })],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }

  // The database commit is authoritative. A Redis outage only delays the
  // outbox publisher; it must not make the HTTP request fail after commit.
  publishPendingOutbox(db, 200).catch((e) => {
    console.warn('[ParserTask] outbox publish delayed:', e.message);
  });
  return { taskId, total: items.length };
}

async function insertSearchItems(taskId, urls, db = dbDefault) {
  const items = normalizeUrls(urls);
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { rows: taskRows } = await client.query(
      `SELECT options FROM parser_tasks WHERE id=$1 FOR UPDATE`, [taskId]);
    if (!taskRows.length) throw new Error('parser_task_not_found');
    for (const item of items) {
      const { rows } = await client.query(
        `INSERT INTO parser_task_items (task_id,input_url,normalized_url)
         VALUES ($1,$2,$3)
         ON CONFLICT (task_id,normalized_url) DO NOTHING
         RETURNING id`,
        [taskId, item.inputUrl, item.normalizedUrl],
      );
      if (rows[0]) {
        const jobId = jobIdFor(taskId, rows[0].id, 'search');
        await client.query(
          `INSERT INTO generator_task_outbox (queue_name,job_name,job_id,payload)
           VALUES ('parser-scans','parse-url',$1,$2::jsonb)
           ON CONFLICT (queue_name,job_id) DO NOTHING`,
          [jobId, JSON.stringify({ taskId, itemId: rows[0].id })],
        );
      }
    }
    await client.query(
      `UPDATE parser_tasks
          SET total=(SELECT COUNT(*) FROM parser_task_items WHERE task_id=$1),
              input_urls=(SELECT COALESCE(jsonb_agg(normalized_url),'[]'::jsonb) FROM parser_task_items WHERE task_id=$1),
              status='queued', updated_at=NOW(), heartbeat_at=NOW()
        WHERE id=$1`, [taskId]);
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
  await publishPendingOutbox(db, 200).catch((e) => console.warn('[ParserTask] search outbox delayed:', e.message));
  return items.length;
}

async function updateTaskProgress(taskId, db = dbDefault) {
  const { rows } = await db.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status IN ('completed','partial','failed'))::int AS processed,
       COUNT(*) FILTER (WHERE status='completed')::int AS completed,
       COUNT(*) FILTER (WHERE status='partial')::int AS partial,
       COUNT(*) FILTER (WHERE status='failed')::int AS failed,
       COUNT(*) FILTER (WHERE status IN ('queued','running','retry_wait'))::int AS pending
     FROM parser_task_items WHERE task_id=$1`, [taskId]);
  const p = rows[0] || { total: 0, processed: 0, completed: 0, partial: 0, failed: 0, pending: 0 };
  await db.query(
    `UPDATE parser_tasks SET progress=$2, total=GREATEST(total,$3), updated_at=NOW(),
            heartbeat_at=NOW(), lease_until=NOW()+INTERVAL '60 seconds'
      WHERE id=$1 AND status NOT IN ('done','error')`,
    [taskId, p.processed, p.total],
  );
  return p;
}

function reportValue(result, key, fallback = '') {
  if (!result || typeof result !== 'object') return fallback;
  const v = result[key];
  if (Array.isArray(v)) return v.join('\n');
  return v == null ? fallback : String(v);
}

async function buildExcel(taskId, rows) {
  const workbook = new exceljs.Workbook();
  const worksheet = workbook.addWorksheet('Parsers');
  worksheet.columns = [
    { header: 'URL сайта', key: 'url', width: 34 },
    { header: 'Title главной страницы', key: 'title', width: 30 },
    { header: 'Контакты', key: 'contacts', width: 30 },
    { header: 'О компании', key: 'about', width: 30 },
    { header: 'Список услуг', key: 'services', width: 36 },
    { header: 'Ключевой упор (Фокус)', key: 'focus', width: 30 },
    { header: 'Категории клиентов', key: 'client_segments', width: 42 },
    { header: 'С кем работает', key: 'works_with', width: 30 },
    { header: 'Статус сайта', key: 'item_status', width: 18 },
    { header: 'Ошибка', key: 'error', width: 36 },
  ];
  for (const row of rows) {
    const result = row.result || {};
    worksheet.addRow({
      url: row.normalized_url,
      title: reportValue(result, 'title'),
      contacts: reportValue(result, 'contacts'),
      about: reportValue(result, 'about'),
      services: reportValue(result, 'services'),
      focus: reportValue(result, 'focus'),
      client_segments: reportValue(result, 'client_segments'),
      works_with: reportValue(result, 'works_with'),
      item_status: row.status,
      error: row.error_message || result.status || '',
    });
  }
  const uploadsDir = fs.existsSync('/app/uploads') ? '/app/uploads' : path.join(os.tmpdir(), 'generator_uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const filePath = path.join(uploadsDir, `parsers_${taskId}.xlsx`);
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

async function finalizeParserTask(taskId, db = dbDefault) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`parser-finalize:${taskId}`]);
    const { rows: taskRows } = await client.query(
      `SELECT status, file_path FROM parser_tasks WHERE id=$1 FOR UPDATE`, [taskId]);
    if (!taskRows.length || taskRows[0].status === 'done') {
      await client.query('COMMIT');
      return false;
    }
    const { rows } = await client.query(
      `SELECT input_url, normalized_url, status, result, error_message
         FROM parser_task_items WHERE task_id=$1 ORDER BY created_at, id`, [taskId]);
    if (!rows.length || rows.some((r) => !['completed','partial','failed'].includes(r.status))) {
      await client.query('COMMIT');
      return false;
    }
    const results = rows.map((r) => r.result || {
      url: r.normalized_url,
      status: r.error_message || r.status,
    });
    await client.query('COMMIT');
    let filePath;
    try {
      filePath = await buildExcel(taskId, rows);
    } catch (error) {
      await db.query(
        `UPDATE parser_tasks SET status='error', last_error_code='finalize_error',
                error=$2, updated_at=NOW() WHERE id=$1`,
        [taskId, String(error.message || error).slice(0, 2000)],
      );
      throw error;
    }
    await db.query(
      `UPDATE parser_tasks
          SET status='done', progress=total, results=$2::jsonb, file_path=$3,
              finished_at=NOW(), heartbeat_at=NOW(), lease_until=NULL, updated_at=NOW()
        WHERE id=$1 AND status NOT IN ('done','error')`,
      [taskId, JSON.stringify(results), filePath],
    );
    return true;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

async function failParserTask(taskId, error, db = dbDefault) {
  await db.query(
    `UPDATE parser_tasks
        SET status='error', error=$2, last_error_code='worker_error', finished_at=NOW(), updated_at=NOW()
      WHERE id=$1 AND status NOT IN ('done','error')`,
    [taskId, String(error?.message || error || 'parser_task_failed').slice(0, 2000)],
  );
}

module.exports = {
  normalizeUrls,
  createParserTask,
  insertSearchItems,
  updateTaskProgress,
  finalizeParserTask,
  failParserTask,
};
