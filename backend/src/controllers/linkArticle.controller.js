'use strict';

/**
 * Controller для генератора ссылочной статьи.
 * REST endpoints:
 *   GET    /api/link-article               — список задач пользователя
 *   POST   /api/link-article               — создать задачу (fire-and-forget)
 *   GET    /api/link-article/:id           — детальная задача (с результатом)
 *   GET    /api/link-article/:id/stream    — SSE прогресс
 *   DELETE /api/link-article/:id           — удалить задачу
 */

const crypto = require('crypto');
const db = require('../config/db');
const { processLinkArticleTask } = require('../services/linkArticle/linkArticlePipeline');
const { scheduleUserTask } = require('../utils/perUserConcurrency');
const sse = require('../services/sse/sseManager');
const { normalizeGeminiCopywritingModel } = require('../services/llm/geminiModels');
const { resolveOwnedProjectId } = require('../services/projects/projectOwnership');
const { resolveOwnedOpportunityId } = require('../services/projects/growthOpportunities');
const { withTaskUsageReservation } = require('../services/access/entitlementPolicy');
const { cleanupTaskArtifacts } = require('../services/maintenance/artifactCleanup');

const MAX_TOPIC_LEN   = 250;
const MIN_TOPIC_LEN   = 5;
const MAX_ANCHOR_LEN  = 300;
const MAX_URL_LEN     = 1000;
const MAX_FOCUS_LEN   = 4000;
const ALLOWED_FORMATS = ['html', 'formatted_text'];

function clipStr(v, max) {
  if (v == null) return '';
  return String(v).slice(0, max).trim();
}

function isValidUrl(url) {
  if (!url || url.length > MAX_URL_LEN) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// ─── GET /api/link-article ─────────────────────────────────────────
async function listLinkArticleTasks(req, res, next) {
  try {
    const limitRaw = Number.parseInt(req.query?.limit, 10);
    const offsetRaw = Number.parseInt(req.query?.offset, 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(1000, Math.max(1, limitRaw)) : 200;
    const offset = Number.isFinite(offsetRaw) ? Math.min(100000, Math.max(0, offsetRaw)) : 0;
    const q = clipStr(req.query?.q, 200);
    const requestedStatus = clipStr(req.query?.status, 40).toLowerCase();
    const allowedStatuses = new Set(['queued', 'pending', 'running', 'processing', 'in_progress', 'partial', 'timeout', 'done', 'error', 'cancelled']);
    const where = ['user_id = $1'];
    const params = [req.user.id];
    if (q) {
      params.push(`%${q}%`);
      where.push(`(topic ILIKE $${params.length} OR COALESCE(anchor_text, '') ILIKE $${params.length} OR COALESCE(anchor_url, '') ILIKE $${params.length})`);
    }
    if (allowedStatuses.has(requestedStatus)) {
      params.push(requestedStatus);
      where.push(`status::text = $${params.length}`);
    }
    const whereSql = where.join(' AND ');
    const countResult = await db.query(
      `SELECT COUNT(*)::int AS total FROM link_article_tasks WHERE ${whereSql}`,
      params,
    );
    const listParams = [...params, limit, offset];
    const { rows } = await db.query(
      `SELECT id, topic, anchor_text, anchor_url, output_format, gemini_model,
              status, progress_pct, current_stage, error_message,
              deepseek_tokens_in, deepseek_tokens_out,
              gemini_tokens_in, gemini_tokens_out,
              gemini_image_calls, cost_usd,
              quality_gate,
              created_at, updated_at, started_at, completed_at
         FROM link_article_tasks
        WHERE ${whereSql}
        ORDER BY created_at DESC, id DESC
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams,
    );
    const total = Number(countResult.rows[0]?.total || 0);
    return res.json({ tasks: rows, meta: { total, limit, offset, hasMore: offset + rows.length < total } });
  } catch (err) {
    return next(err);
  }
}

// ─── POST /api/link-article ────────────────────────────────────────
async function createLinkArticleTask(req, res, next) {
  try {
    const body = req.body || {};
    const topic       = clipStr(body.topic,       MAX_TOPIC_LEN);
    const anchor_text = clipStr(body.anchor_text, MAX_ANCHOR_LEN);
    const anchor_url  = clipStr(body.anchor_url,  MAX_URL_LEN);
    const focus_notes = clipStr(body.focus_notes, MAX_FOCUS_LEN);
    const output_format = ALLOWED_FORMATS.includes(String(body.output_format || '').toLowerCase())
      ? String(body.output_format).toLowerCase()
      : 'html';
    const geminiModel = normalizeGeminiCopywritingModel(body.gemini_model);

    if (topic.length < MIN_TOPIC_LEN) {
      return res.status(400).json({ error: `Тема статьи должна быть не короче ${MIN_TOPIC_LEN} символов` });
    }
    if (!anchor_text) {
      return res.status(400).json({ error: 'Анкор ссылки обязателен' });
    }
    if (!isValidUrl(anchor_url)) {
      return res.status(400).json({ error: 'Некорректный URL анкора (ожидается http(s)://…)' });
    }
    // ТЗ §5: явная привязка задачи к SEO-проекту (опциональная).
    const projectId = await resolveOwnedProjectId(req.body.project_id, req.user.id);
    const opportunityId = await resolveOwnedOpportunityId(req.body.opportunity_id, projectId);
    const publishedUrl = isValidUrl(body.published_url) ? clipStr(body.published_url, MAX_URL_LEN) : null;
    const publishedQueries = Array.isArray(body.published_queries)
      ? body.published_queries.map((q) => clipStr(q, 300)).filter(Boolean).slice(0, 100)
      : [];

    const taskId = crypto.randomUUID();
    const { rows } = await withTaskUsageReservation({
      userId: req.user.id,
      taskType: 'link_article',
      taskId,
      source: 'link_article_create',
      fn: () => db.query(
        `INSERT INTO link_article_tasks
            (id, user_id, topic, anchor_text, anchor_url, focus_notes, output_format, gemini_model,
             project_id, opportunity_id, published_url, published_queries, status, progress_pct)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'queued', 0)
         RETURNING id, topic, anchor_text, anchor_url, output_format, gemini_model, project_id,
                   opportunity_id, published_url, published_queries, status, progress_pct, created_at`,
        [taskId, req.user.id, topic, anchor_text, anchor_url, focus_notes, output_format, geminiModel,
         projectId, opportunityId, publishedUrl, publishedQueries],
      ),
    });
    const task = rows[0];

    scheduleUserTask(req.user.id, 'link_article', task.id, () => processLinkArticleTask(task.id)).catch((err) => {
      console.error('[linkArticle] background task failed:', err.message);
    });

    return res.status(201).json({ task });
  } catch (err) {
    return next(err);
  }
}

// ─── GET /api/link-article/:id ─────────────────────────────────────
async function getLinkArticleTask(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM link_article_tasks WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Задача не найдена' });
    }
    return res.json({ task: rows[0] });
  } catch (err) {
    return next(err);
  }
}

// ─── DELETE /api/link-article/:id ──────────────────────────────────
async function deleteLinkArticleTask(req, res, next) {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM link_article_tasks WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Задача не найдена' });
    }
    // Чистим файлы задачи с диска (каталог картинок storage/images/<id>).
    await cleanupTaskArtifacts({ taskId: req.params.id });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
}

// ─── GET /api/link-article/:id/stream ──────────────────────────────
async function streamLinkArticleTask(req, res, next) {
  try {
    // Проверка владения — чтобы SSE не оказался открытым каналом для чужих задач
    const { rows } = await db.query(
      `SELECT id, status FROM link_article_tasks WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Задача не найдена' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    sse.subscribe(req.params.id, res);

    // Сразу шлём текущий статус — чтобы клиент не ждал первого события
    res.write(`data: ${JSON.stringify({ type: 'status', status: rows[0].status })}\n\n`);

    req.on('close', () => {
      // sseManager сам уберёт клиента при закрытии
    });
    return undefined;
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  listLinkArticleTasks,
  createLinkArticleTask,
  getLinkArticleTask,
  deleteLinkArticleTask,
  streamLinkArticleTask,
};
