'use strict';

const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const db     = require('../config/db');

// ─────────────────────────────────────────────────────────────────────────────
// Вспомогательные функции
// ─────────────────────────────────────────────────────────────────────────────

/** Создаёт JWT с ролью admin. */
function signAdminToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/login
// ─────────────────────────────────────────────────────────────────────────────

async function adminLogin(req, res, next) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email и пароль обязательны' });
    }

    const { rows } = await db.query(
      `SELECT id, email, name, password_hash, role FROM users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );
    if (!rows.length) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }
    const user = rows[0];

    if (user.role !== 'admin') {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    const token = signAdminToken({ id: user.id, email: user.email, role: 'admin' });

    return res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/users
// Список пользователей с агрегированными данными по задачам
// ─────────────────────────────────────────────────────────────────────────────

async function listUsers(req, res, next) {
  try {
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();
    const sort   = ['created_at', 'email', 'name', 'tasks_total', 'total_cost_usd'].includes(req.query.sort)
      ? req.query.sort : 'created_at';
    const order  = req.query.order === 'asc' ? 'ASC' : 'DESC';

    // Поисковый фильтр
    const whereClauses = [];
    const params = [];
    if (search) {
      params.push(`%${search}%`);
      whereClauses.push(`(u.email ILIKE $${params.length} OR u.name ILIKE $${params.length})`);
    }

    const whereSQL = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Счётчик
    const countResult = await db.query(
      `SELECT COUNT(DISTINCT u.id) AS total FROM users u ${whereSQL}`,
      params
    );
    const total = parseInt(countResult.rows[0].total);

    // Основной запрос с агрегацией
    const dataParams = [...params, limit, offset];
    const limitIdx = dataParams.length - 1;
    const offsetIdx = dataParams.length;

    const { rows } = await db.query(
      `SELECT
         u.id, u.email, u.name, u.role, u.created_at,
         COUNT(t.id)::int AS tasks_total,
         COUNT(t.id) FILTER (WHERE t.status = 'completed')::int AS tasks_completed,
         COUNT(t.id) FILTER (WHERE t.status = 'failed')::int AS tasks_failed,
         COUNT(t.id) FILTER (WHERE t.status = 'processing')::int AS tasks_processing,
         MAX(t.created_at) AS last_task_at,
         COALESCE(SUM(m.total_cost_usd), 0)::numeric(10,6) AS total_cost_usd
       FROM users u
       LEFT JOIN tasks t ON t.user_id = u.id
       LEFT JOIN task_metrics m ON m.task_id = t.id
       ${whereSQL}
       GROUP BY u.id
       ORDER BY ${sort === 'tasks_total' ? 'tasks_total' : sort === 'total_cost_usd' ? 'total_cost_usd' : `u.${sort}`} ${order}
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      dataParams
    );

    return res.json({ users: rows, total, page, limit });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/users/:userId
// Детальная информация о пользователе
// ─────────────────────────────────────────────────────────────────────────────

async function getUserDetail(req, res, next) {
  try {
    const { userId } = req.params;

    const { rows } = await db.query(
      `SELECT
         u.id, u.email, u.name, u.role, u.created_at,
         COUNT(t.id)::int AS tasks_total,
         COUNT(t.id) FILTER (WHERE t.status = 'completed')::int AS tasks_completed,
         COUNT(t.id) FILTER (WHERE t.status = 'failed')::int AS tasks_failed,
         COUNT(t.id) FILTER (WHERE t.status = 'processing')::int AS tasks_processing,
         COUNT(t.id) FILTER (WHERE t.status = 'draft')::int AS tasks_draft,
         COUNT(t.id) FILTER (WHERE t.status = 'queued')::int AS tasks_queued,
         MAX(t.created_at) AS last_task_at,
         COALESCE(SUM(m.total_cost_usd), 0)::numeric(10,6) AS total_cost_usd
       FROM users u
       LEFT JOIN tasks t ON t.user_id = u.id
       LEFT JOIN task_metrics m ON m.task_id = t.id
       WHERE u.id = $1
       GROUP BY u.id`,
      [userId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    return res.json({ user: rows[0] });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/users/:userId/tasks
// Задачи конкретного пользователя
// ─────────────────────────────────────────────────────────────────────────────

async function getUserTasks(req, res, next) {
  try {
    const { userId } = req.params;
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    // Проверяем существование пользователя
    const userCheck = await db.query(`SELECT id FROM users WHERE id = $1`, [userId]);
    if (!userCheck.rows.length) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const countResult = await db.query(
      `SELECT COUNT(*)::int AS total FROM tasks WHERE user_id = $1`,
      [userId]
    );
    const total = countResult.rows[0].total;

    const { rows } = await db.query(
      `SELECT
         t.id, t.title, t.status, t.input_target_service,
         t.created_at, t.completed_at, t.started_at,
         t.error_message,
         m.lsi_coverage, m.eeat_score, m.total_cost_usd, m.bm25_score,
         (SELECT COUNT(*)::int FROM task_content_blocks WHERE task_id = t.id) AS blocks_count
       FROM tasks t
       LEFT JOIN task_metrics m ON m.task_id = t.id
       WHERE t.user_id = $1
       ORDER BY t.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    return res.json({ tasks: rows, total, page, limit });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/stats
// Общая статистика платформы
// ─────────────────────────────────────────────────────────────────────────────

async function getStats(req, res, next) {
  try {
    const { rows } = await db.query(`
      SELECT
        (SELECT COUNT(*)::int FROM users) AS total_users,
        (SELECT COUNT(*)::int FROM users WHERE created_at >= NOW() - INTERVAL '1 day') AS users_today,
        (SELECT COUNT(*)::int FROM users WHERE created_at >= NOW() - INTERVAL '7 days') AS users_this_week,
        (SELECT COUNT(*)::int FROM users WHERE created_at >= NOW() - INTERVAL '30 days') AS users_this_month,
        (SELECT COUNT(*)::int FROM tasks) AS total_tasks,
        (SELECT COUNT(*)::int FROM tasks WHERE status = 'completed') AS tasks_completed,
        (SELECT COUNT(*)::int FROM tasks WHERE status = 'failed') AS tasks_failed,
        (SELECT COUNT(*)::int FROM tasks WHERE status = 'processing') AS tasks_processing,
        (SELECT COALESCE(SUM(total_cost_usd), 0)::numeric(10,4) FROM task_metrics) AS total_cost_usd,
        (SELECT COALESCE(AVG(lsi_coverage), 0)::numeric(5,1) FROM task_metrics WHERE lsi_coverage > 0) AS avg_lsi_coverage,
        (SELECT COALESCE(AVG(eeat_score), 0)::numeric(4,1) FROM task_metrics WHERE eeat_score > 0) AS avg_eeat_score
    `);

    return res.json({ stats: rows[0] });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: per-task detail + logs + global task list (Point 8)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/tasks?status=&user=&from=&to=&page=&perPage=
 * Глобальный список задач с фильтрами и пагинацией. Параметризовано —
 * НИКАКОЙ конкатенации SQL (см. point 9.1 — pg parameterized queries).
 */
async function listAllTasks(req, res, next) {
  try {
    const status  = (req.query.status  || '').trim();
    const userQ   = (req.query.user    || '').trim();
    const from    = (req.query.from    || '').trim();
    const to      = (req.query.to      || '').trim();
    const page    = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(200, Math.max(1, parseInt(req.query.perPage, 10) || 30));
    const offset  = (page - 1) * perPage;

    const conds = [];
    const params = [];
    if (status) {
      params.push(status);
      conds.push(`t.status = $${params.length}`);
    }
    if (userQ) {
      // user может быть UUID или подстрокой email — определяем по форме
      const isUuid = /^[0-9a-f]{8}-/i.test(userQ);
      if (isUuid) {
        params.push(userQ);
        conds.push(`t.user_id = $${params.length}`);
      } else {
        params.push(`%${userQ.toLowerCase()}%`);
        conds.push(`LOWER(u.email) LIKE $${params.length}`);
      }
    }
    if (from) {
      const d = new Date(from);
      if (!isNaN(d.getTime())) { params.push(d); conds.push(`t.created_at >= $${params.length}`); }
    }
    if (to) {
      const d = new Date(to);
      if (!isNaN(d.getTime())) { params.push(d); conds.push(`t.created_at <= $${params.length}`); }
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    params.push(perPage, offset);
    const limitIdx  = params.length - 1;
    const offsetIdx = params.length;

    const { rows } = await db.query(
      `SELECT t.id, t.title, t.status, t.input_target_service,
              t.llm_provider, t.created_at, t.completed_at,
              t.user_id, u.email AS user_email,
              tm.total_cost_usd, tm.total_tokens
         FROM tasks t
         JOIN users u ON u.id = t.user_id
         LEFT JOIN task_metrics tm ON tm.task_id = t.id
         ${where}
        ORDER BY t.created_at DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );

    // Total для пагинации (отдельный запрос — без limit/offset)
    const countParams = params.slice(0, params.length - 2);
    const { rows: cRows } = await db.query(
      `SELECT COUNT(*)::int AS total
         FROM tasks t
         JOIN users u ON u.id = t.user_id
         ${where}`,
      countParams,
    );

    return res.json({
      tasks: rows,
      page,
      perPage,
      total: cRows[0]?.total || 0,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin/tasks/:id
 * Полная задача (включая final_html, final_html_edited, метрики,
 * unused_inputs, провайдер). Без проверки user_id — admin видит всё.
 */
async function getAdminTaskDetail(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT t.*, u.email AS user_email, u.name AS user_name,
              tm.total_cost_usd, tm.total_tokens,
              tm.deepseek_tokens_in, tm.deepseek_tokens_out, tm.deepseek_cost_usd,
              tm.gemini_tokens_in,   tm.gemini_tokens_out,   tm.gemini_cost_usd,
              tm.grok_tokens_in,     tm.grok_tokens_out,     tm.grok_cost_usd,
              tm.lsi_coverage, tm.eeat_score
         FROM tasks t
         JOIN users u ON u.id = t.user_id
         LEFT JOIN task_metrics tm ON tm.task_id = t.id
        WHERE t.id = $1`,
      [req.params.id],
    );
    if (!rows.length) return res.status(404).json({ error: 'Задача не найдена' });

    return res.json({ task: rows[0] });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin/tasks/:id/logs?after=&limit=
 * Те же логи, что и /api/tasks/:id/logs, но без проверки владельца.
 */
async function getAdminTaskLogs(req, res, next) {
  try {
    const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit, 10) || 500));
    const after = (req.query.after || '').trim();

    const params = [req.params.id];
    let whereExtra = '';
    if (after) {
      if (/^\d+$/.test(after)) {
        params.push(parseInt(after, 10));
        whereExtra = ` AND id > $${params.length}`;
      } else {
        const d = new Date(after);
        if (!isNaN(d.getTime())) {
          params.push(d);
          whereExtra = ` AND ts > $${params.length}`;
        }
      }
    }
    params.push(limit);

    const { rows } = await db.query(
      `SELECT id, ts, level, stage, event_type, message, payload
         FROM task_logs
        WHERE task_id = $1${whereExtra}
        ORDER BY id ASC
        LIMIT $${params.length}`,
      params,
    );

    return res.json({ logs: rows, count: rows.length });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: model comparison — агрегат quality_score по моделям.
// Используется для сравнения качества Gemini-моделей (Pro vs Flash и т.п.)
// на корпусе уже завершённых задач. Источник — info_article_tasks.quality_score
// и link_article_tasks.quality_score (миграция 037).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/model-comparison?from=&to=
 *
 * Параметры:
 *   from, to — ISO-даты для фильтра по completed_at (опционально).
 *
 * Ответ:
 *   { rows: [{
 *       model_used, source ('info_article'|'link_article'),
 *       tasks_count,
 *       avg_overall, avg_cost_usd, avg_generation_time_ms,
 *       avg_tokens_in, avg_tokens_out,
 *       avg_eeat, avg_readability, avg_fact_check, avg_plagiarism,
 *       avg_intent, avg_lsi, avg_image_qa, avg_validation
 *     }, ...] }
 */
async function getModelComparison(req, res, next) {
  try {
    const from = req.query.from ? new Date(req.query.from) : null;
    const to   = req.query.to   ? new Date(req.query.to)   : null;
    if (from && Number.isNaN(+from)) return res.status(400).json({ error: 'invalid `from`' });
    if (to   && Number.isNaN(+to))   return res.status(400).json({ error: 'invalid `to`' });

    // Один SQL для обеих таблиц через UNION ALL. Аккуратно через параметры
    // ($1..$4) — никакой SQL-конкатенации (см. point 9.1).
    const sql = `
      WITH unioned AS (
        SELECT
          'info_article' AS source,
          COALESCE(quality_score->>'model_used', gemini_model) AS model_used,
          (quality_score->>'overall')::float            AS overall,
          (quality_score->>'cost_usd')::float           AS cost_usd,
          (quality_score->>'generation_time_ms')::float AS generation_time_ms,
          (quality_score->>'tokens_in')::float          AS tokens_in,
          (quality_score->>'tokens_out')::float         AS tokens_out,
          (quality_score->'sub'->>'eeat')::float        AS sub_eeat,
          (quality_score->'sub'->>'readability')::float AS sub_readability,
          (quality_score->'sub'->>'fact_check')::float  AS sub_fact_check,
          (quality_score->'sub'->>'plagiarism')::float  AS sub_plagiarism,
          (quality_score->'sub'->>'intent')::float      AS sub_intent,
          (quality_score->'sub'->>'lsi')::float         AS sub_lsi,
          (quality_score->'sub'->>'image_qa')::float    AS sub_image_qa,
          (quality_score->'sub'->>'validation')::float  AS sub_validation,
          completed_at
        FROM info_article_tasks
        WHERE quality_score IS NOT NULL
          AND ($1::timestamptz IS NULL OR completed_at >= $1)
          AND ($2::timestamptz IS NULL OR completed_at <= $2)

        UNION ALL

        SELECT
          'link_article' AS source,
          COALESCE(quality_score->>'model_used', gemini_model) AS model_used,
          (quality_score->>'overall')::float            AS overall,
          (quality_score->>'cost_usd')::float           AS cost_usd,
          (quality_score->>'generation_time_ms')::float AS generation_time_ms,
          (quality_score->>'tokens_in')::float          AS tokens_in,
          (quality_score->>'tokens_out')::float         AS tokens_out,
          (quality_score->'sub'->>'eeat')::float        AS sub_eeat,
          NULL::float AS sub_readability,
          NULL::float AS sub_fact_check,
          NULL::float AS sub_plagiarism,
          NULL::float AS sub_intent,
          NULL::float AS sub_lsi,
          NULL::float AS sub_image_qa,
          NULL::float AS sub_validation,
          completed_at
        FROM link_article_tasks
        WHERE quality_score IS NOT NULL
          AND ($3::timestamptz IS NULL OR completed_at >= $3)
          AND ($4::timestamptz IS NULL OR completed_at <= $4)
      )
      SELECT
        source,
        model_used,
        COUNT(*)::int                          AS tasks_count,
        ROUND(AVG(overall)::numeric, 1)        AS avg_overall,
        ROUND(AVG(cost_usd)::numeric, 6)       AS avg_cost_usd,
        ROUND(AVG(generation_time_ms)::numeric, 0) AS avg_generation_time_ms,
        ROUND(AVG(tokens_in)::numeric, 0)      AS avg_tokens_in,
        ROUND(AVG(tokens_out)::numeric, 0)     AS avg_tokens_out,
        ROUND(AVG(sub_eeat)::numeric, 1)        AS avg_eeat,
        ROUND(AVG(sub_readability)::numeric, 1) AS avg_readability,
        ROUND(AVG(sub_fact_check)::numeric, 1)  AS avg_fact_check,
        ROUND(AVG(sub_plagiarism)::numeric, 1)  AS avg_plagiarism,
        ROUND(AVG(sub_intent)::numeric, 1)      AS avg_intent,
        ROUND(AVG(sub_lsi)::numeric, 1)         AS avg_lsi,
        ROUND(AVG(sub_image_qa)::numeric, 1)    AS avg_image_qa,
        ROUND(AVG(sub_validation)::numeric, 1)  AS avg_validation
      FROM unioned
      WHERE model_used IS NOT NULL
      GROUP BY source, model_used
      ORDER BY source, model_used
    `;
    const { rows } = await db.query(sql, [from, to, from, to]);
    return res.json({
      rows,
      filters: {
        from: from ? from.toISOString() : null,
        to:   to   ? to.toISOString()   : null,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-module admin views: per-user UNION list across all 7 task tables
// + detail loader by (source, id). Список источников и их особенности —
// единая «карта» TASK_SOURCES (используется и для UNION, и для detail).
// Никаких новых ENV-переменных: всё деклараций в коде (см. fact «env configuration»).
// ─────────────────────────────────────────────────────────────────────────────

const TASK_SOURCES = Object.freeze({
  seo: Object.freeze({
    table: 'tasks',
    label: 'SEO-текст',
    titleSql: `COALESCE(NULLIF(t.title, ''), t.input_target_service, '')`,
    costSql: `(SELECT total_cost_usd FROM task_metrics WHERE task_id = t.id)`,
    hasCompletedAt: true,
    hasStartedAt: true,
  }),
  meta_tag: Object.freeze({
    table: 'meta_tag_tasks',
    label: 'Мета-теги',
    titleSql: `COALESCE(NULLIF(t.name, ''), '')`,
    costSql: `t.total_cost_usd`,
    hasCompletedAt: true,
    hasStartedAt: true,
  }),
  link_article: Object.freeze({
    table: 'link_article_tasks',
    label: 'Ссылочная статья',
    titleSql: `COALESCE(NULLIF(t.topic, ''), '')`,
    costSql: `t.cost_usd`,
    hasCompletedAt: true,
    hasStartedAt: true,
  }),
  article_topic: Object.freeze({
    table: 'article_topic_tasks',
    label: 'Темы статей',
    titleSql: `COALESCE(NULLIF(t.trend_name, ''), NULLIF(t.niche, ''), '')`,
    costSql: `t.cost_usd`,
    hasCompletedAt: true,
    hasStartedAt: true,
  }),
  info_article: Object.freeze({
    table: 'info_article_tasks',
    label: 'Инфо-статья',
    titleSql: `COALESCE(NULLIF(t.topic, ''), '')`,
    costSql: `t.cost_usd`,
    hasCompletedAt: true,
    hasStartedAt: true,
  }),
  relevance: Object.freeze({
    table: 'relevance_reports',
    label: 'Релевантность',
    titleSql: `COALESCE(NULLIF(t.query, ''), '')`,
    costSql: `0::numeric`,
    hasCompletedAt: true,
    hasStartedAt: true,
  }),
  forecaster: Object.freeze({
    table: 'forecaster_tasks',
    label: 'Прогнозатор',
    titleSql: `COALESCE(NULLIF(t.name, ''), NULLIF(t.source_filename, ''), '')`,
    costSql: `t.cost_usd`,
    hasCompletedAt: true,
    hasStartedAt: true,
  }),
});

/**
 * Собирает один SELECT для UNION ALL по конкретному источнику.
 * Возвращает нормализованные колонки: source, id, title, status, created_at,
 * completed_at, started_at, error_message, cost_usd.
 */
function _sourceSelect(sourceKey, src) {
  const completed = src.hasCompletedAt ? 't.completed_at' : 'NULL::timestamptz';
  const started   = src.hasStartedAt   ? 't.started_at'   : 'NULL::timestamptz';
  return `
    SELECT
      '${sourceKey}'::text                AS source,
      t.id::uuid                          AS id,
      ${src.titleSql}                     AS title,
      t.status::text                      AS status,
      t.created_at                        AS created_at,
      ${completed}                        AS completed_at,
      ${started}                          AS started_at,
      t.error_message                     AS error_message,
      COALESCE(${src.costSql}, 0)::numeric(12,6) AS cost_usd
    FROM ${src.table} t
    WHERE t.user_id = $1
  `;
}

/**
 * GET /api/admin/users/:userId/all-tasks?page=&limit=
 * Список задач пользователя со ВСЕХ модулей — UNION ALL по 7 таблицам.
 * Сортировка по created_at DESC. Пагинация серверная.
 */
async function getUserAllTasks(req, res, next) {
  try {
    const { userId } = req.params;
    const page   = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const offset = (page - 1) * limit;

    const userCheck = await db.query(`SELECT id FROM users WHERE id = $1`, [userId]);
    if (!userCheck.rows.length) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const unionSql = Object.entries(TASK_SOURCES)
      .map(([key, src]) => _sourceSelect(key, src))
      .join(' UNION ALL ');

    const { rows } = await db.query(
      `WITH all_tasks AS ( ${unionSql} )
       SELECT * FROM all_tasks
       ORDER BY created_at DESC NULLS LAST
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );

    const { rows: cRows } = await db.query(
      `WITH all_tasks AS ( ${unionSql} )
       SELECT COUNT(*)::int AS total FROM all_tasks`,
      [userId],
    );

    return res.json({
      tasks: rows,
      total: cRows[0]?.total || 0,
      page,
      limit,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin/cross-tasks/:source/:id
 * Возвращает полную строку таблицы выбранного источника (без проверки user_id —
 * admin видит всё). Источник валидируется по белому списку TASK_SOURCES,
 * id — обязательный UUID (валидация через regex).
 */
async function getCrossTaskDetail(req, res, next) {
  try {
    const { source, id } = req.params;
    const src = TASK_SOURCES[source];
    if (!src) {
      return res.status(400).json({ error: 'Неизвестный модуль задачи' });
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return res.status(400).json({ error: 'Некорректный id' });
    }

    // Имя таблицы — из whitelist (TASK_SOURCES), безопасно для интерполяции.
    const { rows } = await db.query(
      `SELECT t.*, u.email AS user_email, u.name AS user_name
         FROM ${src.table} t
         JOIN users u ON u.id = t.user_id
        WHERE t.id = $1`,
      [id],
    );
    if (!rows.length) return res.status(404).json({ error: 'Задача не найдена' });

    return res.json({ task: rows[0], source, sourceLabel: src.label });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: Воронки генерации (generation_funnels) — учёт успешных/неуспешных
// «связок» (стадий) каждой генерации с детализацией каждой воронки.
// ─────────────────────────────────────────────────────────────────────────────

const FUNNEL_KINDS = new Set([
  'info_article', 'link_article', 'meta_tags', 'relevance',
  'article_topics', 'forecaster', 'super_core_seo',
]);

function _parseFunnelRange(query) {
  const now = Date.now();
  let to = Date.parse(query.to);
  if (!Number.isFinite(to)) to = now;
  let from = Date.parse(query.from);
  if (!Number.isFinite(from)) from = to - 30 * 24 * 60 * 60 * 1000; // 30 дней по умолчанию
  // Гарантируем from < to.
  if (from >= to) from = to - 24 * 60 * 60 * 1000;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/**
 * GET /api/admin/funnels?kind=&from=&to=
 * Возвращает пошаговую воронку по каждому kind (или одному, если задан),
 * conversion-rate по стадиям, топ причин отказов и стоимость/латентность
 * успешной vs неуспешной генерации. Все запросы параметризованы.
 */
async function getFunnelBreakdown(req, res, next) {
  try {
    const { from, to } = _parseFunnelRange(req.query || {});
    const kind = (req.query && typeof req.query.kind === 'string' && FUNNEL_KINDS.has(req.query.kind))
      ? req.query.kind : null;

    const params = [from, to];
    let kindClause = '';
    if (kind) { params.push(kind); kindClause = ` AND kind = $3`; }

    // 1. Сводка по kind: всего / completed / failed / partial + стоимость и
    //    латентность отдельно для успешных и неуспешных генераций.
    const summary = await db.query(
      `SELECT
         kind,
         COUNT(*)::int                                            AS total,
         COUNT(*) FILTER (WHERE status = 'completed')::int        AS completed,
         COUNT(*) FILTER (WHERE status = 'failed')::int           AS failed,
         COUNT(*) FILTER (WHERE status = 'partial')::int          AS partial,
         COALESCE(AVG(total_cost_usd) FILTER (WHERE status = 'completed'), 0)::numeric(12,6) AS avg_cost_completed,
         COALESCE(AVG(total_cost_usd) FILTER (WHERE status = 'failed'),    0)::numeric(12,6) AS avg_cost_failed,
         COALESCE(AVG(duration_ms)    FILTER (WHERE status = 'completed'), 0)::bigint        AS avg_duration_completed,
         COALESCE(AVG(duration_ms)    FILTER (WHERE status = 'failed'),    0)::bigint        AS avg_duration_failed
       FROM generation_funnels
       WHERE created_at >= $1 AND created_at < $2${kindClause}
       GROUP BY kind
       ORDER BY total DESC`,
      params,
    );

    // 2. Пошаговая разбивка (unnest report.stages): сколько связок по каждой
    //    стадии и исходу — основа для conversion-rate по стадиям.
    const stages = await db.query(
      `SELECT
         gf.kind                       AS kind,
         st->>'stage'                  AS stage,
         st->>'outcome'                AS outcome,
         COUNT(*)::int                 AS n
       FROM generation_funnels gf,
            jsonb_array_elements(COALESCE(gf.report->'stages', '[]'::jsonb)) AS st
       WHERE gf.created_at >= $1 AND gf.created_at < $2${kindClause}
       GROUP BY gf.kind, st->>'stage', st->>'outcome'`,
      params,
    );

    // 3. Топ причин отказов на стадию (fail/retry со заполненным reason).
    const reasons = await db.query(
      `SELECT
         gf.kind        AS kind,
         st->>'stage'   AS stage,
         st->>'reason'  AS reason,
         COUNT(*)::int  AS n
       FROM generation_funnels gf,
            jsonb_array_elements(COALESCE(gf.report->'stages', '[]'::jsonb)) AS st
       WHERE gf.created_at >= $1 AND gf.created_at < $2${kindClause}
         AND st->>'outcome' IN ('fail', 'retry')
         AND st->>'reason' IS NOT NULL
       GROUP BY gf.kind, st->>'stage', st->>'reason'
       ORDER BY n DESC`,
      params,
    );

    // 4. Топ причин обрыва воронки (funnel-level fail_reason).
    const failReasons = await db.query(
      `SELECT kind, fail_reason AS reason, COUNT(*)::int AS n
         FROM generation_funnels
        WHERE created_at >= $1 AND created_at < $2${kindClause}
          AND status <> 'completed' AND fail_reason IS NOT NULL
        GROUP BY kind, fail_reason
        ORDER BY n DESC`,
      params,
    );

    // Сборка пошаговой воронки по kind: сохраняем порядок появления стадий и
    // считаем conversion (ok / всего связок этой стадии).
    const funnelsByKind = {};
    for (const row of stages.rows) {
      const k = row.kind;
      if (!funnelsByKind[k]) funnelsByKind[k] = {};
      const s = funnelsByKind[k][row.stage] || { stage: row.stage, ok: 0, fail: 0, skipped: 0, retry: 0, total: 0 };
      const n = Number(row.n) || 0;
      if (row.outcome === 'ok' || row.outcome === 'fail' || row.outcome === 'skipped' || row.outcome === 'retry') {
        s[row.outcome] += n;
      }
      s.total += n;
      funnelsByKind[k][row.stage] = s;
    }
    const stagesList = {};
    for (const k of Object.keys(funnelsByKind)) {
      stagesList[k] = Object.values(funnelsByKind[k]).map((s) => ({
        ...s,
        conversion_pct: s.total ? Number(((s.ok / s.total) * 100).toFixed(1)) : 0,
      }));
    }

    // Причины по стадии → компактная карта { kind: { stage: [{reason,n}] } }.
    const reasonsByKindStage = {};
    for (const row of reasons.rows) {
      const k = row.kind;
      reasonsByKindStage[k] = reasonsByKindStage[k] || {};
      reasonsByKindStage[k][row.stage] = reasonsByKindStage[k][row.stage] || [];
      reasonsByKindStage[k][row.stage].push({ reason: row.reason, n: Number(row.n) || 0 });
    }

    return res.json({
      range: { from, to },
      kind: kind || 'all',
      summary: summary.rows,
      stages: stagesList,
      stage_reasons: reasonsByKindStage,
      fail_reasons: failReasons.rows,
    });
  } catch (err) {
    // Если таблицы ещё нет (миграция не применена) — отдаём пустой каркас,
    // чтобы админка не падала.
    if (err && /generation_funnels/.test(String(err.message))) {
      return res.json({ range: null, kind: 'all', summary: [], stages: {}, stage_reasons: {}, fail_reasons: [], note: 'generation_funnels table not initialized' });
    }
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: Расходы Эгиды по дням (aegis_llm_usage, мигр. 055) — посуточный учёт
// расхода лимитов мозга: токены in/out, стоимость USD, доля prompt-кэша.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/aegis-costs?from=&to=
 * Возвращает: суточный ряд расхода Эгиды (cost/tokens/cached/calls/cache_hits/
 * errors по дням), разбивку по провайдерам и итоги периода с долей кэш-хитов.
 * Период фильтруется from/to (по умолчанию 30 дней). Все запросы параметризованы.
 */
async function getAegisCostBreakdown(req, res, next) {
  try {
    const { from, to } = _parseFunnelRange(req.query || {});
    const params = [from, to];

    // 1. Суточный ряд.
    const daily = await db.query(
      `SELECT date_trunc('day', created_at)::date          AS day,
              COUNT(*)::int                                AS calls,
              COALESCE(SUM(cost_usd), 0)::numeric(14,6)    AS cost_usd,
              COALESCE(SUM(tokens_in), 0)::bigint          AS tokens_in,
              COALESCE(SUM(tokens_out), 0)::bigint         AS tokens_out,
              COALESCE(SUM(cached_tokens), 0)::bigint      AS cached_tokens,
              COUNT(*) FILTER (WHERE cache_hit)::int       AS cache_hits,
              COUNT(*) FILTER (WHERE outcome <> 'ok')::int AS errors
         FROM aegis_llm_usage
        WHERE created_at >= $1 AND created_at < $2
        GROUP BY 1
        ORDER BY 1`,
      params,
    );

    // 2. Разбивка по провайдерам за период.
    const byProvider = await db.query(
      `SELECT provider,
              COUNT(*)::int                                AS calls,
              COALESCE(SUM(cost_usd), 0)::numeric(14,6)    AS cost_usd,
              COALESCE(SUM(tokens_in), 0)::bigint          AS tokens_in,
              COALESCE(SUM(tokens_out), 0)::bigint         AS tokens_out,
              COALESCE(SUM(cached_tokens), 0)::bigint      AS cached_tokens,
              COUNT(*) FILTER (WHERE cache_hit)::int       AS cache_hits
         FROM aegis_llm_usage
        WHERE created_at >= $1 AND created_at < $2
        GROUP BY provider
        ORDER BY cost_usd DESC`,
      params,
    );

    // 3. Итоги периода.
    const totalsQ = await db.query(
      `SELECT COUNT(*)::int                                AS calls,
              COALESCE(SUM(cost_usd), 0)::numeric(14,6)    AS cost_usd,
              COALESCE(SUM(tokens_in), 0)::bigint          AS tokens_in,
              COALESCE(SUM(tokens_out), 0)::bigint         AS tokens_out,
              COALESCE(SUM(cached_tokens), 0)::bigint      AS cached_tokens,
              COUNT(*) FILTER (WHERE cache_hit)::int       AS cache_hits,
              COUNT(*) FILTER (WHERE outcome <> 'ok')::int AS errors
         FROM aegis_llm_usage
        WHERE created_at >= $1 AND created_at < $2`,
      params,
    );

    const t = totalsQ.rows[0] || {};
    const calls = Number(t.calls) || 0;
    const tokensIn = Number(t.tokens_in) || 0;
    const cachedTokens = Number(t.cached_tokens) || 0;
    const totals = {
      calls,
      cost_usd: Number(t.cost_usd) || 0,
      tokens_in: tokensIn,
      tokens_out: Number(t.tokens_out) || 0,
      cached_tokens: cachedTokens,
      cache_hits: Number(t.cache_hits) || 0,
      errors: Number(t.errors) || 0,
      // Доля вызовов с попаданием в кэш и доля закэшированных input-токенов.
      cache_hit_rate_pct: calls ? Number(((Number(t.cache_hits) / calls) * 100).toFixed(1)) : 0,
      cached_token_pct: tokensIn ? Number(((cachedTokens / tokensIn) * 100).toFixed(1)) : 0,
    };

    return res.json({
      range: { from, to },
      totals,
      daily: daily.rows,
      by_provider: byProvider.rows,
    });
  } catch (err) {
    // Таблицы ещё нет (миграция не применена) — пустой каркас, чтобы админка
    // не падала.
    if (err && /aegis_llm_usage/.test(String(err.message))) {
      return res.json({
        range: null,
        totals: { calls: 0, cost_usd: 0, tokens_in: 0, tokens_out: 0, cached_tokens: 0, cache_hits: 0, errors: 0, cache_hit_rate_pct: 0, cached_token_pct: 0 },
        daily: [],
        by_provider: [],
        note: 'aegis_llm_usage table not initialized',
      });
    }
    next(err);
  }
}

module.exports = {
  adminLogin,
  listUsers,
  getUserDetail,
  getUserTasks,
  getStats,
  listAllTasks,
  getAdminTaskDetail,
  getAdminTaskLogs,
  getModelComparison,
  getUserAllTasks,
  getCrossTaskDetail,
  getFunnelBreakdown,
  getAegisCostBreakdown,
};
