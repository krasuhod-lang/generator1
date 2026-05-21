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
const { findDuplicateDeepDives } = require('../services/articleTopics/articleTopicsTrends');
const { withUserSlot } = require('../utils/perUserConcurrency');
const { normalizeGeminiCopywritingModel } = require('../services/llm/geminiModels');

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
  // topic_ideas-режим: target_url / brand_hint режутся жёстко, чтобы влезть
  // в промпт-плейсхолдеры (см. backend/src/prompts/articleTopics/topicIdeas.txt).
  target_url:       300,
  brand_hint:       300,
  topic_count_min:  1,
  topic_count_max:  parseInt(process.env.ARTICLE_TOPICS_TOPIC_IDEAS_MAX, 10) || 30,
  topic_count_default: 10,
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
              status, error_message, gemini_model, llm_model,
              gemini_tokens_in, gemini_tokens_out, cost_usd,
              trends_json, evaluator_report,
              topic_count_requested, topic_count_returned,
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
    const geminiModel      = normalizeGeminiCopywritingModel(body.gemini_model);

    const { rows } = await db.query(
      `INSERT INTO article_topic_tasks
          (user_id, mode, niche, region, horizon, audience, market_stage,
           search_ecosystem, top_competitors, gemini_model, status)
       VALUES ($1, 'main', $2, $3, $4, $5, $6, $7, $8, $9, 'queued')
       RETURNING id, mode, niche, gemini_model, status, created_at`,
      [req.user.id, niche, region, horizon, audience, market_stage,
       search_ecosystem, top_competitors, geminiModel],
    );
    const task = rows[0];

    setImmediate(() => {
      withUserSlot(req.user.id, () => processArticleTopicTask(task.id)).catch((err) => {
        console.error('[articleTopics] background task failed:', err.message);
      });
    });

    return res.status(201).json({ task });
  } catch (err) {
    return next(err);
  }
}

// ─── POST /api/article-topics/topic-ideas ──────────────────────────
// Третий режим: анализ рынка/сущностей/интентов и подбор N тем статей
// с описанием ЦА и фактов о бренде. Гейтится
// ARTICLE_TOPICS_TOPIC_IDEAS_ENABLED — default 'true' (фича безопасна,
// гейт нужен только для аварийного отключения на проде).
function _topicIdeasEnabled() {
  const v = process.env.ARTICLE_TOPICS_TOPIC_IDEAS_ENABLED;
  // Default ON: undefined / '' / 'true' / любая нестрогая строка → enabled.
  // Только явное 'false' (regardless of case) выключает фичу.
  return String(v == null ? 'true' : v).toLowerCase() !== 'false';
}

async function createArticleTopicIdeasTask(req, res, next) {
  try {
    if (!_topicIdeasEnabled()) {
      return res.status(503).json({ error: 'Режим «Подбор тем статей» временно отключён администратором' });
    }
    const body = req.body || {};
    const niche = clipStr(body.niche, LIMITS.niche);
    if (niche.length < 3) {
      return res.status(400).json({ error: 'Поле «Ниша / тема» обязательно (от 3 символов)' });
    }
    const region    = clipStr(body.region,   LIMITS.region);
    const audience  = pickEnum(body.audience, ALLOWED_AUDIENCE);
    const targetUrl = clipStr(body.target_url, LIMITS.target_url);
    const brandHint = clipStr(body.brand_hint, LIMITS.brand_hint);
    const geminiModel = normalizeGeminiCopywritingModel(body.gemini_model);

    // topic_count: integer в [LIMITS.topic_count_min .. LIMITS.topic_count_max].
    // Default — LIMITS.topic_count_default (10). Любая некорректная форма
    // (NaN, дробь, отрицательное, выше потолка, строка) — 400.
    let topicCount = body.topic_count;
    if (topicCount === undefined || topicCount === null || topicCount === '') {
      topicCount = LIMITS.topic_count_default;
    } else {
      const n = Number(topicCount);
      if (!Number.isFinite(n) || n !== Math.floor(n)) {
        return res.status(400).json({
          error: `topic_count должен быть целым числом от ${LIMITS.topic_count_min} до ${LIMITS.topic_count_max}`,
        });
      }
      if (n < LIMITS.topic_count_min || n > LIMITS.topic_count_max) {
        return res.status(400).json({
          error: `topic_count вне диапазона ${LIMITS.topic_count_min}..${LIMITS.topic_count_max}`,
        });
      }
      topicCount = n;
    }

    // target_url валидируем мягко: если задан — должен начинаться с http(s)://
    // Пустая строка — ОК (это опциональное поле).
    if (targetUrl && !/^https?:\/\//i.test(targetUrl)) {
      return res.status(400).json({ error: 'target_url должен начинаться с http:// или https://' });
    }

    // Inputs (target_url, brand_hint, topic_count) сохраняем в module_context_used
    // на момент INSERT — pipeline прочитает их оттуда. Это позволяет не плодить
    // отдельные колонки в article_topic_tasks под опциональные topic_ideas-поля.
    const initialContext = {
      topic_ideas_inputs: {
        target_url:  targetUrl,
        brand_hint:  brandHint,
        topic_count: topicCount,
      },
    };

    const { rows } = await db.query(
      `INSERT INTO article_topic_tasks
          (user_id, mode, niche, region, audience,
           status, topic_count_requested, module_context_used, gemini_model)
       VALUES ($1, 'topic_ideas', $2, $3, $4, 'queued', $5, $6::jsonb, $7)
       RETURNING id, mode, niche, status, topic_count_requested, gemini_model, created_at`,
      [req.user.id, niche, region, audience, topicCount, JSON.stringify(initialContext), geminiModel],
    );
    const task = rows[0];

    setImmediate(() => {
      withUserSlot(req.user.id, () => processArticleTopicTask(task.id)).catch((err) => {
        console.error('[articleTopics] topic-ideas background failed:', err.message);
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
              search_ecosystem, top_competitors, status, gemini_model
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

    // Дедуп-проверка: если у пользователя уже есть deep-dive с тем же
    // нормализованным именем тренда — возвращаем 409 со списком найденных
    // задач, чтобы UI мог показать предупреждение и предложить открыть
    // существующий результат (или явно подтвердить пересоздание через
    // ?force=1). Дублирование не блокируется жёстко — это soft-warning.
    if (!body.force) {
      const duplicates = await findDuplicateDeepDives({
        userId:    req.user.id,
        trendName: trend_name,
        limit:     3,
      });
      if (duplicates.length) {
        return res.status(409).json({
          error:      'duplicate_deep_dive',
          message:    'У вас уже есть deep-dive с таким же названием тренда',
          duplicates,
          hint:       'Передайте force=true в теле запроса, чтобы создать новый прогон поверх существующего',
        });
      }
    }

    const { rows } = await db.query(
      `INSERT INTO article_topic_tasks
          (user_id, mode, parent_task_id, niche, region, horizon, audience,
           market_stage, search_ecosystem, top_competitors, trend_name, gemini_model, status)
       VALUES ($1, 'deep_dive', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'queued')
       RETURNING id, mode, parent_task_id, niche, trend_name, gemini_model, status, created_at`,
      [req.user.id, parent.id, parent.niche, parent.region, parent.horizon,
       parent.audience, parent.market_stage, parent.search_ecosystem,
       parent.top_competitors, trend_name, normalizeGeminiCopywritingModel(parent.gemini_model)],
    );
    const task = rows[0];

    setImmediate(() => {
      withUserSlot(req.user.id, () => processArticleTopicTask(task.id)).catch((err) => {
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
  createArticleTopicIdeasTask,
  createArticleTopicDeepDive,
  getArticleTopicTask,
  deleteArticleTopicTask,
  // экспортируем LIMITS и _topicIdeasEnabled для тестов
  _testing: { LIMITS, _topicIdeasEnabled },
};
