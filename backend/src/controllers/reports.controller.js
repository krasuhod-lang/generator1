'use strict';

/**
 * Controller модуля «Smart Report Builder» (отчёты по проектам).
 *
 *   CRUD черновиков:
 *     POST   /api/reports/drafts
 *     GET    /api/reports/drafts
 *     GET    /api/reports/drafts/:id
 *     PUT    /api/reports/drafts/:id
 *     DELETE /api/reports/drafts/:id
 *
 *   Данные / AI:
 *     GET    /api/reports/drafts/:id/data
 *     POST   /api/reports/drafts/:id/generate-summary
 *     GET    /api/reports/drafts/:id/generate-summary/status
 *     PUT    /api/reports/drafts/:id/tasks-blocks
 *
 *   Публикация:
 *     POST   /api/reports/drafts/:id/publish
 *     GET    /api/reports/shared
 *     PUT    /api/reports/shared/:uuid/settings
 *     POST   /api/reports/shared/:uuid/revoke
 *
 *   Публичные (без auth, в reportsPublic.routes.js):
 *     GET    /api/public/report/:uuid
 *     POST   /api/public/report/:uuid/unlock
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const db = require('../config/db');
const { aggregateForDraft } = require('../services/reports/dataAggregator');
const { generateSummary } = require('../services/reports/aiAnalyst');
const tasksLog = require('../services/reports/tasksAutoLog');
const { buildReportDocx } = require('../services/reports/docxExporter');

const PIN_TOKEN_TTL_S = 6 * 60 * 60; // 6 часов на сессию просмотра отчёта

function _bad(res, code, msg) { return res.status(code).json({ error: msg }); }

// ─── Вспомогательные ──────────────────────────────────────────────────────

async function _ownedDraft(id, userId) {
  const { rows } = await db.query(
    `SELECT d.*, p.name AS project_name, p.url AS project_url,
            p.logo_url, p.color_accent, p.keys_so_domain
       FROM report_drafts d
       JOIN projects p ON p.id = d.project_id
      WHERE d.id = $1 AND d.user_id = $2`,
    [id, userId],
  );
  return rows[0] || null;
}

function _serializeDraft(row) {
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    project_name: row.project_name,
    project_url: row.project_url,
    title: row.title,
    date_from: typeof row.date_from === 'string' ? row.date_from : new Date(row.date_from).toISOString().slice(0, 10),
    date_to: typeof row.date_to === 'string' ? row.date_to : new Date(row.date_to).toISOString().slice(0, 10),
    status: row.status,
    config: row.config || {},
    tasks_blocks: row.tasks_blocks || [],
    llm_summary: row.llm_summary || null,
    llm_highlights: row.llm_highlights || null,
    llm_growth: _parseGrowth(row.llm_growth),
    llm_quick_wins: row.llm_quick_wins || [],
    llm_vulnerabilities: row.llm_vulnerabilities || [],
    llm_roadmap: row.llm_roadmap || [],
    llm_traffic_value: row.llm_traffic_value || '',
    llm_status: row.llm_status,
    llm_generated_at: row.llm_generated_at,
    llm_error: row.llm_error || null,
    logo_url: row.logo_url || null,
    color_accent: row.color_accent || null,
    keys_so_domain: row.keys_so_domain || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function _periodLabel(from, to) {
  const fmt = (s) => {
    const d = new Date(s);
    return d.toLocaleDateString('ru-RU', { year: 'numeric', month: 'long' });
  };
  if (!from || !to) return '';
  return `${fmt(from)} — ${fmt(to)}`;
}

function _summaryPayloadFromDraft(row) {
  return {
    executive_summary: row.llm_summary || '',
    highlights: row.llm_highlights || [],
    growth_attribution: _parseGrowth(row.llm_growth),
    quick_wins: row.llm_quick_wins || [],
    vulnerabilities: row.llm_vulnerabilities || [],
    roadmap: row.llm_roadmap || [],
    traffic_value: row.llm_traffic_value || '',
  };
}

/**
 * llm_growth хранится в TEXT-колонке. Новый формат — JSON-строка массива
 * объектов {metric, attribution, conclusion, forecast, weak_zones}; старые
 * черновики могут содержать обычный текст. Возвращаем стабильную форму:
 *   - массив объектов, если удалось распарсить;
 *   - либо строку как есть, если это легаси-формат (UI умеет показать оба).
 */
function _parseGrowth(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object') return raw;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.startsWith('[') || s.startsWith('{')) {
    try {
      const parsed = JSON.parse(s);
      return parsed;
    } catch (_) { /* fallthrough: legacy plain-text */ }
  }
  return s;
}

// ─── CRUD черновиков ──────────────────────────────────────────────────────

async function listDrafts(req, res) {
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const { rows } = await db.query(
    `SELECT d.id, d.project_id, p.name AS project_name, p.url AS project_url,
            d.title, d.date_from, d.date_to, d.status,
            d.llm_status, d.llm_generated_at, d.created_at, d.updated_at
       FROM report_drafts d
       JOIN projects p ON p.id = d.project_id
      WHERE d.user_id = $1
      ORDER BY d.created_at DESC
      LIMIT $2 OFFSET $3`,
    [req.user.id, limit, offset],
  );
  res.json({ drafts: rows });
}

async function createDraft(req, res) {
  const { project_id, title, date_from, date_to, config, tasks_blocks } = req.body || {};
  if (!project_id) return _bad(res, 400, 'project_id обязателен');
  if (!title) return _bad(res, 400, 'title обязателен');
  if (!date_from || !date_to) return _bad(res, 400, 'date_from/date_to обязательны');

  const { rows: pRows } = await db.query(
    `SELECT id FROM projects WHERE id = $1 AND user_id = $2`,
    [project_id, req.user.id],
  );
  if (!pRows.length) return _bad(res, 404, 'Проект не найден');

  const { rows } = await db.query(
    `INSERT INTO report_drafts
       (project_id, user_id, title, date_from, date_to, config, tasks_blocks)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      project_id,
      req.user.id,
      String(title).slice(0, 500),
      date_from,
      date_to,
      JSON.stringify(config || {}),
      JSON.stringify(tasks_blocks || []),
    ],
  );
  const draft = await _ownedDraft(rows[0].id, req.user.id);
  res.status(201).json({ draft: _serializeDraft(draft) });
}

async function getDraft(req, res) {
  const draft = await _ownedDraft(req.params.id, req.user.id);
  if (!draft) return _bad(res, 404, 'Черновик не найден');
  res.json({ draft: _serializeDraft(draft) });
}

async function updateDraft(req, res) {
  const draft = await _ownedDraft(req.params.id, req.user.id);
  if (!draft) return _bad(res, 404, 'Черновик не найден');

  const allowed = ['title', 'date_from', 'date_to', 'config', 'tasks_blocks', 'status'];
  const sets = [];
  const vals = [req.params.id, req.user.id];
  let i = 3;
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body, k)) {
      let v = req.body[k];
      if (k === 'config' || k === 'tasks_blocks') v = JSON.stringify(v || (k === 'config' ? {} : []));
      if (k === 'status' && !['draft', 'published', 'archived'].includes(v)) {
        return _bad(res, 400, 'invalid status');
      }
      sets.push(`${k} = $${i++}`);
      vals.push(v);
    }
  }
  if (!sets.length) return _bad(res, 400, 'Нет полей для обновления');

  await db.query(
    `UPDATE report_drafts SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $1 AND user_id = $2`,
    vals,
  );
  const updated = await _ownedDraft(req.params.id, req.user.id);
  res.json({ draft: _serializeDraft(updated) });
}

async function deleteDraft(req, res) {
  const { rowCount } = await db.query(
    `DELETE FROM report_drafts WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.id],
  );
  if (!rowCount) return _bad(res, 404, 'Черновик не найден');
  res.json({ ok: true });
}

async function updateTasksBlocks(req, res) {
  const draft = await _ownedDraft(req.params.id, req.user.id);
  if (!draft) return _bad(res, 404, 'Черновик не найден');
  const blocks = Array.isArray(req.body?.blocks) ? req.body.blocks : null;
  if (!blocks) return _bad(res, 400, 'blocks должен быть массивом');
  await db.query(
    `UPDATE report_drafts SET tasks_blocks = $3, updated_at = NOW()
      WHERE id = $1 AND user_id = $2`,
    [draft.id, req.user.id, JSON.stringify(blocks)],
  );
  res.json({ ok: true, blocks });
}

// ─── Данные ───────────────────────────────────────────────────────────────

async function getDraftData(req, res) {
  const draft = await _ownedDraft(req.params.id, req.user.id);
  if (!draft) return _bad(res, 404, 'Черновик не найден');
  try {
    const data = await aggregateForDraft(draft, {
      from: req.query.from,
      to: req.query.to,
      granularity: req.query.granularity,
    });
    res.json({ data });
  } catch (err) {
    console.error('[reports] aggregate failed:', err.message);
    return _bad(res, 500, err.message || 'aggregate_failed');
  }
}

async function listProjectTasks(req, res) {
  const draft = await _ownedDraft(req.params.id, req.user.id);
  if (!draft) return _bad(res, 404, 'Черновик не найден');
  const includeHidden = String(req.query.include_hidden || '') === 'true';
  const items = await tasksLog.listForPeriod(draft.project_id, draft.date_from, draft.date_to, { includeHidden });
  res.json({ items });
}

// ─── AI Summary (фоновая задача) ──────────────────────────────────────────

async function generateSummaryEndpoint(req, res) {
  const draft = await _ownedDraft(req.params.id, req.user.id);
  if (!draft) return _bad(res, 404, 'Черновик не найден');

  const jobId = crypto.randomUUID();
  await db.query(
    `UPDATE report_drafts
        SET llm_status = 'queued', llm_job_id = $3, llm_error = NULL, updated_at = NOW()
      WHERE id = $1 AND user_id = $2`,
    [draft.id, req.user.id, jobId],
  );

  // Запуск без ожидания: возвращаем 202 с jobId, фронт опрашивает status.
  setImmediate(() => _runSummaryJob(draft.id, req.user.id, jobId).catch((err) => {
    console.error('[reports] summary job crashed:', err.message);
  }));

  res.status(202).json({ job_id: jobId, status: 'queued' });
}

async function _runSummaryJob(draftId, userId, jobId) {
  await db.query(
    `UPDATE report_drafts SET llm_status = 'running', updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND llm_job_id = $3`,
    [draftId, userId, jobId],
  );
  try {
    const draft = await _ownedDraft(draftId, userId);
    if (!draft) return;
    const data = await aggregateForDraft(draft, {
      from: req.query?.from,
      to: req.query?.to,
      granularity: req.query?.granularity,
    });
    const summary = await generateSummary(data, {
      brandName: draft.project_name,
      period: _periodLabel(draft.date_from, draft.date_to),
    });
    await db.query(
      `UPDATE report_drafts
          SET llm_status = 'done',
              llm_summary = $3,
              llm_highlights = $4,
              llm_growth = $5,
              llm_quick_wins = $6,
              llm_vulnerabilities = $7,
              llm_roadmap = $8,
              llm_traffic_value = $9,
              llm_generated_at = NOW(),
              llm_error = NULL,
              updated_at = NOW()
        WHERE id = $1 AND user_id = $2 AND llm_job_id = $10`,
      [
        draftId,
        userId,
        summary.executive_summary || '',
        JSON.stringify(summary.highlights || []),
        JSON.stringify(summary.growth_attribution || []),
        JSON.stringify(summary.quick_wins || []),
        JSON.stringify(summary.vulnerabilities || []),
        JSON.stringify(summary.roadmap || []),
        summary.traffic_value || '',
        jobId,
      ],
    );
  } catch (err) {
    await db.query(
      `UPDATE report_drafts
          SET llm_status = 'error',
              llm_error = $3,
              updated_at = NOW()
        WHERE id = $1 AND user_id = $2 AND llm_job_id = $4`,
      [draftId, userId, String(err.message || err).slice(0, 1000), jobId],
    );
  }
}

async function getSummaryStatus(req, res) {
  const draft = await _ownedDraft(req.params.id, req.user.id);
  if (!draft) return _bad(res, 404, 'Черновик не найден');
  res.json({
    job_id: draft.llm_job_id,
    status: draft.llm_status,
    error: draft.llm_error || null,
    summary: draft.llm_summary || null,
    highlights: draft.llm_highlights || null,
    growth_attribution: _parseGrowth(draft.llm_growth),
    quick_wins: draft.llm_quick_wins || [],
    vulnerabilities: draft.llm_vulnerabilities || [],
    roadmap: draft.llm_roadmap || [],
    traffic_value: draft.llm_traffic_value || '',
    generated_at: draft.llm_generated_at,
  });
}

// ─── Публикация ───────────────────────────────────────────────────────────

async function publishDraft(req, res) {
  const draft = await _ownedDraft(req.params.id, req.user.id);
  if (!draft) return _bad(res, 404, 'Черновик не найден');

  const mode = ['snapshot', 'live'].includes(req.body?.mode) ? req.body.mode : 'live';
  const password = req.body?.password ? String(req.body.password) : null;
  if (password && (password.length < 4 || password.length > 8 || !/^\d+$/.test(password))) {
    return _bad(res, 400, 'PIN должен быть из 4–8 цифр');
  }
  const expiresInDays = Number(req.body?.expires_in_days) > 0
    ? Math.min(365, Math.round(Number(req.body.expires_in_days)))
    : null;

  const passwordHash = password ? await bcrypt.hash(password, 10) : null;
  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 86400_000)
    : null;
  const uuid = crypto.randomUUID();

  let snapshotData = null;
  if (mode === 'snapshot') {
    try {
      const data = await aggregateForDraft(draft);
      snapshotData = JSON.stringify({
        data,
        summary: _summaryPayloadFromDraft(draft),
        tasks_blocks: draft.tasks_blocks,
        config: draft.config,
        title: draft.title,
        period: _periodLabel(draft.date_from, draft.date_to),
        captured_at: new Date().toISOString(),
      });
    } catch (err) {
      return _bad(res, 500, `Не удалось подготовить snapshot: ${err.message}`);
    }
  }

  const { rows } = await db.query(
    `INSERT INTO shared_reports
       (draft_id, user_id, uuid, mode, snapshot_data, expires_at, password_hash)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     RETURNING id, uuid, mode, expires_at, is_active, created_at`,
    [draft.id, req.user.id, uuid, mode, snapshotData, expiresAt, passwordHash],
  );

  await db.query(
    `UPDATE report_drafts SET status = 'published', updated_at = NOW() WHERE id = $1`,
    [draft.id],
  );

  const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.status(201).json({
    shared: rows[0],
    public_url: `${baseUrl}/r/${uuid}`,
  });
}

async function listShared(req, res) {
  const { rows } = await db.query(
    `SELECT s.id, s.uuid, s.mode, s.expires_at, s.is_active,
            s.view_count, s.last_viewed_at, s.created_at,
            (s.password_hash IS NOT NULL) AS has_password,
            d.id AS draft_id, d.title AS draft_title,
            d.date_from, d.date_to,
            p.id AS project_id, p.name AS project_name
       FROM shared_reports s
       JOIN report_drafts d ON d.id = s.draft_id
       JOIN projects p ON p.id = d.project_id
      WHERE s.user_id = $1
      ORDER BY s.created_at DESC
      LIMIT 200`,
    [req.user.id],
  );
  res.json({ shared: rows });
}

async function updateSharedSettings(req, res) {
  const { uuid } = req.params;
  const { rows } = await db.query(
    `SELECT * FROM shared_reports WHERE uuid = $1 AND user_id = $2`,
    [uuid, req.user.id],
  );
  const sr = rows[0];
  if (!sr) return _bad(res, 404, 'Ссылка не найдена');

  const sets = ['updated_at = NOW()'];
  const vals = [sr.id];
  let i = 2;

  if (Object.prototype.hasOwnProperty.call(req.body, 'expires_in_days')) {
    const days = Number(req.body.expires_in_days);
    if (req.body.expires_in_days === null || days === 0) {
      sets.push('expires_at = NULL');
    } else if (days > 0) {
      sets.push(`expires_at = $${i++}`);
      vals.push(new Date(Date.now() + Math.min(365, days) * 86400_000));
    }
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'password')) {
    if (!req.body.password) {
      sets.push('password_hash = NULL');
    } else {
      const pw = String(req.body.password);
      if (pw.length < 4 || pw.length > 8 || !/^\d+$/.test(pw)) {
        return _bad(res, 400, 'PIN должен быть из 4–8 цифр');
      }
      sets.push(`password_hash = $${i++}`);
      vals.push(await bcrypt.hash(pw, 10));
    }
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'mode')) {
    if (!['snapshot', 'live'].includes(req.body.mode)) return _bad(res, 400, 'invalid mode');
    sets.push(`mode = $${i++}`);
    vals.push(req.body.mode);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'is_active')) {
    sets.push(`is_active = $${i++}`);
    vals.push(!!req.body.is_active);
  }

  await db.query(`UPDATE shared_reports SET ${sets.join(', ')} WHERE id = $1`, vals);
  res.json({ ok: true });
}

async function revokeShared(req, res) {
  const { rowCount } = await db.query(
    `UPDATE shared_reports SET is_active = FALSE, updated_at = NOW()
      WHERE uuid = $1 AND user_id = $2`,
    [req.params.uuid, req.user.id],
  );
  if (!rowCount) return _bad(res, 404, 'Ссылка не найдена');
  res.json({ ok: true });
}

// ─── Публичные эндпоинты ──────────────────────────────────────────────────

const _PIN_AUDIENCE = 'reports-public-pin';

function _pinSecret() {
  return process.env.PROJECTS_TOKEN_KEY || process.env.JWT_SECRET || '';
}

function _checkPinCookie(req, sharedId) {
  const cookieHeader = req.headers?.cookie || '';
  const name = `rpt_pin_${sharedId}=`;
  let token = null;
  for (const part of cookieHeader.split(';')) {
    const t = part.trim();
    if (t.startsWith(name)) {
      token = decodeURIComponent(t.slice(name.length));
      break;
    }
  }
  if (!token) return false;
  try {
    const decoded = jwt.verify(token, _pinSecret(), { audience: _PIN_AUDIENCE });
    return decoded?.sid === sharedId;
  } catch (_) { return false; }
}

function _issuePinCookie(res, sharedId) {
  const secret = _pinSecret();
  if (!secret) return;
  const token = jwt.sign({ sid: sharedId }, secret, { audience: _PIN_AUDIENCE, expiresIn: PIN_TOKEN_TTL_S });
  const parts = [
    `rpt_pin_${sharedId}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${PIN_TOKEN_TTL_S}`,
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

async function _loadShared(uuid) {
  const { rows } = await db.query(
    `SELECT s.*, d.title AS draft_title, d.tasks_blocks, d.config,
            d.llm_summary, d.llm_highlights, d.llm_growth, d.llm_quick_wins,
            d.llm_vulnerabilities, d.llm_roadmap, d.llm_traffic_value,
            d.date_from, d.date_to,
            d.user_id AS owner_id,
            p.id AS project_id, p.name AS project_name, p.url AS project_url,
            p.logo_url, p.color_accent, p.keys_so_domain
       FROM shared_reports s
       JOIN report_drafts d ON d.id = s.draft_id
       JOIN projects p ON p.id = d.project_id
      WHERE s.uuid = $1`,
    [uuid],
  );
  return rows[0] || null;
}

function _isExpired(sr) {
  return sr.expires_at && new Date(sr.expires_at).getTime() < Date.now();
}

async function publicGet(req, res) {
  const sr = await _loadShared(req.params.uuid);
  if (!sr) return res.status(404).json({ error: 'not_found' });
  if (!sr.is_active) return res.status(410).json({ error: 'revoked' });
  if (_isExpired(sr)) return res.status(410).json({ error: 'expired' });

  if (sr.password_hash && !_checkPinCookie(req, sr.id)) {
    return res.status(403).json({ error: 'password_required' });
  }

  let payload;
  if (sr.mode === 'snapshot' && sr.snapshot_data) {
    payload = sr.snapshot_data;
  } else {
    // live: пересобрать данные.
    const draft = {
      id: sr.draft_id,
      project_id: sr.project_id,
      date_from: sr.date_from,
      date_to: sr.date_to,
    };
    const data = await aggregateForDraft(draft);
    payload = {
      data,
      summary: _summaryPayloadFromDraft(sr),
      tasks_blocks: sr.tasks_blocks || [],
      config: sr.config || {},
      title: sr.draft_title,
      period: _periodLabel(sr.date_from, sr.date_to),
      captured_at: new Date().toISOString(),
    };
  }

  async function exportDraftDocx(req, res) {
    const draft = await _ownedDraft(req.params.id, req.user.id);
    if (!draft) return _bad(res, 404, 'Черновик не найден');
    try {
      const data = await aggregateForDraft(draft, {
        from: req.body?.from,
        to: req.body?.to,
        granularity: req.body?.granularity,
      });
      const buffer = await buildReportDocx({
        title: draft.title,
        period: _periodLabel(req.body?.from || draft.date_from, req.body?.to || draft.date_to),
        project: {
          name: draft.project_name,
          url: draft.project_url,
        },
        data,
        summary: _summaryPayloadFromDraft(draft),
        tasks_blocks: data.tasks?.blocks || draft.tasks_blocks || [],
        chart_images: Array.isArray(req.body?.chart_images) ? req.body.chart_images : [],
      });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent((draft.title || 'report').slice(0, 80))}.docx"`);
      res.send(buffer);
    } catch (err) {
      return _bad(res, 500, err.message || 'docx_export_failed');
    }
  }

  // Инкремент счётчика просмотров (best-effort, не блокирует ответ).
  db.query(
    `UPDATE shared_reports SET view_count = view_count + 1, last_viewed_at = NOW()
      WHERE id = $1`,
    [sr.id],
  ).catch(() => { /* */ });

  res.json({
    uuid: sr.uuid,
    mode: sr.mode,
    title: sr.draft_title,
    period: _periodLabel(req.query?.from || sr.date_from, req.query?.to || sr.date_to),
    project: {
      name: sr.project_name,
      url: sr.project_url,
      logo_url: sr.logo_url,
      color_accent: sr.color_accent,
    },
    payload,
  });
}

async function publicUnlock(req, res) {
  const sr = await _loadShared(req.params.uuid);
  if (!sr) return res.status(404).json({ error: 'not_found' });
  if (!sr.is_active) return res.status(410).json({ error: 'revoked' });
  if (_isExpired(sr)) return res.status(410).json({ error: 'expired' });
  if (!sr.password_hash) return res.json({ ok: true, no_password: true });

  const pin = String(req.body?.pin || '');
  if (!pin) return res.status(400).json({ error: 'pin_required' });
  const ok = await bcrypt.compare(pin, sr.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid_pin' });
  _issuePinCookie(res, sr.id);
  res.json({ ok: true });
}

async function publicExportDocx(req, res) {
  const sr = await _loadShared(req.params.uuid);
  if (!sr) return res.status(404).json({ error: 'not_found' });
  if (!sr.is_active) return res.status(410).json({ error: 'revoked' });
  if (_isExpired(sr)) return res.status(410).json({ error: 'expired' });
  if (sr.password_hash && !_checkPinCookie(req, sr.id)) {
    return res.status(403).json({ error: 'password_required' });
  }
  try {
    const data = sr.mode === 'snapshot' && sr.snapshot_data
      ? sr.snapshot_data.data
      : await aggregateForDraft({
        id: sr.draft_id,
        project_id: sr.project_id,
        date_from: req.body?.from || sr.date_from,
        date_to: req.body?.to || sr.date_to,
        tasks_blocks: sr.tasks_blocks || [],
      }, {
        from: req.body?.from,
        to: req.body?.to,
        granularity: req.body?.granularity,
      });
    const summary = sr.mode === 'snapshot' && sr.snapshot_data
      ? (sr.snapshot_data.summary || {})
      : _summaryPayloadFromDraft(sr);
    const buffer = await buildReportDocx({
      title: sr.draft_title,
      period: _periodLabel(req.body?.from || sr.date_from, req.body?.to || sr.date_to),
      project: { name: sr.project_name, url: sr.project_url },
      data,
      summary,
      tasks_blocks: (sr.mode === 'snapshot' && sr.snapshot_data?.tasks_blocks) || data.tasks?.blocks || sr.tasks_blocks || [],
      chart_images: Array.isArray(req.body?.chart_images) ? req.body.chart_images : [],
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent((sr.draft_title || 'report').slice(0, 80))}.docx"`);
    res.send(buffer);
  } catch (err) {
    return _bad(res, 500, err.message || 'docx_export_failed');
  }
}

module.exports = {
  listDrafts, createDraft, getDraft, updateDraft, deleteDraft,
  updateTasksBlocks, getDraftData, listProjectTasks,
  generateSummaryEndpoint, getSummaryStatus, exportDraftDocx,
  publishDraft, listShared, updateSharedSettings, revokeShared,
  publicGet, publicUnlock, publicExportDocx,
};
