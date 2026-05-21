'use strict';

/**
 * Controller для генератора информационной статьи в блог.
 * REST endpoints:
 *   GET    /api/info-article               — список задач пользователя
 *   POST   /api/info-article               — создать задачу (fire-and-forget)
 *   GET    /api/info-article/:id           — детальная задача
 *   GET    /api/info-article/:id/stream    — SSE прогресс
 *   DELETE /api/info-article/:id           — удалить задачу
 *
 * Вход для POST:
 *   {
 *     topic: string                       // ≥ 5, ≤ 250
 *     region: string                      // ≤ 200
 *     brand_name?: string                 // ≤ 200
 *     author_name?: string                // ≤ 200
 *     brand_facts?: string                // ≤ 4000
 *     output_format?: 'html' | 'formatted_text'
 *     commercial_links: [{ url, h1 }]     // от 1 до INFO_ARTICLE_MAX_COMMERCIAL_LINKS,
 *                                         // парсится excelParser.normalizeCommercialLinks
 *     commercial_links_filename?: string  // имя исходного файла (для UI)
 *   }
 */

const db = require('../config/db');
const { processInfoArticleTask } = require('../services/infoArticle/infoArticlePipeline');
const { withUserSlot } = require('../utils/perUserConcurrency');
const { normalizeCommercialLinks, MAX_COMMERCIAL_LINKS } =
  require('../services/infoArticle/excelParser');
const sse = require('../services/sse/sseManager');
const { normalizeGeminiCopywritingModel } = require('../services/llm/geminiModels');

const MAX_TOPIC_LEN  = 250;
const MIN_TOPIC_LEN  = 5;
const MAX_REGION_LEN = 200;
const MAX_BRAND_LEN  = 200;
const MAX_FACTS_LEN  = 4000;
const MAX_FILENAME_LEN = 250;
const ALLOWED_FORMATS = ['html', 'formatted_text'];
// Бизнес-требование: «по изображениям, надо чтобы мы сами указали количество
// создания изображений. Делается только для статьи в блог». Pipeline сейчас
// поддерживает 1..6 (см. CHECK constraint миграции 022 + Stage 4 / embedImages).
const MIN_IMAGES_COUNT = 1;
const MAX_IMAGES_COUNT = 6;

// UUID v4 / любая версия.
const _UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveOwnedRelevanceReportId(rawId, userId) {
  if (!rawId || typeof rawId !== 'string') return null;
  const id = rawId.trim().toLowerCase();
  if (!_UUID_RE.test(id)) return null;
  try {
    const { rows } = await db.query(
      `SELECT id FROM relevance_reports
        WHERE id = $1 AND user_id = $2 AND status = 'done'
        LIMIT 1`,
      [id, userId],
    );
    return rows.length ? rows[0].id : null;
  } catch (_) {
    return null;
  }
}

function clipStr(v, max) {
  if (v == null) return '';
  return String(v).slice(0, max).trim();
}

function clampImagesCount(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return 1;
  if (n < MIN_IMAGES_COUNT) return MIN_IMAGES_COUNT;
  if (n > MAX_IMAGES_COUNT) return MAX_IMAGES_COUNT;
  return n;
}

// ─── GET /api/info-article ─────────────────────────────────────────
async function listInfoArticleTasks(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, topic, region, brand_name, output_format,
              commercial_links_filename, commercial_links_count,
               images_count, source_relevance_report_id,
               gemini_model,
               status, progress_pct, current_stage, error_message,
              deepseek_tokens_in, deepseek_tokens_out,
              gemini_tokens_in, gemini_tokens_out,
              gemini_image_calls, cost_usd, eeat_score,
              created_at, started_at, completed_at
         FROM info_article_tasks
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

// ─── POST /api/info-article ────────────────────────────────────────
async function createInfoArticleTask(req, res, next) {
  try {
    const body = req.body || {};
    const topic        = clipStr(body.topic,        MAX_TOPIC_LEN);
    const region       = clipStr(body.region,       MAX_REGION_LEN);
    const brandName    = clipStr(body.brand_name,   MAX_BRAND_LEN);
    const authorName   = clipStr(body.author_name,  MAX_BRAND_LEN);
    const brandFacts   = clipStr(body.brand_facts,  MAX_FACTS_LEN);
    const filename     = clipStr(body.commercial_links_filename, MAX_FILENAME_LEN);
    const outputFormat = ALLOWED_FORMATS.includes(String(body.output_format || '').toLowerCase())
      ? String(body.output_format).toLowerCase()
      : 'html';
    const geminiModel = normalizeGeminiCopywritingModel(body.gemini_model);
    // Изображения: 1..6, default 1. Для статьи в блог пользователь сам
    // указывает количество — см. бизнес-требование (D).
    const imagesCount  = clampImagesCount(body.images_count);
    // Опциональная связка с отчётом релевантности — Wave 1 competitor_signals
    // и entity_coverage уйдут в IAKB §9 / __moduleContext (см. server pipeline).
    // Невалидное / чужое / незавершённое id молча превращаем в null.
    const relevanceReportId = await resolveOwnedRelevanceReportId(
      body.source_relevance_report_id, req.user.id
    );

    if (topic.length < MIN_TOPIC_LEN) {
      return res.status(400).json({ error: `Тема статьи должна быть не короче ${MIN_TOPIC_LEN} символов` });
    }
    if (!region) {
      return res.status(400).json({ error: 'Регион обязателен' });
    }

    // Excel-база коммерческих ссылок ОПЦИОНАЛЬНА.
    // • Если пользователь загрузил файл и хотя бы одна ссылка прошла нормализацию —
    //   статья будет сгенерирована с перелинковкой через Stage 2C semantic link planner.
    // • Если файл не загружен (rawLinks=[]) — задача создаётся в режиме «без перелинковки»:
    //   pipeline пропускает Stage 5b и не вставляет коммерческих <a>-ссылок.
    // • Если файл загружен, но ВСЕ ссылки отбракованы — это уже ошибка ввода: возвращаем 400,
    //   чтобы пользователь поправил Excel, а не получил «втихую» статью без ссылок.
    const rawLinks = Array.isArray(body.commercial_links) ? body.commercial_links : [];
    let links = [];
    let dropped = 0;
    let errors  = [];
    if (rawLinks.length) {
      const norm = normalizeCommercialLinks(rawLinks, { limit: MAX_COMMERCIAL_LINKS });
      links   = norm.links;
      dropped = norm.dropped;
      errors  = norm.errors;
      if (!links.length) {
        return res.status(400).json({
          error: 'Все коммерческие ссылки отбракованы. Проверьте URL/H1 либо отправьте задачу без файла — статья будет сгенерирована без перелинковки.',
          details: errors.slice(0, 5),
        });
      }
    }

    const { rows } = await db.query(
      `INSERT INTO info_article_tasks
         (user_id, topic, region, brand_name, author_name, brand_facts, output_format,
           commercial_links, commercial_links_filename, commercial_links_count,
           images_count, source_relevance_report_id,
           gemini_model, status, progress_pct)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'queued', 0)
       RETURNING id, topic, region, brand_name, output_format,
                 commercial_links_filename, commercial_links_count,
                 images_count, source_relevance_report_id, gemini_model,
                 status, progress_pct, created_at`,
      [
        req.user.id, topic, region, brandName || null, authorName || null,
        brandFacts || null, outputFormat,
        JSON.stringify(links), filename || null, links.length,
        imagesCount, relevanceReportId, geminiModel,
      ],
    );
    const task = rows[0];

    setImmediate(() => {
      withUserSlot(req.user.id, () => processInfoArticleTask(task.id)).catch((err) => {
        console.error('[infoArticle] background task failed:', err.message);
      });
    });

    return res.status(201).json({
      task,
      normalized: { kept: links.length, dropped, errors: errors.slice(0, 5) },
    });
  } catch (err) {
    return next(err);
  }
}

// ─── GET /api/info-article/:id ─────────────────────────────────────
async function getInfoArticleTask(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM info_article_tasks WHERE id = $1 AND user_id = $2`,
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

// ─── DELETE /api/info-article/:id ──────────────────────────────────
async function deleteInfoArticleTask(req, res, next) {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM info_article_tasks WHERE id = $1 AND user_id = $2`,
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

// ─── GET /api/info-article/:id/stream ──────────────────────────────
async function streamInfoArticleTask(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, status FROM info_article_tasks WHERE id = $1 AND user_id = $2`,
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

    res.write(`data: ${JSON.stringify({ type: 'status', status: rows[0].status })}\n\n`);

    req.on('close', () => { /* sseManager removes the client */ });
    return undefined;
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  listInfoArticleTasks,
  createInfoArticleTask,
  getInfoArticleTask,
  deleteInfoArticleTask,
  streamInfoArticleTask,
};
