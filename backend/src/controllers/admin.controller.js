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
              tm.lsi_coverage, tm.eeat_score, tm.naturalness_score
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

module.exports = { adminLogin, listUsers, getUserDetail, getUserTasks, getStats, listAllTasks, getAdminTaskDetail, getAdminTaskLogs };
