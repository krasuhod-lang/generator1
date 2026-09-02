'use strict';

const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const db     = require('../config/db');
const projectGrants = require('../services/projects/projectGrants');
const storageAdmin = require('../services/maintenance/storageAdmin');
const {
  ROLES, PLAN_KEYS, PROFILE_STATUSES,
  normalizeRole, normalizePlanKey, sanitizeOverrides,
  ensureAccessProfile, getUserEntitlements, getPlanCatalog,
} = require('../services/access/entitlementPolicy');

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

    const srcEntries = await _existingTaskSourceEntries();

    const { rows } = await db.query(
      `WITH ut AS (
         SELECT
           z.user_id,
           COUNT(*)::int                                          AS tasks_total,
           COUNT(*) FILTER (WHERE z.norm_status = 'completed')::int  AS tasks_completed,
           COUNT(*) FILTER (WHERE z.norm_status = 'failed')::int     AS tasks_failed,
           COUNT(*) FILTER (WHERE z.norm_status = 'processing')::int AS tasks_processing,
           MAX(z.created_at)                                      AS last_task_at,
           COALESCE(SUM(z.cost_usd), 0)::numeric(14,6)            AS total_cost_usd
         FROM ( ${_userTaskUnionSql({ entries: srcEntries })} ) z
         GROUP BY z.user_id
       )
       SELECT
         u.id, u.email, u.name, u.role,
         COALESCE(p.account_role, CASE WHEN u.role='admin' THEN 'admin' ELSE 'client' END) AS account_role,
         COALESCE(p.plan_key, CASE WHEN u.role='admin' THEN 'internal' ELSE 'trial' END) AS plan_key,
         COALESCE(p.status, 'active') AS access_status,
         p.period_end AS access_period_end,
         u.created_at,
         u.password_plain,
         COALESCE(ut.tasks_total, 0)::int      AS tasks_total,
         COALESCE(ut.tasks_completed, 0)::int  AS tasks_completed,
         COALESCE(ut.tasks_failed, 0)::int     AS tasks_failed,
         COALESCE(ut.tasks_processing, 0)::int AS tasks_processing,
         ut.last_task_at                       AS last_task_at,
         COALESCE(ut.total_cost_usd, 0)::numeric(14,6) AS total_cost_usd
       FROM users u
       LEFT JOIN ut ON ut.user_id = u.id
       LEFT JOIN user_access_profiles p ON p.user_id = u.id
       ${whereSQL}
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

    const srcEntries = await _existingTaskSourceEntries();

    const { rows } = await db.query(
      `WITH ut AS (
         SELECT
           z.user_id,
           COUNT(*)::int                                            AS tasks_total,
           COUNT(*) FILTER (WHERE z.norm_status = 'completed')::int  AS tasks_completed,
           COUNT(*) FILTER (WHERE z.norm_status = 'failed')::int     AS tasks_failed,
           COUNT(*) FILTER (WHERE z.norm_status = 'processing')::int AS tasks_processing,
           COUNT(*) FILTER (WHERE z.norm_status = 'draft')::int      AS tasks_draft,
           COUNT(*) FILTER (WHERE z.norm_status = 'queued')::int     AS tasks_queued,
           MAX(z.created_at)                                        AS last_task_at,
           COALESCE(SUM(z.cost_usd), 0)::numeric(14,6)              AS total_cost_usd
         FROM ( ${_userTaskUnionSql({ filterUser: true, entries: srcEntries })} ) z
         GROUP BY z.user_id
       )
       SELECT
         u.id, u.email, u.name, u.role,
         COALESCE(p.account_role, CASE WHEN u.role='admin' THEN 'admin' ELSE 'client' END) AS account_role,
         COALESCE(p.plan_key, CASE WHEN u.role='admin' THEN 'internal' ELSE 'trial' END) AS plan_key,
         COALESCE(p.status, 'active') AS access_status,
         p.period_end AS access_period_end,
         u.created_at,
         u.password_plain,
         COALESCE(ut.tasks_total, 0)::int      AS tasks_total,
         COALESCE(ut.tasks_completed, 0)::int  AS tasks_completed,
         COALESCE(ut.tasks_failed, 0)::int     AS tasks_failed,
         COALESCE(ut.tasks_processing, 0)::int AS tasks_processing,
         COALESCE(ut.tasks_draft, 0)::int      AS tasks_draft,
         COALESCE(ut.tasks_queued, 0)::int     AS tasks_queued,
         ut.last_task_at                       AS last_task_at,
         COALESCE(ut.total_cost_usd, 0)::numeric(14,6) AS total_cost_usd
       FROM users u
       LEFT JOIN ut ON ut.user_id = u.id
       LEFT JOIN user_access_profiles p ON p.user_id = u.id
       WHERE u.id = $1`,
      [userId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const entitlements = await getUserEntitlements(userId, db);
    return res.json({ user: { ...rows[0], access: entitlements } });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Commercial access management
// ─────────────────────────────────────────────────────────────────────────────

async function listAccessPlans(req, res) {
  return res.json({ plans: getPlanCatalog() });
}

async function getUserAccess(req, res, next) {
  try {
    const { userId } = req.params;
    const access = await getUserEntitlements(userId, db);
    if (!access) return res.status(404).json({ error: 'Пользователь не найден' });
    return res.json({ access });
  } catch (err) {
    return next(err);
  }
}

function parseAccessDate(value, field, fallback = null) {
  if (value === undefined) return fallback;
  if (value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    const error = new Error(`Некорректная дата ${field}`);
    error.status = 400;
    error.code = 'invalid_access_date';
    throw error;
  }
  return date;
}

async function updateUserAccess(req, res, next) {
  try {
    const { userId } = req.params;
    const body = req.body || {};
    const currentProfile = await ensureAccessProfile(userId, db);
    if (!currentProfile) return res.status(404).json({ error: 'Пользователь не найден' });

    const requestedRole = body.role ?? body.account_role;
    const roleCandidate = requestedRole === undefined
      ? normalizeRole(currentProfile.account_role, currentProfile.legacy_role)
      : String(requestedRole).trim().toLowerCase();
    if (!Object.values(ROLES).includes(roleCandidate)) {
      return res.status(400).json({ error: 'Роль должна быть admin, employee или client' });
    }
    const nextRole = roleCandidate;
    const requestedPlan = body.plan_key ?? body.plan;
    const planCandidate = requestedPlan === undefined
      ? normalizePlanKey(currentProfile.plan_key, nextRole)
      : String(requestedPlan).trim().toLowerCase();
    const validPlans = [PLAN_KEYS.TRIAL, PLAN_KEYS.MINIMAL, PLAN_KEYS.MEDIUM, PLAN_KEYS.PRO];
    if (nextRole === ROLES.CLIENT && !validPlans.includes(planCandidate)) {
      return res.status(400).json({ error: 'Для клиента доступен только trial, minimal, medium или pro' });
    }
    if (nextRole !== ROLES.CLIENT && planCandidate !== PLAN_KEYS.INTERNAL) {
      return res.status(400).json({ error: 'Для администратора и сотрудника используется internal plan' });
    }
    const nextPlan = nextRole === ROLES.CLIENT ? planCandidate : PLAN_KEYS.INTERNAL;
    const nextStatus = body.status === undefined ? currentProfile.status : String(body.status).trim().toLowerCase();
    if (!Object.values(PROFILE_STATUSES).includes(nextStatus)) {
      return res.status(400).json({ error: 'Статус должен быть active, paused или expired' });
    }
    const nextOverrides = body.overrides === undefined
      ? sanitizeOverrides(currentProfile.overrides || {})
      : sanitizeOverrides(body.overrides);

    let periodStart = parseAccessDate(body.period_start, 'period_start', currentProfile.period_start ? new Date(currentProfile.period_start) : new Date());
    let periodEnd = parseAccessDate(body.period_end, 'period_end', currentProfile.period_end ? new Date(currentProfile.period_end) : null);
    if (requestedPlan !== undefined && requestedRole !== undefined && nextRole !== normalizeRole(currentProfile.account_role, currentProfile.legacy_role)) {
      periodStart = periodStart || new Date();
    }
    if (nextRole !== ROLES.CLIENT || nextPlan === PLAN_KEYS.TRIAL) periodEnd = null;
    if (nextRole === ROLES.CLIENT && nextPlan !== PLAN_KEYS.TRIAL && currentProfile.plan_key !== nextPlan && !periodEnd) {
      periodStart = body.period_start ? periodStart : new Date();
      periodEnd = new Date(periodStart.getTime() + 31 * 24 * 60 * 60 * 1000);
    }
    if (periodEnd && periodStart && periodEnd.getTime() <= periodStart.getTime()) {
      return res.status(400).json({ error: 'period_end должна быть позже period_start' });
    }

    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`SELECT id, email, role FROM users WHERE id=$1 FOR UPDATE`, [userId]);
      if (!rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Пользователь не найден' });
      }
      const target = rows[0];
      if (String(req.user?.id) === String(userId) && nextRole !== ROLES.ADMIN) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Нельзя снять роль администратора с собственной учётной записи' });
      }
      if (target.role === 'admin' && nextRole !== ROLES.ADMIN) {
        const admins = await client.query(`SELECT COUNT(*)::int AS count FROM users WHERE role='admin'`);
        if (Number(admins.rows[0]?.count || 0) <= 1) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Нельзя снять роль последнего администратора' });
        }
      }
      await client.query(
        `UPDATE users SET role = CASE WHEN $2='admin' THEN 'admin' ELSE CASE WHEN role='admin' THEN 'user' ELSE role END END WHERE id=$1`,
        [userId, nextRole],
      );
      await client.query(
        `INSERT INTO user_access_profiles
           (user_id, account_role, plan_key, status, period_start, period_end, overrides, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           account_role=EXCLUDED.account_role, plan_key=EXCLUDED.plan_key, status=EXCLUDED.status,
           period_start=EXCLUDED.period_start, period_end=EXCLUDED.period_end,
           overrides=EXCLUDED.overrides, updated_at=NOW()`,
        [userId, nextRole, nextPlan, nextStatus, periodStart || new Date(), periodEnd, JSON.stringify(nextOverrides)],
      );
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }

    const access = await getUserEntitlements(userId, db);
    return res.json({ ok: true, access });
  } catch (err) {
    return next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/admin/users/:userId
// Удаление пользователя разрешено только для профиля без task history.
// Контентные задачи и их результаты являются immutable audit history: нельзя
// каскадно уничтожить их через админский DELETE пользователя.
// ─────────────────────────────────────────────────────────────────────────────

async function deleteUser(req, res, next) {
  try {
    const { userId } = req.params;

    if (req.user && String(req.user.id) === String(userId)) {
      return res.status(400).json({ error: 'Нельзя удалить собственную учётную запись' });
    }

    const { rows } = await db.query(
      'SELECT id, email, role FROM users WHERE id = $1',
      [userId],
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    if (rows[0].role === 'admin') {
      return res.status(400).json({ error: 'Нельзя удалить пользователя с ролью администратора' });
    }

    const { rows: taskCounts } = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM tasks WHERE user_id = $1) AS seo_tasks,
         (SELECT COUNT(*) FROM info_article_tasks WHERE user_id = $1) AS info_tasks,
         (SELECT COUNT(*) FROM link_article_tasks WHERE user_id = $1) AS link_tasks,
         (SELECT COUNT(*) FROM meta_tag_tasks WHERE user_id = $1) AS meta_tasks,
         (SELECT COUNT(*) FROM article_topic_tasks WHERE user_id = $1) AS topic_tasks`,
      [userId],
    );
    const protectedCounts = taskCounts[0] || {};
    const protectedTotal = Object.values(protectedCounts).reduce((sum, value) => sum + Number(value || 0), 0);
    if (protectedTotal > 0) {
      return res.status(409).json({
        error: 'Профиль содержит задачи и результаты; удаление заблокировано для сохранения истории',
        code: 'user_task_history_preserved',
        counts: protectedCounts,
      });
    }

    await db.query('DELETE FROM users WHERE id = $1', [userId]);
    console.log(`[admin] user ${rows[0].email} (${userId}) deleted by admin ${req.user?.email || req.user?.id}`);
    return res.json({ ok: true });
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
         t.created_at, t.completed_at, t.started_at, t.archived_at,
         t.error_message,
         m.lsi_coverage, m.eeat_score, m.total_cost_usd, m.bm25_score,
         (SELECT COUNT(*)::int FROM task_content_blocks WHERE task_id = t.id) AS blocks_count
       FROM tasks t
       LEFT JOIN task_metrics m ON m.task_id = t.id
       WHERE t.user_id = $1
       ORDER BY COALESCE(t.completed_at, t.created_at) DESC, t.id DESC
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
    const srcEntries = await _existingTaskSourceEntries();
    const { rows } = await db.query(`
      WITH ut AS ( ${_statusUnionSql(srcEntries)} ),
           uc AS ( ${_userTaskUnionSql({ entries: srcEntries })} )
      SELECT
        (SELECT COUNT(*)::int FROM users) AS total_users,
        (SELECT COUNT(*)::int FROM users WHERE created_at >= NOW() - INTERVAL '1 day') AS users_today,
        (SELECT COUNT(*)::int FROM users WHERE created_at >= NOW() - INTERVAL '7 days') AS users_this_week,
        (SELECT COUNT(*)::int FROM users WHERE created_at >= NOW() - INTERVAL '30 days') AS users_this_month,
        (SELECT COUNT(*)::int FROM ut) AS total_tasks,
        (SELECT COUNT(*)::int FROM ut WHERE norm_status = 'completed') AS tasks_completed,
        (SELECT COUNT(*)::int FROM ut WHERE norm_status = 'failed') AS tasks_failed,
        (SELECT COUNT(*)::int FROM ut WHERE norm_status = 'processing') AS tasks_processing,
        (SELECT COALESCE(SUM(cost_usd), 0)::numeric(14,4) FROM uc) AS total_cost_usd,
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
    activityAtSql: `CASE WHEN COALESCE(t.content_stale, FALSE) THEN COALESCE(t.updated_at, t.created_at) ELSE COALESCE(t.completed_at, t.last_started_at, t.updated_at, t.created_at) END`,
    updatedAtSql: 't.updated_at',
    archivedAtSql: 't.archived_at',
    lastStartedAtSql: 't.last_started_at',
    contentStaleSql: 't.content_stale',
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
    updatedAtSql: 't.updated_at',
    archivedAtSql: 't.archived_at',
    lastStartedAtSql: 't.started_at',
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
    updatedAtSql: 't.updated_at',
    archivedAtSql: 't.archived_at',
    lastStartedAtSql: 't.started_at',
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
  serp_b2b: Object.freeze({
    table: 'serp_b2b_tasks',
    label: 'SERP B2B',
    titleSql: `COALESCE(NULLIF(t.name, ''), NULLIF(t.query, ''), '')`,
    costSql: `0::numeric`,
    hasCompletedAt: true,
    hasStartedAt: true,
  }),
  category_lead: Object.freeze({
    table: 'category_lead_tasks',
    label: 'Category Lead',
    titleSql: `COALESCE(NULLIF(t.name, ''), NULLIF(t.category, ''), '')`,
    costSql: `t.cost_usd`,
    hasCompletedAt: true,
    hasStartedAt: true,
  }),
  parser: Object.freeze({
    table: 'parser_tasks',
    label: 'Парсер контента',
    titleSql: `COALESCE(NULLIF(t.input_urls->>0, ''), 'Parser scan')`,
    costSql: `0::numeric`,
    completedAtSql: `t.finished_at`,
    startedAtSql: `NULL::timestamptz`,
    errorSql: `t.error`,
  }),
  site_crawl: Object.freeze({
    table: 'site_crawl_tasks',
    label: 'Site Crawl',
    titleSql: `COALESCE(NULLIF(t.start_url, ''), 'Site crawl')`,
    costSql: `0::numeric`,
    completedAtSql: `t.finished_at`,
    startedAtSql: `t.started_at`,
    errorSql: `t.error`,
  }),
});

// Кэш списка реально существующих таблиц-источников. Нужен, чтобы один
// неприменённый миграцией модуль (отсутствующая таблица) не ломал ВЕСЬ
// UNION-запрос и, как следствие, не «прятал» весь список пользователей.
let _taskSourceCache = { entries: null, ts: 0 };
const _TASK_SOURCE_TTL_MS = 60_000;

/**
 * Возвращает Object.entries(TASK_SOURCES), оставляя только те источники,
 * чьи таблицы реально присутствуют в БД (проверка через to_regclass).
 * Результат кэшируется на _TASK_SOURCE_TTL_MS. При ошибке проверки —
 * безопасный фолбэк на полный список (поведение как раньше).
 */
async function _existingTaskSourceEntries() {
  const now = Date.now();
  if (_taskSourceCache.entries && (now - _taskSourceCache.ts) < _TASK_SOURCE_TTL_MS) {
    return _taskSourceCache.entries;
  }

  const all = Object.entries(TASK_SOURCES);
  try {
    const { rows } = await db.query(
      `SELECT tbl, to_regclass('public.' || tbl) IS NOT NULL AS exists
         FROM unnest($1::text[]) AS tbl`,
      [all.map(([, src]) => src.table)],
    );
    const existing = new Set(
      rows.filter((r) => r.exists).map((r) => r.tbl),
    );
    const entries = all.filter(([, src]) => existing.has(src.table));
    // Если по какой-то причине не нашли ни одной таблицы — не обнуляем список,
    // отдаём полный набор (пусть запрос сам решает), чтобы не терять данные.
    _taskSourceCache = { entries: entries.length ? entries : all, ts: now };
  } catch (_) {
    _taskSourceCache = { entries: all, ts: now };
  }
  return _taskSourceCache.entries;
}

/**
 * Собирает один SELECT для UNION ALL по конкретному источнику.
 * Возвращает нормализованные колонки: source, id, title, status, created_at,
 * completed_at, started_at, activity_at, error_message, cost_usd.
 */
function _sourceSelect(sourceKey, src) {
  const completed = src.completedAtSql || (src.hasCompletedAt ? 't.completed_at' : 'NULL::timestamptz');
  const started   = src.startedAtSql || (src.hasStartedAt ? 't.started_at' : 'NULL::timestamptz');
  const errorExpr = src.errorSql || 't.error_message';
  const archived = src.archivedAtSql || 'NULL::timestamptz';
  const lastStarted = src.lastStartedAtSql || 'NULL::timestamptz';
  const contentStale = src.contentStaleSql || 'FALSE';
  const updated = src.updatedAtSql || 't.created_at';
  const activityAt = src.activityAtSql || `CASE
    WHEN t.status::text IN ('completed', 'done', 'failed', 'error', 'cancelled')
      THEN COALESCE(${completed}, ${updated}, t.created_at)
    ELSE COALESCE(${started}, ${updated}, t.created_at)
  END`;
  return `
    SELECT
      '${sourceKey}'::text                AS source,
      t.id::text                          AS id,
      ${src.titleSql}                     AS title,
      t.status::text                      AS status,
      t.created_at                        AS created_at,
      ${completed}                        AS completed_at,
      ${started}                          AS started_at,
      ${lastStarted}                      AS last_started_at,
      ${contentStale}                     AS content_stale,
      ${activityAt}                       AS activity_at,
      ${archived}                         AS archived_at,
      ${errorExpr}                        AS error_message,
      COALESCE(${src.costSql}, 0)::numeric(12,6) AS cost_usd
    FROM ${src.table} t
    WHERE t.user_id = $1
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Сводные счётчики задач по ВСЕМ модулям (а не только legacy-таблица `tasks`).
// Разные модули используют разный словарь статусов: legacy `tasks` —
// 'completed'/'failed'/'processing'/'draft'/'queued', а новые модули —
// 'done'/'error'/'running'. Нормализуем к единому набору, чтобы счётчики
// в админ-панели учитывали все задачи. Источники берём из TASK_SOURCES.
// ─────────────────────────────────────────────────────────────────────────────

/** Нормализация статуса задачи к единому словарю (псевдоним таблицы — `t`).
 *  ВАЖНО: t.status в каждом модуле — это собственный ENUM-тип (task_status,
 *  relevance_report_status, forecaster_status, info_article_status и т.д.),
 *  и наборы значений у них РАЗНЫЕ. Сравнивать ENUM напрямую со строкой,
 *  отсутствующей в его словаре (например, 'completed' для
 *  relevance_report_status, где есть только 'done'/'error'), Postgres не
 *  даёт — кидает «invalid input value for enum». Из-за этого UNION ALL
 *  по всем источникам падал, и админ-панель показывала 0 задач, 0 успехов,
 *  0 ошибок и пустой список пользователей. Поэтому приводим status к text
 *  ДО сравнения, чтобы IN работал на текстовом наборе. */
const NORM_STATUS_SQL = `
  CASE
    WHEN t.status::text IN ('completed', 'done')                    THEN 'completed'
    WHEN t.status::text IN ('failed', 'error')                      THEN 'failed'
    WHEN t.status::text IN ('processing', 'running', 'in_progress') THEN 'processing'
    WHEN t.status::text IN ('queued', 'pending')                    THEN 'queued'
    ELSE t.status::text
  END`;

/**
 * UNION ALL по всем источникам с нормализованными колонками для агрегации
 * per-user счётчиков: user_id, norm_status, created_at, cost_usd.
 * Если filterUser=true — каждый SELECT ограничивается `WHERE t.user_id = $1`.
 * `entries` — список реально существующих источников (по умолчанию все).
 */
function _userTaskUnionSql({ filterUser = false, entries = Object.entries(TASK_SOURCES) } = {}) {
  const where = filterUser ? 'WHERE t.user_id = $1' : '';
  return entries
    .map(([, src]) => `
      SELECT
        t.user_id::uuid                            AS user_id,
        ${NORM_STATUS_SQL}                         AS norm_status,
        t.created_at                               AS created_at,
        COALESCE(${src.costSql}, 0)::numeric(14,6) AS cost_usd
      FROM ${src.table} t
      ${where}
    `)
    .join(' UNION ALL ');
}

/**
 * UNION ALL по всем источникам только со статусом — для глобальной статистики.
 * `entries` — список реально существующих источников (по умолчанию все).
 */
function _statusUnionSql(entries = Object.entries(TASK_SOURCES)) {
  return entries
    .map(([, src]) => `SELECT ${NORM_STATUS_SQL} AS norm_status FROM ${src.table} t`)
    .join(' UNION ALL ');
}

/**
 * GET /api/admin/users/:userId/all-tasks?page=&limit=
 * Список задач пользователя со ВСЕХ модулей — UNION ALL по 7 таблицам.
 * Сортировка по activity_at DESC с fallback на created_at. Пагинация серверная.
 */
async function getUserAllTasks(req, res, next) {
  try {
    // Один и тот же контроллер используется admin-профилем (userId в URL)
    // и пользовательским Центром задач (только собственный req.user.id).
    const userId = req.params.userId || req.user?.id;
    const page   = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const offset = (page - 1) * limit;

    const userCheck = await db.query(`SELECT id FROM users WHERE id = $1`, [userId]);
    if (!userCheck.rows.length) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const srcEntries = await _existingTaskSourceEntries();
    const unionSql = srcEntries
      .map(([key, src]) => _sourceSelect(key, src))
      .join(' UNION ALL ');

    const { rows } = await db.query(
      `WITH all_tasks AS ( ${unionSql} )
       SELECT * FROM all_tasks
       ORDER BY activity_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );

    const { rows: cRows } = await db.query(
      `WITH all_tasks AS ( ${unionSql} )
       SELECT COUNT(*)::int AS total FROM all_tasks`,
      [userId],
    );

    const privileged = ['admin', 'employee'].includes(normalizeRole(req.user?.role));
    const normalizedStatus = (status) => {
      const value = String(status || '').toLowerCase();
      if (['completed', 'done'].includes(value)) return 'completed';
      if (['failed', 'error', 'timeout'].includes(value)) return 'failed';
      if (['processing', 'running', 'in_progress'].includes(value)) return 'processing';
      if (['queued', 'pending'].includes(value)) return 'queued';
      return value || 'unknown';
    };
    const safeRows = rows.map((row) => ({
      ...row,
      status: normalizedStatus(row.status),
      source_label: TASK_SOURCES[row.source]?.label || row.source,
      // Клиенту не отдаются стоимость и техническая ошибка — только тип,
      // статус, дата и безопасное название задачи.
      cost_usd: privileged ? row.cost_usd : null,
      error_message: privileged ? row.error_message : null,
    }));

    return res.json({
      tasks: safeRows,
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
    const validUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const validIntegerId = /^\d+$/.test(id);
    if (!validUuid && !validIntegerId) {
      return res.status(400).json({ error: 'Некорректный id' });
    }

    // Имя таблицы — из whitelist (TASK_SOURCES), безопасно для интерполяции.
    const { rows } = await db.query(
      `SELECT t.*, u.email AS user_email, u.name AS user_name
         FROM ${src.table} t
         JOIN users u ON u.id = t.user_id
        WHERE t.id::text = $1`,
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
              COALESCE(SUM(cost_usd), 0)::numeric(18,12) AS cost_usd,
              COALESCE(SUM(tokens_in), 0)::bigint          AS tokens_in,
              COALESCE(SUM(tokens_out), 0)::bigint         AS tokens_out,
              COALESCE(SUM(cached_tokens), 0)::bigint      AS cached_tokens,
              COALESCE(SUM(COALESCE(cache_hit_tokens, cached_tokens)), 0)::bigint AS cache_hit_tokens,
              COALESCE(SUM(COALESCE(cache_miss_tokens, GREATEST(COALESCE(tokens_in, 0) - COALESCE(cache_hit_tokens, cached_tokens, 0), 0))), 0)::bigint AS cache_miss_tokens,
              COALESCE(SUM(input_cost_usd), 0)::numeric(18,12) AS input_cost_usd,
              COALESCE(SUM(output_cost_usd), 0)::numeric(18,12) AS output_cost_usd,
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
              COALESCE(SUM(cost_usd), 0)::numeric(18,12) AS cost_usd,
              COALESCE(SUM(tokens_in), 0)::bigint          AS tokens_in,
              COALESCE(SUM(tokens_out), 0)::bigint         AS tokens_out,
              COALESCE(SUM(cached_tokens), 0)::bigint      AS cached_tokens,
              COALESCE(SUM(COALESCE(cache_hit_tokens, cached_tokens)), 0)::bigint AS cache_hit_tokens,
              COALESCE(SUM(COALESCE(cache_miss_tokens, GREATEST(COALESCE(tokens_in, 0) - COALESCE(cache_hit_tokens, cached_tokens, 0), 0))), 0)::bigint AS cache_miss_tokens,
              COALESCE(SUM(input_cost_usd), 0)::numeric(18,12) AS input_cost_usd,
              COALESCE(SUM(output_cost_usd), 0)::numeric(18,12) AS output_cost_usd,
              COUNT(*) FILTER (WHERE cache_hit)::int       AS cache_hits
         FROM aegis_llm_usage
        WHERE created_at >= $1 AND created_at < $2
        GROUP BY provider
        ORDER BY cost_usd DESC`,
      params,
    );

    // 3. Разбивка по фактической модели и pricing mode.
    const byModel = await db.query(
      `SELECT provider, COALESCE(model, provider) AS model,
              COALESCE(pricing_mode, 'unknown') AS pricing_mode,
              COUNT(*)::int AS calls,
              COALESCE(SUM(cost_usd), 0)::numeric(18,12) AS cost_usd,
              COALESCE(SUM(tokens_in), 0)::bigint AS tokens_in,
              COALESCE(SUM(tokens_out), 0)::bigint AS tokens_out,
              COALESCE(SUM(COALESCE(cache_hit_tokens, cached_tokens)), 0)::bigint AS cache_hit_tokens,
              COALESCE(SUM(COALESCE(cache_miss_tokens, GREATEST(COALESCE(tokens_in, 0) - COALESCE(cache_hit_tokens, cached_tokens, 0), 0))), 0)::bigint AS cache_miss_tokens,
              COALESCE(SUM(input_cost_usd), 0)::numeric(18,12) AS input_cost_usd,
              COALESCE(SUM(output_cost_usd), 0)::numeric(18,12) AS output_cost_usd
         FROM aegis_llm_usage
        WHERE created_at >= $1 AND created_at < $2
        GROUP BY provider, COALESCE(model, provider), COALESCE(pricing_mode, 'unknown')
        ORDER BY cost_usd DESC`,
      params,
    );

    // 4. Итоги периода.
    const totalsQ = await db.query(
      `SELECT COUNT(*)::int                                AS calls,
              COALESCE(SUM(cost_usd), 0)::numeric(18,12) AS cost_usd,
              COALESCE(SUM(tokens_in), 0)::bigint          AS tokens_in,
              COALESCE(SUM(tokens_out), 0)::bigint         AS tokens_out,
              COALESCE(SUM(cached_tokens), 0)::bigint      AS cached_tokens,
              COALESCE(SUM(COALESCE(cache_hit_tokens, cached_tokens)), 0)::bigint AS cache_hit_tokens,
              COALESCE(SUM(COALESCE(cache_miss_tokens, GREATEST(COALESCE(tokens_in, 0) - COALESCE(cache_hit_tokens, cached_tokens, 0), 0))), 0)::bigint AS cache_miss_tokens,
              COALESCE(SUM(input_cost_usd), 0)::numeric(18,12) AS input_cost_usd,
              COALESCE(SUM(output_cost_usd), 0)::numeric(18,12) AS output_cost_usd,
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
    const hitTokens = t.cache_hit_tokens == null ? cachedTokens : Math.max(0, Number(t.cache_hit_tokens) || 0);
    const missTokens = t.cache_miss_tokens == null
      ? Math.max(0, tokensIn - hitTokens)
      : Math.max(0, Number(t.cache_miss_tokens) || 0);
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
      cached_token_pct: tokensIn ? Number(((hitTokens / tokensIn) * 100).toFixed(1)) : 0,
      cache_hit_tokens: hitTokens,
      cache_miss_tokens: missTokens,
      input_cost_usd: Number(t.input_cost_usd) || 0,
      output_cost_usd: Number(t.output_cost_usd) || 0,
    };

    return res.json({
      range: { from, to },
      totals,
      daily: daily.rows,
      by_provider: byProvider.rows,
      by_model: byModel.rows,
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
        by_model: [],
        note: 'aegis_llm_usage table not initialized',
      });
    }
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// API usage ledger / anomaly monitoring
// ─────────────────────────────────────────────────────────────────────────────

function _adminUsageRange(query = {}) {
  const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
  const now = new Date();
  const fromDate = validDate(query.from)
    ? new Date(`${query.from}T00:00:00.000Z`)
    : new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  const toDate = validDate(query.to)
    ? new Date(`${query.to}T00:00:00.000Z`)
    : now;
  const toExclusive = validDate(query.to)
    ? new Date(toDate.getTime() + 24 * 3600 * 1000)
    : toDate;
  return {
    from: Number.isNaN(fromDate.getTime()) ? new Date(now.getTime() - 30 * 24 * 3600 * 1000) : fromDate,
    to: Number.isNaN(toExclusive.getTime()) ? now : toExclusive,
  };
}

function _emptyAdminApiUsage(note = null) {
  return {
    range: null,
    totals: {
      requests: 0, successful: 0, failed: 0, retries: 0, outside_task: 0,
      tokens_in: 0, tokens_out: 0, cached_tokens: 0, cache_hit_tokens: 0,
      cache_miss_tokens: 0, thoughts_tokens: 0, cost_usd: 0,
      input_cost_usd: 0, output_cost_usd: 0,
    },
    daily: [], by_provider: [], by_model: [], by_pipeline: [], anomalies: [],
    data_quality: { ledger_ready: false, ledger_rows: 0, historical_stage_calls: 0, note },
    reconciliation: {
      ledger_cost_usd: 0, task_stage_cost_usd: 0, task_stage_calls: 0,
      task_stage_tokens_in: 0, task_stage_tokens_out: 0, delta_usd: 0, note: 'no data',
    },
    note,
  };
}

async function getAdminApiUsage(req, res, next) {
  const { from, to } = _adminUsageRange(req.query || {});
  const params = [from, to];
  try {
    const [totalsQ, dailyQ, providerQ, modelQ, pipelineQ, anomalyQ, stageQ] = await Promise.all([
      db.query(
        `SELECT COUNT(*)::int AS requests,
                COUNT(*) FILTER (WHERE request_status IN ('success','partial_json'))::int AS successful,
                COUNT(*) FILTER (WHERE request_status IN ('failed','invalid_response'))::int AS failed,
                COUNT(*) FILTER (WHERE request_status = 'cache_miss')::int AS cache_misses,
                COUNT(*) FILTER (WHERE attempt > 1 OR request_status = 'truncated')::int AS retries,
                COUNT(*) FILTER (WHERE task_id IS NULL AND trace_task_id IS NULL)::int AS outside_task,
                COUNT(*) FILTER (WHERE (task_id IS NULL) <> (trace_task_id IS NULL))::int AS partial_attribution,
                COALESCE(SUM(tokens_in),0)::bigint AS tokens_in,
                COALESCE(SUM(tokens_out),0)::bigint AS tokens_out,
                COALESCE(SUM(cached_tokens),0)::bigint AS cached_tokens,
                COALESCE(SUM(cache_hit_tokens),0)::bigint AS cache_hit_tokens,
                COALESCE(SUM(cache_miss_tokens),0)::bigint AS cache_miss_tokens,
                COALESCE(SUM(thoughts_tokens),0)::bigint AS thoughts_tokens,
                COALESCE(SUM(input_cost_usd),0)::numeric(18,12) AS input_cost_usd,
                COALESCE(SUM(output_cost_usd),0)::numeric(18,12) AS output_cost_usd,
                COALESCE(SUM(cost_usd),0)::numeric(18,12) AS cost_usd
           FROM admin_api_request_ledger
          WHERE created_at >= $1 AND created_at < $2`, params,
      ),
      db.query(
        `SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
                COUNT(*)::int AS requests,
                COALESCE(SUM(cost_usd),0)::numeric(18,12) AS cost_usd,
                COALESCE(SUM(tokens_in),0)::bigint AS tokens_in,
                COALESCE(SUM(tokens_out),0)::bigint AS tokens_out,
                COUNT(*) FILTER (WHERE request_status IN ('failed','invalid_response'))::int AS failed,
                COUNT(*) FILTER (WHERE task_id IS NULL AND trace_task_id IS NULL)::int AS outside_task,
                COUNT(*) FILTER (WHERE (task_id IS NULL) <> (trace_task_id IS NULL))::int AS partial_attribution
           FROM admin_api_request_ledger
          WHERE created_at >= $1 AND created_at < $2
          GROUP BY date_trunc('day', created_at AT TIME ZONE 'UTC')
          ORDER BY day ASC`, params,
      ),
      db.query(
        `SELECT provider, COALESCE(model, '—') AS model,
                COUNT(*)::int AS requests,
                COUNT(*) FILTER (WHERE request_status IN ('failed','invalid_response'))::int AS failed,
                COUNT(*) FILTER (WHERE task_id IS NULL AND trace_task_id IS NULL)::int AS outside_task,
                COUNT(*) FILTER (WHERE (task_id IS NULL) <> (trace_task_id IS NULL))::int AS partial_attribution,
                COALESCE(SUM(tokens_in),0)::bigint AS tokens_in,
                COALESCE(SUM(tokens_out),0)::bigint AS tokens_out,
                COALESCE(SUM(cost_usd),0)::numeric(18,12) AS cost_usd
           FROM admin_api_request_ledger
          WHERE created_at >= $1 AND created_at < $2
          GROUP BY provider, model
          ORDER BY cost_usd DESC, requests DESC`, params,
      ),
      db.query(
        `SELECT provider, COALESCE(model, '—') AS model,
                COUNT(*)::int AS requests,
                COUNT(*) FILTER (WHERE request_status IN ('failed','invalid_response'))::int AS failed,
                COALESCE(SUM(cost_usd),0)::numeric(18,12) AS cost_usd,
                COALESCE(SUM(tokens_in),0)::bigint AS tokens_in,
                COALESCE(SUM(tokens_out),0)::bigint AS tokens_out
           FROM admin_api_request_ledger
          WHERE created_at >= $1 AND created_at < $2
          GROUP BY provider, model
          ORDER BY cost_usd DESC, requests DESC
          LIMIT 100`, params,
      ),
      db.query(
        `SELECT COALESCE(pipeline, 'unattributed') AS pipeline,
                COUNT(*)::int AS requests,
                COUNT(*) FILTER (WHERE request_status IN ('failed','invalid_response'))::int AS failed,
                COUNT(*) FILTER (WHERE task_id IS NULL AND trace_task_id IS NULL)::int AS outside_task,
                COUNT(*) FILTER (WHERE (task_id IS NULL) <> (trace_task_id IS NULL))::int AS partial_attribution,
                COALESCE(SUM(cost_usd),0)::numeric(18,12) AS cost_usd,
                COALESCE(SUM(tokens_in),0)::bigint AS tokens_in,
                COALESCE(SUM(tokens_out),0)::bigint AS tokens_out
           FROM admin_api_request_ledger
          WHERE created_at >= $1 AND created_at < $2
          GROUP BY COALESCE(pipeline, 'unattributed')
          ORDER BY cost_usd DESC, requests DESC`, params,
      ),
      db.query(
        `SELECT id, created_at, provider, model, pipeline, stage_name, call_label,
                task_id, trace_task_id, request_status, attempt, duration_ms,
                tokens_in, tokens_out, cached_tokens, cost_usd,
                error_code, error_message,
                CASE
                  WHEN task_id IS NULL AND trace_task_id IS NULL THEN 'outside_task'
                  WHEN task_id IS NULL OR trace_task_id IS NULL THEN 'partial_attribution'
                  WHEN request_status IN ('failed','invalid_response') THEN 'failed'
                  WHEN request_status = 'cache_miss' THEN 'cache_miss'
                  WHEN attempt > 1 OR request_status = 'truncated' THEN 'retry'
                  WHEN cost_usd >= 0.50 THEN 'high_cost'
                  ELSE 'review'
                END AS anomaly_type
           FROM admin_api_request_ledger
          WHERE created_at >= $1 AND created_at < $2
            AND (task_id IS NULL OR trace_task_id IS NULL
                 OR request_status IN ('failed','invalid_response','cache_miss','truncated')
                 OR attempt > 1 OR cost_usd >= 0.50)
          ORDER BY created_at DESC
          LIMIT 100`, params,
      ),
      db.query(
        `SELECT COUNT(*)::int AS task_stage_calls,
                COALESCE(SUM(tokens_in),0)::bigint AS task_stage_tokens_in,
                COALESCE(SUM(tokens_out),0)::bigint AS task_stage_tokens_out,
                COALESCE(SUM(cost_usd),0)::numeric(18,12) AS task_stage_cost_usd
           FROM task_stages
          WHERE completed_at >= $1 AND completed_at < $2`, params,
      ),
    ]);

    const raw = totalsQ.rows[0] || {};
    const num = (value) => Number(value) || 0;
    const totals = {
      requests: num(raw.requests), successful: num(raw.successful), failed: num(raw.failed),
      retries: num(raw.retries), cache_misses: num(raw.cache_misses), outside_task: num(raw.outside_task), partial_attribution: num(raw.partial_attribution),
      tokens_in: num(raw.tokens_in), tokens_out: num(raw.tokens_out),
      cached_tokens: num(raw.cached_tokens), cache_hit_tokens: num(raw.cache_hit_tokens),
      cache_miss_tokens: num(raw.cache_miss_tokens), thoughts_tokens: num(raw.thoughts_tokens),
      cost_usd: num(raw.cost_usd), input_cost_usd: num(raw.input_cost_usd),
      output_cost_usd: num(raw.output_cost_usd),
    };
    const stageRow = stageQ.rows[0] || {};
    const stageCalls = num(stageRow.task_stage_calls);
    const stageCost = num(stageRow.task_stage_cost_usd);
    const ledgerNote = totals.requests === 0 && stageCalls > 0
      ? 'API ledger пуст в выбранном периоде, но сохранённые task stages найдены. Показываем legacy-сверку; новые обращения будут записываться в ledger после инициализации схемы.'
      : null;
    return res.json({
      data_quality: {
        ledger_ready: true,
        ledger_rows: totals.requests,
        historical_stage_calls: stageCalls,
        note: ledgerNote,
      },
      range: { from: from.toISOString(), to: to.toISOString() },
      totals,
      daily: dailyQ.rows.map((row) => ({ ...row, requests: num(row.requests), cost_usd: num(row.cost_usd), tokens_in: num(row.tokens_in), tokens_out: num(row.tokens_out), failed: num(row.failed), outside_task: num(row.outside_task), partial_attribution: num(row.partial_attribution) })),
      by_provider: providerQ.rows.map((row) => ({ ...row, requests: num(row.requests), failed: num(row.failed), outside_task: num(row.outside_task), partial_attribution: num(row.partial_attribution), tokens_in: num(row.tokens_in), tokens_out: num(row.tokens_out), cost_usd: num(row.cost_usd) })),
      by_model: modelQ.rows.map((row) => ({ ...row, requests: num(row.requests), failed: num(row.failed), tokens_in: num(row.tokens_in), tokens_out: num(row.tokens_out), cost_usd: num(row.cost_usd) })),
      by_pipeline: pipelineQ.rows.map((row) => ({ ...row, requests: num(row.requests), failed: num(row.failed), outside_task: num(row.outside_task), partial_attribution: num(row.partial_attribution), tokens_in: num(row.tokens_in), tokens_out: num(row.tokens_out), cost_usd: num(row.cost_usd) })),
      anomalies: anomalyQ.rows.map((row) => ({ ...row, cost_usd: num(row.cost_usd), tokens_in: num(row.tokens_in), tokens_out: num(row.tokens_out), attempt: num(row.attempt) })),
      reconciliation: {
        ledger_cost_usd: totals.cost_usd,
        task_stage_cost_usd: stageCost,
        task_stage_calls: stageCalls,
        task_stage_tokens_in: num(stageRow.task_stage_tokens_in),
        task_stage_tokens_out: num(stageRow.task_stage_tokens_out),
        delta_usd: Number((totals.cost_usd - stageCost).toFixed(12)),
        note: ledgerNote || 'Ledger is authoritative for every provider attempt; task_stages contains only persisted successful stage calls, so delta exposes retries/failures/cache accounting gaps rather than hiding them.',
      },
      historical_task_stages: {
        calls: stageCalls,
        tokens_in: num(stageRow.task_stage_tokens_in),
        tokens_out: num(stageRow.task_stage_tokens_out),
        cost_usd: stageCost,
        approximate: true,
      },
    });
  } catch (error) {
    if (error && /admin_api_request_ledger|task_stages/.test(String(error.message))) {
      return res.status(503).json({
        error: 'API usage ledger is not initialized',
        code: 'API_USAGE_SCHEMA_UNAVAILABLE',
        note: 'Примените runtime schema bootstrap или migration 142 и повторите запрос.',
      });
    }
    return next(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin storage audit / cleanup
// ─────────────────────────────────────────────────────────────────────────────

async function getAdminStorageAudit(req, res, next) {
  try {
    return res.json(await storageAdmin.getStorageAudit({ db }));
  } catch (error) {
    return next(error);
  }
}

async function cleanupAdminStorage(req, res, next) {
  try {
    const body = req.body || {};
    const dryRun = body.dryRun !== false;
    const result = await storageAdmin.cleanupStorage({
      scope: body.scope,
      olderThanDays: body.olderThanDays,
      confirm: body.confirm,
      dryRun,
      db,
    });
    return res.json({
      ok: true,
      dry_run: dryRun,
      result,
      message: dryRun ? 'Preview выполнен; данные не удалялись' : 'Очистка выполнена',
    });
  } catch (error) {
    return next(error);
  }
}

async function getAdminStorageInventory(req, res, next) {
  try {
    const result = await storageAdmin.getStorageInventory({
      rootKey: req.query.root,
      page: req.query.page,
      limit: req.query.limit,
      search: req.query.search,
      sort: req.query.sort,
      order: req.query.order,
    });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
}

async function deleteAdminStorageFile(req, res, next) {
  try {
    const body = req.body || {};
    const result = await storageAdmin.deleteStorageFile({
      rootKey: body.root,
      relativePath: body.relative_path,
      confirm: body.confirm,
      dryRun: body.dryRun !== false,
      db,
    });
    return res.json({
      ok: true,
      dry_run: result.dry_run,
      result,
      message: result.dry_run ? 'Preview выполнен; файл не удалён' : 'Файл удалён',
    });
  } catch (error) {
    return next(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Project grants — раздача доступов к проектам через панель администратора
// (миграция 092, задача 1). Все эндпоинты под /api/admin/projects/.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/projects
 * Список всех проектов с владельцем и количеством активных грантов.
 * Параметры: page, limit, search (по имени/email владельца).
 */
async function listAdminProjects(req, res, next) {
  try {
    const page   = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();
    const params = [];
    let where = '';
    if (search) {
      params.push(`%${search}%`);
      where = `WHERE p.name ILIKE $${params.length} OR u.email ILIKE $${params.length}`;
    }
    const totalRes = await db.query(
      `SELECT COUNT(*)::int AS n FROM projects p JOIN users u ON u.id = p.user_id ${where}`,
      params,
    );
    params.push(limit, offset);
    const { rows } = await db.query(
      `SELECT p.id, p.name, p.url, p.created_at, p.contribute_to_brain,
              u.id AS owner_id, u.email AS owner_email, u.name AS owner_name,
              (SELECT COUNT(*)::int FROM project_grants g
                 WHERE g.project_id = p.id AND g.revoked_at IS NULL
                   AND (g.expires_at IS NULL OR g.expires_at > NOW())) AS active_grants
         FROM projects p
         JOIN users u ON u.id = p.user_id
         ${where}
         ORDER BY p.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return res.json({
      projects: rows,
      pagination: { page, limit, total: totalRes.rows[0].n },
    });
  } catch (err) { return next(err); }
}

/** GET /api/admin/projects/:id/grants — все гранты проекта (вкл. revoked). */
async function listAdminProjectGrants(req, res, next) {
  try {
    const projectId = req.params.id;
    const { rows: projRows } = await db.query(
      `SELECT p.id, p.name, u.id AS owner_id, u.email AS owner_email, u.name AS owner_name
         FROM projects p JOIN users u ON u.id = p.user_id WHERE p.id = $1`,
      [projectId],
    );
    if (!projRows.length) return res.status(404).json({ error: 'Проект не найден' });
    const grants = await projectGrants.listGrants(projectId, { includeRevoked: true }, db);
    return res.json({ project: projRows[0], grants });
  } catch (err) { return next(err); }
}

/** POST /api/admin/projects/:id/grants */
async function createAdminProjectGrant(req, res, next) {
  try {
    const projectId = req.params.id;
    const body = req.body || {};
    const userId  = body.user_id;
    const role    = body.role;
    const scopes  = body.scopes;
    const expires = body.expires_at || null;
    const note    = body.note || null;
    if (!userId)                              return res.status(400).json({ error: 'user_id обязателен' });
    if (!projectGrants.normalizeRole(role))   return res.status(400).json({ error: 'Неверная роль (viewer|analyst|manager)' });
    if (!projectGrants.normalizeScopes(scopes)) return res.status(400).json({ error: 'Нужен хотя бы один валидный scope (project|analyses|reports)' });
    try {
      const { grant, action } = await projectGrants.upsertGrant({
        projectId, userId, role, scopes,
        grantedBy: req.user && req.user.id, expiresAt: expires, note,
      }, db);
      return res.status(action === 'created' ? 201 : 200).json({ grant, action });
    } catch (e) {
      if (/owner/.test(e.message)) return res.status(400).json({ error: 'Нельзя выдать доступ владельцу проекта' });
      if (/project not found/.test(e.message)) return res.status(404).json({ error: 'Проект не найден' });
      throw e;
    }
  } catch (err) { return next(err); }
}

/** PATCH /api/admin/projects/:id/grants/:grantId */
async function updateAdminProjectGrant(req, res, next) {
  try {
    const { id: projectId, grantId } = req.params;
    const { rows: gRows } = await db.query(
      `SELECT user_id FROM project_grants WHERE id = $1 AND project_id = $2`,
      [grantId, projectId],
    );
    if (!gRows.length) return res.status(404).json({ error: 'Грант не найден' });
    const body = req.body || {};
    const role    = body.role;
    const scopes  = body.scopes;
    const expires = ('expires_at' in body) ? (body.expires_at || null) : null;
    const note    = ('note' in body) ? body.note : null;
    if (!projectGrants.normalizeRole(role))   return res.status(400).json({ error: 'Неверная роль (viewer|analyst|manager)' });
    if (!projectGrants.normalizeScopes(scopes)) return res.status(400).json({ error: 'Нужен хотя бы один валидный scope' });
    const { grant, action } = await projectGrants.upsertGrant({
      projectId, userId: gRows[0].user_id, role, scopes,
      grantedBy: req.user && req.user.id, expiresAt: expires, note,
    }, db);
    return res.json({ grant, action });
  } catch (err) { return next(err); }
}

/** DELETE /api/admin/projects/:id/grants/:grantId — soft-revoke. */
async function revokeAdminProjectGrant(req, res, next) {
  try {
    const { id: projectId, grantId } = req.params;
    const { rows: gRows } = await db.query(
      `SELECT id FROM project_grants WHERE id = $1 AND project_id = $2 AND revoked_at IS NULL`,
      [grantId, projectId],
    );
    if (!gRows.length) return res.status(404).json({ error: 'Активный грант не найден' });
    const g = await projectGrants.revokeGrant(grantId, req.user && req.user.id, db);
    return res.json({ grant: g, action: 'revoked' });
  } catch (err) { return next(err); }
}

/**
 * GET /api/admin/projects/:id/grantable-users?search=
 * Список кандидатов для выдачи доступа: все non-admin пользователи, кроме
 * владельца. Используется автокомплитом модалки выдачи доступа.
 */
async function listAdminGrantableUsers(req, res, next) {
  try {
    const projectId = req.params.id;
    const search = (req.query.search || '').trim();
    const { rows: pRows } = await db.query(
      `SELECT user_id FROM projects WHERE id = $1`, [projectId],
    );
    if (!pRows.length) return res.status(404).json({ error: 'Проект не найден' });
    const ownerId = pRows[0].user_id;
    const params = [ownerId];
    let where = `WHERE u.id <> $1`;
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (u.email ILIKE $${params.length} OR u.name ILIKE $${params.length})`;
    }
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.name, u.role
         FROM users u ${where}
         ORDER BY u.email ASC
         LIMIT 50`,
      params,
    );
    return res.json({ users: rows });
  } catch (err) { return next(err); }
}

module.exports = {
  adminLogin,
  listUsers,
  listAccessPlans,
  getUserAccess,
  updateUserAccess,
  getUserDetail,
  deleteUser,
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
  getAdminApiUsage,
  getAdminStorageAudit,
  cleanupAdminStorage,
  getAdminStorageInventory,
  deleteAdminStorageFile,
  // Project grants (миграция 092, задача 1)
  listAdminProjects,
  listAdminProjectGrants,
  createAdminProjectGrant,
  updateAdminProjectGrant,
  revokeAdminProjectGrant,
  listAdminGrantableUsers,
};
