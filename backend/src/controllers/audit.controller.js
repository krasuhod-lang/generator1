'use strict';

/**
 * controllers/audit.controller.js — REST для модуля «Аудиты» (технический и
 * SEO-аудит сайта). Node — только роутер (ТЗ п.10): краулинг и текстовый
 * анализ выполняет Python-микросервис audit/ (asyncio + aiohttp + BS4 +
 * networkx). Здесь: авторизация, SSRF-валидация URL, персист задач/отчётов
 * в PostgreSQL (audit_tasks/audit_pages/audit_issues), CSV-экспорт.
 *
 *   POST   /api/audit/start            — запустить аудит
 *   GET    /api/audit/tasks            — список аудитов пользователя
 *   GET    /api/audit/status/:id       — статус + прогресс (проксирует Python)
 *   GET    /api/audit/report/:id       — финальный отчёт (persist в PG при done)
 *   GET    /api/audit/export/:id       — экспорт (?format=csv|xlsx)
 *   GET    /api/audit/compare/:id      — сравнение с предыдущим аудитом домена
 *   DELETE /api/audit/:id              — удалить аудит
 */

const axios   = require('axios');
const ExcelJS = require('exceljs');
const db      = require('../config/db');
const { assertPublicHost } = require('../services/siteCrawler/ssrfGuard');

const BASE_URL = (process.env.AUDIT_INTERNAL_URL || 'http://audit:8002')
  .trim().replace(/\/$/, '');
const TOKEN = (process.env.RELEVANCE_INTERNAL_TOKEN || '').trim();

const MAX_CONCURRENT_TASKS = 2;

function _authHeaders() {
  return TOKEN ? { 'X-Internal-Token': TOKEN } : {};
}

async function _py(method, path, data) {
  const res = await axios({
    method, url: `${BASE_URL}${path}`, data,
    timeout: 30000,
    headers: { 'Content-Type': 'application/json', ..._authHeaders() },
    maxContentLength: 256 * 1024 * 1024,
    validateStatus: (s) => s >= 200 && s < 300,
  });
  return res.data;
}

async function _loadTask(taskId, userId) {
  const { rows } = await db.query(
    `SELECT id, user_id, url, status, config, progress, summary, report IS NOT NULL AS has_report,
            error, started_at, finished_at, created_at
       FROM audit_tasks WHERE id = $1`, [taskId],
  );
  if (!rows.length) { const e = new Error('task_not_found'); e.status = 404; throw e; }
  const t = rows[0];
  if (t.user_id !== userId) { const e = new Error('forbidden'); e.status = 403; throw e; }
  return t;
}

// ── POST /api/audit/start ────────────────────────────────────────────────────
async function startAudit(req, res) {
  try {
    const userId = req.user && req.user.id;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    let url = String((req.body && req.body.url) || '').trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    let parsed;
    try { parsed = new URL(url); } catch (_) {
      return res.status(400).json({ error: 'invalid_url' });
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: 'invalid_url' });
    }
    try { await assertPublicHost(parsed.hostname); }
    catch (_) { return res.status(400).json({ error: 'ssrf_blocked' }); }

    const config = {
      max_pages:      Math.min(Math.max(parseInt(req.body.max_pages, 10) || 500, 1), 5000),
      max_depth:      Math.min(Math.max(parseInt(req.body.max_depth, 10) || 4, 0), 10),
      use_playwright: !!req.body.use_playwright,
      check_images:   req.body.check_images !== false,
    };

    const { rows: running } = await db.query(
      `SELECT COUNT(*)::int AS n FROM audit_tasks
        WHERE user_id=$1 AND status IN ('pending','running')`, [userId],
    );
    if ((running[0] && running[0].n) >= MAX_CONCURRENT_TASKS) {
      return res.status(429).json({ error: 'too_many_running_tasks', limit: MAX_CONCURRENT_TASKS });
    }

    // Запуск в Python-микросервисе
    let py;
    try {
      py = await _py('post', '/audit/start', { url: parsed.href, ...config });
    } catch (e) {
      return res.status(502).json({ error: 'audit_service_unavailable', detail: String(e.message).slice(0, 200) });
    }

    const { rows } = await db.query(
      `INSERT INTO audit_tasks (id, user_id, url, status, config, started_at)
       VALUES ($1, $2, $3, 'running', $4::jsonb, NOW())
       RETURNING id, status, created_at`,
      [py.task_id, userId, parsed.href, JSON.stringify(config)],
    );
    res.status(201).json({ task_id: rows[0].id, status: 'running', url: parsed.href });
  } catch (e) {
    console.error('[audit.startAudit]', e.stack || e.message);
    res.status(e.status || 500).json({ error: e.message || 'internal_error' });
  }
}

// ── GET /api/audit/tasks ─────────────────────────────────────────────────────
async function listTasks(req, res) {
  try {
    const { rows } = await db.query(
      `SELECT id, url, status, config, progress, summary, error,
              started_at, finished_at, created_at
         FROM audit_tasks WHERE user_id=$1
        ORDER BY created_at DESC LIMIT 50`, [req.user.id],
    );
    res.json({ tasks: rows });
  } catch (e) {
    console.error('[audit.listTasks]', e.message);
    res.status(500).json({ error: 'internal_error' });
  }
}

// ── GET /api/audit/status/:id ────────────────────────────────────────────────
async function getStatus(req, res) {
  try {
    const task = await _loadTask(req.params.id, req.user.id);
    // Терминальные статусы отдаём из БД без похода в Python.
    if (['done', 'failed', 'cancelled'].includes(task.status)) {
      return res.json({
        status: task.status, progress: task.progress || {}, summary: task.summary || {},
        started_at: task.started_at, finished_at: task.finished_at, error: task.error,
      });
    }
    let py;
    try { py = await _py('get', `/audit/status/${encodeURIComponent(task.id)}`); }
    catch (e) {
      // Python потерял задачу (рестарт без Redis) → failed
      await db.query(
        `UPDATE audit_tasks SET status='failed', error='audit_service_lost_task', finished_at=NOW()
          WHERE id=$1 AND status IN ('pending','running')`, [task.id]);
      return res.json({ status: 'failed', error: 'audit_service_lost_task', progress: task.progress || {} });
    }
    if (py.status === 'done') {
      await _persistReport(task.id);
    } else {
      await db.query(
        `UPDATE audit_tasks SET status=$2, progress=$3::jsonb, error=$4 WHERE id=$1`,
        [task.id, py.status, JSON.stringify(py.progress || {}), py.error || null]);
    }
    const fresh = await _loadTask(task.id, req.user.id);
    res.json({
      status: fresh.status, progress: fresh.progress || {}, summary: fresh.summary || {},
      started_at: fresh.started_at, finished_at: fresh.finished_at, error: fresh.error,
    });
  } catch (e) {
    console.error('[audit.getStatus]', e.message);
    res.status(e.status || 500).json({ error: e.message || 'internal_error' });
  }
}

// Забирает финальный отчёт из Python и персистит в PG (report + pages + issues).
async function _persistReport(taskId) {
  const { rows } = await db.query(
    `SELECT status, report IS NOT NULL AS has_report FROM audit_tasks WHERE id=$1`, [taskId]);
  if (!rows.length || rows[0].has_report) return;

  const report = await axios({
    method: 'get', url: `${BASE_URL}/audit/report/${encodeURIComponent(taskId)}`,
    timeout: 120000,
    headers: _authHeaders(),
    maxContentLength: 512 * 1024 * 1024,
    validateStatus: (s) => s >= 200 && s < 300,
  }).then((r) => r.data);

  const summary = report.summary || {};
  await db.query(
    `UPDATE audit_tasks
        SET status='done', summary=$2::jsonb, report=$3::jsonb,
            progress=$4::jsonb, finished_at=NOW()
      WHERE id=$1`,
    [taskId, JSON.stringify(summary), JSON.stringify(report),
     JSON.stringify({ crawled: summary.total_pages || 0, total_found: summary.total_pages || 0 })],
  );

  // Страницы — батчами
  const pages = Array.isArray(report.pages) ? report.pages : [];
  for (let i = 0; i < pages.length; i += 200) {
    const batch = pages.slice(i, i + 200);
    const values = [];
    const params = [];
    batch.forEach((p, j) => {
      const o = j * 16;
      values.push(`($${o+1},$${o+2},$${o+3},$${o+4},$${o+5},$${o+6},$${o+7},$${o+8},$${o+9},$${o+10},$${o+11},$${o+12},$${o+13},$${o+14},$${o+15},$${o+16})`);
      const robots = ((p.indexability || {}).meta_robots || '').toLowerCase();
      params.push(
        taskId, String(p.url || '').slice(0, 4096), p.status_code, p.crawl_depth,
        p.response_time_ms, p.content_size_bytes,
        ((p.title || {}).text || '').slice(0, 2000), (p.title || {}).length_chars || null,
        ((p.meta_description || {}).text || '').slice(0, 4000),
        Array.isArray(p.h1) ? p.h1.length : null,
        p.word_count, p.text_html_ratio, p.content_hash,
        p.is_https === true,
        !(robots.includes('noindex') || (p.indexability || {}).robots_txt_blocked),
        JSON.stringify(p.issues || []),
      );
    });
    await db.query(
      `INSERT INTO audit_pages (task_id, url, status_code, crawl_depth, response_time_ms,
              content_size_bytes, title, title_length, meta_description, h1_count,
              word_count, text_html_ratio, content_hash, is_https, indexable, issues)
       VALUES ${values.join(',')}
       ON CONFLICT (task_id, url) DO NOTHING`, params);
  }

  // Ошибки — батчами
  const issues = Array.isArray(report.issues) ? report.issues : [];
  for (let i = 0; i < issues.length; i += 500) {
    const batch = issues.slice(i, i + 500);
    const values = [];
    const params = [];
    batch.forEach((it, j) => {
      const o = j * 5;
      values.push(`($${o+1},$${o+2},$${o+3},$${o+4},$${o+5})`);
      params.push(taskId, String(it.page_url || '').slice(0, 4096),
        String(it.code || '').slice(0, 50), it.severity || 'low',
        JSON.stringify(it.context || {}));
    });
    await db.query(
      `INSERT INTO audit_issues (task_id, page_url, issue_code, severity, context)
       VALUES ${values.join(',')}`, params);
  }
}

// ── GET /api/audit/report/:id ────────────────────────────────────────────────
async function getReport(req, res) {
  try {
    const task = await _loadTask(req.params.id, req.user.id);
    if (task.status !== 'done') {
      // возможно отчёт уже готов на стороне Python — синхронизируем
      try {
        const py = await _py('get', `/audit/status/${encodeURIComponent(task.id)}`);
        if (py.status === 'done') await _persistReport(task.id);
        else return res.status(409).json({ error: 'not_ready', status: py.status, progress: py.progress });
      } catch (_) {
        return res.status(409).json({ error: 'not_ready', status: task.status });
      }
    } else if (!task.has_report) {
      await _persistReport(task.id);
    }
    const { rows } = await db.query(`SELECT report FROM audit_tasks WHERE id=$1`, [task.id]);
    res.json(rows[0].report || {});
  } catch (e) {
    console.error('[audit.getReport]', e.message);
    res.status(e.status || 500).json({ error: e.message || 'internal_error' });
  }
}

// ── GET /api/audit/export/:id?format=csv|xlsx ────────────────────────────────
function _csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  // Guard от CSV-formula injection + экранирование
  const guarded = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${guarded.replace(/"/g, '""')}"`;
}

function _xlsxCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

const PAGE_COLUMNS = ['URL','Статус','Глубина','Время ответа (мс)','Размер (байт)','Title',
  'Длина title','Description','Кол-во H1','Слов','Text/HTML','Hash','HTTPS','Индексируется','Ошибки'];

function _pageRow(r) {
  return [
    r.url, r.status_code, r.crawl_depth, r.response_time_ms, r.content_size_bytes,
    r.title, r.title_length, r.meta_description, r.h1_count, r.word_count,
    r.text_html_ratio, r.content_hash, r.is_https ? 'да' : 'нет',
    r.indexable ? 'да' : 'нет',
    Array.isArray(r.issues) ? r.issues.join(', ') : '',
  ];
}

async function _exportXlsx(res, task, pageRows) {
  const wb = new ExcelJS.Workbook();

  const wsPages = wb.addWorksheet('Страницы');
  wsPages.addRow(PAGE_COLUMNS).font = { bold: true };
  for (const r of pageRows) wsPages.addRow(_pageRow(r).map(_xlsxCell));
  wsPages.columns.forEach((c, i) => { c.width = i === 0 ? 60 : 16; });

  const { rows: issueRows } = await db.query(
    `SELECT page_url, issue_code, severity, context
       FROM audit_issues WHERE task_id=$1
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                             WHEN 'medium' THEN 2 ELSE 3 END, issue_code`, [task.id]);
  const wsIssues = wb.addWorksheet('Ошибки');
  wsIssues.addRow(['URL', 'Код ошибки', 'Критичность', 'Контекст']).font = { bold: true };
  for (const it of issueRows) {
    wsIssues.addRow([it.page_url, it.issue_code, it.severity,
      JSON.stringify(it.context || {})].map(_xlsxCell));
  }
  wsIssues.columns.forEach((c, i) => { c.width = i === 0 ? 60 : 22; });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="audit-${task.id}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}

async function exportReport(req, res) {
  try {
    const task = await _loadTask(req.params.id, req.user.id);
    if (task.status !== 'done') return res.status(409).json({ error: 'not_ready' });
    const { rows } = await db.query(
      `SELECT url, status_code, crawl_depth, response_time_ms, content_size_bytes,
              title, title_length, meta_description, h1_count, word_count,
              text_html_ratio, content_hash, is_https, indexable, issues
         FROM audit_pages WHERE task_id=$1 ORDER BY crawl_depth, url`, [task.id]);

    if (String(req.query.format || 'csv').toLowerCase() === 'xlsx') {
      return await _exportXlsx(res, task, rows);
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${task.id}.csv"`);
    res.write('\uFEFF' + PAGE_COLUMNS.map(_csvCell).join(';') + '\n');
    for (const r of rows) {
      res.write(_pageRow(r).map(_csvCell).join(';') + '\n');
    }
    res.end();
  } catch (e) {
    console.error('[audit.exportReport]', e.message);
    res.status(e.status || 500).json({ error: e.message || 'internal_error' });
  }
}

// ── GET /api/audit/compare/:id ───────────────────────────────────────────────
// Режим сравнения (ТЗ 7.2): текущий аудит + предыдущий завершённый аудит того
// же домена (host) этого пользователя.
async function compareTask(req, res) {
  try {
    const task = await _loadTask(req.params.id, req.user.id);
    let host;
    try { host = new URL(task.url).hostname; } catch (_) { host = null; }

    const _pick = (r) => ({
      id: r.id, url: r.url, summary: r.summary || {},
      graph_stats: r.graph_stats || {},
      started_at: r.started_at, finished_at: r.finished_at,
    });

    const { rows: cur } = await db.query(
      `SELECT id, url, summary, report->'graph_stats' AS graph_stats,
              started_at, finished_at
         FROM audit_tasks WHERE id=$1`, [task.id]);

    let previous = null;
    if (host) {
      const { rows: prev } = await db.query(
        `SELECT id, url, summary, report->'graph_stats' AS graph_stats,
                started_at, finished_at
           FROM audit_tasks
          WHERE user_id=$1 AND id<>$2 AND status='done'
            AND lower(split_part(split_part(url, '://', 2), '/', 1)) = lower($3)
          ORDER BY finished_at DESC NULLS LAST LIMIT 1`,
        [req.user.id, task.id, host]);
      if (prev.length) previous = _pick(prev[0]);
    }
    res.json({ current: _pick(cur[0]), previous });
  } catch (e) {
    console.error('[audit.compareTask]', e.message);
    res.status(e.status || 500).json({ error: e.message || 'internal_error' });
  }
}

// ── DELETE /api/audit/:id ────────────────────────────────────────────────────
async function deleteTask(req, res) {
  try {
    const task = await _loadTask(req.params.id, req.user.id);
    try { await _py('delete', `/audit/${encodeURIComponent(task.id)}`); } catch (_) {}
    await db.query(`DELETE FROM audit_tasks WHERE id=$1`, [task.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[audit.deleteTask]', e.message);
    res.status(e.status || 500).json({ error: e.message || 'internal_error' });
  }
}

module.exports = { startAudit, listTasks, getStatus, getReport, exportReport, compareTask, deleteTask };
