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

module.exports = { adminLogin, listUsers, getUserDetail, getUserTasks, getStats };
