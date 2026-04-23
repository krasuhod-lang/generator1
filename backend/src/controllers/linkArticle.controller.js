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

const db = require('../config/db');
const { processLinkArticleTask } = require('../services/linkArticle/linkArticlePipeline');
const sse = require('../services/sse/sseManager');

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
    const { rows } = await db.query(
      `SELECT id, topic, anchor_text, anchor_url, output_format,
              status, progress_pct, current_stage, error_message,
              deepseek_tokens_in, deepseek_tokens_out,
              gemini_tokens_in, gemini_tokens_out,
              gemini_image_calls, cost_usd,
              created_at, started_at, completed_at
         FROM link_article_tasks
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

    if (topic.length < MIN_TOPIC_LEN) {
      return res.status(400).json({ error: `Тема статьи должна быть не короче ${MIN_TOPIC_LEN} символов` });
    }
    if (!anchor_text) {
      return res.status(400).json({ error: 'Анкор ссылки обязателен' });
    }
    if (!isValidUrl(anchor_url)) {
      return res.status(400).json({ error: 'Некорректный URL анкора (ожидается http(s)://…)' });
    }

    const { rows } = await db.query(
      `INSERT INTO link_article_tasks
         (user_id, topic, anchor_text, anchor_url, focus_notes, output_format, status, progress_pct)
       VALUES ($1, $2, $3, $4, $5, $6, 'queued', 0)
       RETURNING id, topic, anchor_text, anchor_url, output_format, status, progress_pct, created_at`,
      [req.user.id, topic, anchor_text, anchor_url, focus_notes, output_format],
    );
    const task = rows[0];

    setImmediate(() => {
      processLinkArticleTask(task.id).catch((err) => {
        console.error('[linkArticle] background task failed:', err.message);
      });
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
