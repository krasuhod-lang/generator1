'use strict';

/**
 * Controller для генератора тем статей (foresight forecaster).
 *
 *   GET    /api/article-topics          — список задач пользователя
 *   POST   /api/article-topics          — создать main-задачу (Промт 1)
 *   POST   /api/article-topics/deep-dive — создать deep-dive (Промт 2)
 *   GET    /api/article-topics/:id      — детальная задача (с result_markdown)
 *   DELETE /api/article-topics/:id      — удалить задачу
 */

const db = require('../config/db');
const { processArticleTopicTask } = require('../services/articleTopics/articleTopicsPipeline');

// Лимиты длины — чтобы не дать раздуть промпт неосторожным копипастом
// и не зацепить лимит входа Gemini-адаптера.
const LIMITS = {
  niche:            300,
  region:           150,
  horizon:          120,
  audience:         120,
  market_stage:     120,
  search_ecosystem: 60,
  top_competitors:  1000,
  trend_name:       300,
};

const ALLOWED_AUDIENCE     = ['B2B', 'B2C', 'смешанная'];
const ALLOWED_MARKET_STAGE = ['зарождающийся', 'растущий', 'зрелый', 'стагнирующий'];
const ALLOWED_ECOSYSTEM    = ['Google', 'Яндекс', 'оба'];

function clipStr(v, max) {
  if (v == null) return '';
  return String(v).slice(0, max).trim();
}

function pickEnum(value, allowed) {
  if (!value) return '';
  const s = String(value).trim();
  // Строгая валидация: при невалидном enum-значении возвращаем пустую строку.
  // Промпт-шаблон сам подставит «(не указано)», а БД сохранит пустое поле —
  // вместо записи произвольного 120-символьного мусора, который мог бы
  // дезориентировать LLM или попасть в логи.
  return allowed.includes(s) ? s : '';
}

// ─── GET /api/article-topics ───────────────────────────────────────
async function listArticleTopicTasks(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, mode, parent_task_id, niche, region, horizon, audience,
              market_stage, search_ecosystem, top_competitors, trend_name,
              status, error_message, llm_model,
              gemini_tokens_in, gemini_tokens_out, cost_usd,
              created_at, started_at, completed_at
         FROM article_topic_tasks
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

// ─── POST /api/article-topics ──────────────────────────────────────
async function createArticleTopicTask(req, res, next) {
  try {
    const body = req.body || {};
    const niche = clipStr(body.niche, LIMITS.niche);
    if (niche.length < 3) {
      return res.status(400).json({ error: 'Поле «Ниша / тема» обязательно (от 3 символов)' });
    }
    const region           = clipStr(body.region,           LIMITS.region);
    const horizon          = clipStr(body.horizon,          LIMITS.horizon);
    const audience         = pickEnum(body.audience,         ALLOWED_AUDIENCE);
    const market_stage     = pickEnum(body.market_stage,     ALLOWED_MARKET_STAGE);
    const search_ecosystem = pickEnum(body.search_ecosystem, ALLOWED_ECOSYSTEM);
    const top_competitors  = clipStr(body.top_competitors,  LIMITS.top_competitors);

    const { rows } = await db.query(
      `INSERT INTO article_topic_tasks
         (user_id, mode, niche, region, horizon, audience, market_stage,
          search_ecosystem, top_competitors, status)
       VALUES ($1, 'main', $2, $3, $4, $5, $6, $7, $8, 'queued')
       RETURNING id, mode, niche, status, created_at`,
      [req.user.id, niche, region, horizon, audience, market_stage,
       search_ecosystem, top_competitors],
    );
    const task = rows[0];

    setImmediate(() => {
      processArticleTopicTask(task.id).catch((err) => {
        console.error('[articleTopics] background task failed:', err.message);
      });
    });

    return res.status(201).json({ task });
  } catch (err) {
    return next(err);
  }
}

// ─── POST /api/article-topics/deep-dive ────────────────────────────
async function createArticleTopicDeepDive(req, res, next) {
  try {
    const body = req.body || {};
    const parent_task_id = String(body.parent_task_id || '').trim();
    const trend_name     = clipStr(body.trend_name, LIMITS.trend_name);

    if (!parent_task_id) {
      return res.status(400).json({ error: 'parent_task_id обязателен' });
    }
    if (trend_name.length < 3) {
      return res.status(400).json({ error: 'Название тренда обязательно (от 3 символов)' });
    }

    // Проверяем владение родительской задачей и забираем её параметры,
    // чтобы новый deep-dive унаследовал нишу/регион/горизонт.
    const { rows: parentRows } = await db.query(
      `SELECT id, niche, region, horizon, audience, market_stage,
              search_ecosystem, top_competitors, status
         FROM article_topic_tasks
        WHERE id = $1 AND user_id = $2 AND mode = 'main'`,
      [parent_task_id, req.user.id],
    );
    if (!parentRows.length) {
      return res.status(404).json({ error: 'Родительская задача не найдена' });
    }
    const parent = parentRows[0];
    if (parent.status !== 'done') {
      return res.status(409).json({ error: 'Родительская задача ещё не завершена' });
    }

    const { rows } = await db.query(
      `INSERT INTO article_topic_tasks
         (user_id, mode, parent_task_id, niche, region, horizon, audience,
          market_stage, search_ecosystem, top_competitors, trend_name, status)
       VALUES ($1, 'deep_dive', $2, $3, $4, $5, $6, $7, $8, $9, $10, 'queued')
       RETURNING id, mode, parent_task_id, niche, trend_name, status, created_at`,
      [req.user.id, parent.id, parent.niche, parent.region, parent.horizon,
       parent.audience, parent.market_stage, parent.search_ecosystem,
       parent.top_competitors, trend_name],
    );
    const task = rows[0];

    setImmediate(() => {
      processArticleTopicTask(task.id).catch((err) => {
        console.error('[articleTopics] deep-dive failed:', err.message);
      });
    });

    return res.status(201).json({ task });
  } catch (err) {
    return next(err);
  }
}

// ─── GET /api/article-topics/:id ───────────────────────────────────
async function getArticleTopicTask(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM article_topic_tasks WHERE id = $1 AND user_id = $2`,
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

// ─── DELETE /api/article-topics/:id ────────────────────────────────
async function deleteArticleTopicTask(req, res, next) {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM article_topic_tasks WHERE id = $1 AND user_id = $2`,
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

module.exports = {
  listArticleTopicTasks,
  createArticleTopicTask,
  createArticleTopicDeepDive,
  getArticleTopicTask,
  deleteArticleTopicTask,
};
