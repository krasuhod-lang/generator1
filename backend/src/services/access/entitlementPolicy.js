'use strict';

const crypto = require('crypto');
const dbDefault = require('../../config/db');

const ROLES = Object.freeze({ ADMIN: 'admin', EMPLOYEE: 'employee', CLIENT: 'client' });
const PLAN_KEYS = Object.freeze({ TRIAL: 'trial', MINIMAL: 'minimal', MEDIUM: 'medium', PRO: 'pro', INTERNAL: 'internal' });
const PROFILE_STATUSES = Object.freeze({ ACTIVE: 'active', PAUSED: 'paused', EXPIRED: 'expired' });

// Immutable product catalog. Values are service units per period; null means unlimited.
const PLAN_CATALOG = Object.freeze({
  trial: Object.freeze({
    key: 'trial', name: 'Бесплатный доступ', priceRub: 0, period: 'lifetime',
    limits: Object.freeze({ article_generations: 5, seo_articles: null, blog_articles: null, link_articles: null, meta_categories: 0, projects_reports: 0, relevance_runs: 0, article_topics: 0, max_concurrent: 5, proposal_builder: null, json: null }),
  }),
  minimal: Object.freeze({
    key: 'minimal', name: 'Минимальный', priceRub: 4990, period: 'monthly',
    limits: Object.freeze({ article_generations: null, seo_articles: 5, blog_articles: 10, link_articles: 10, meta_categories: 70, projects_reports: 3, relevance_runs: 100, article_topics: 10, max_concurrent: 5, proposal_builder: null, json: null }),
  }),
  medium: Object.freeze({
    key: 'medium', name: 'Средний', priceRub: 9990, period: 'monthly',
    limits: Object.freeze({ article_generations: null, seo_articles: 10, blog_articles: 15, link_articles: 20, meta_categories: 140, projects_reports: 5, relevance_runs: 100, article_topics: 10, max_concurrent: 5, proposal_builder: null, json: null }),
  }),
  pro: Object.freeze({
    key: 'pro', name: 'Про', priceRub: 14990, period: 'monthly',
    limits: Object.freeze({ article_generations: null, seo_articles: 15, blog_articles: 20, link_articles: 30, meta_categories: 210, projects_reports: 10, relevance_runs: 100, article_topics: 10, max_concurrent: 5, proposal_builder: null, json: null }),
  }),
  internal: Object.freeze({
    key: 'internal', name: 'Внутренний доступ', priceRub: 0, period: 'internal',
    limits: Object.freeze({ article_generations: null, seo_articles: null, blog_articles: null, link_articles: null, meta_categories: null, projects_reports: null, relevance_runs: null, article_topics: null, max_concurrent: 5, proposal_builder: null, json: null }),
  }),
});

const LIMIT_KEYS = Object.freeze([
  'article_generations', 'seo_articles', 'blog_articles', 'link_articles', 'meta_categories',
  'projects_reports', 'relevance_runs', 'article_topics', 'max_concurrent',
]);
const RESOURCE_KEYS = Object.freeze([
  'article_generations', 'seo_articles', 'blog_articles', 'link_articles', 'meta_categories',
  'projects_reports', 'relevance_runs', 'article_topics',
]);
const TASK_RESOURCE_MAP = Object.freeze({
  seo: 'seo_articles', tasks: 'seo_articles',
  info_article: 'blog_articles', blog_article: 'blog_articles',
  link_article: 'link_articles',
  meta_tags: 'meta_categories', meta_tag: 'meta_categories',
  relevance: 'relevance_runs',
  article_topics: 'article_topics', article_topic: 'article_topics',
});

function normalizeRole(rawRole, legacyRole = null) {
  const role = String(rawRole || '').trim().toLowerCase();
  if (Object.values(ROLES).includes(role)) return role;
  if (role === 'user' || role === 'customer' || role === 'client') return ROLES.CLIENT;
  if (String(legacyRole || '').trim().toLowerCase() === 'admin') return ROLES.ADMIN;
  return ROLES.CLIENT;
}

function normalizePlanKey(rawPlan, role = ROLES.CLIENT) {
  const plan = String(rawPlan || '').trim().toLowerCase();
  if (role === ROLES.ADMIN || role === ROLES.EMPLOYEE) return PLAN_KEYS.INTERNAL;
  return Object.prototype.hasOwnProperty.call(PLAN_CATALOG, plan) && plan !== PLAN_KEYS.INTERNAL
    ? plan : PLAN_KEYS.TRIAL;
}

function toFiniteNonNegative(value, key) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1000000) {
    const error = new Error(`Некорректный override лимита ${key}`);
    error.status = 400;
    error.code = 'invalid_access_override';
    throw error;
  }
  return Math.floor(n);
}

function sanitizeOverrides(raw) {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    const error = new Error('overrides должны быть JSON-объектом');
    error.status = 400;
    error.code = 'invalid_access_override';
    throw error;
  }
  const out = {};
  for (const key of Object.keys(raw)) {
    if (!LIMIT_KEYS.includes(key)) {
      const error = new Error(`Недопустимый override лимита: ${key}`);
      error.status = 400;
      error.code = 'invalid_access_override';
      throw error;
    }
    const value = toFiniteNonNegative(raw[key], key);
    if (value !== null) out[key] = value;
  }
  if (out.max_concurrent != null) out.max_concurrent = Math.min(50, out.max_concurrent);
  return out;
}

function periodKeyFor(profile, now = new Date()) {
  if (profile.plan_key === PLAN_KEYS.TRIAL) return 'trial:lifetime';
  if (profile.plan_key === PLAN_KEYS.INTERNAL) return 'internal:unlimited';
  const start = profile.period_start ? new Date(profile.period_start) : now;
  return `${profile.plan_key}:${start.toISOString().slice(0, 7)}`;
}

function isProfileActive(profile, now = new Date()) {
  if (!profile) return false;
  if (profile.status && profile.status !== PROFILE_STATUSES.ACTIVE) return false;
  if (profile.period_end && new Date(profile.period_end).getTime() <= now.getTime()) return false;
  if (profile.period_start && new Date(profile.period_start).getTime() > now.getTime()) return false;
  return true;
}

function effectiveLimits(profile, now = new Date()) {
  const role = normalizeRole(profile?.account_role, profile?.legacy_role);
  if (role === ROLES.ADMIN) {
    return { ...PLAN_CATALOG.internal.limits, max_concurrent: 50 };
  }
  const planKey = normalizePlanKey(profile?.plan_key, role);
  const plan = PLAN_CATALOG[planKey] || PLAN_CATALOG.trial;
  const active = isProfileActive(profile, now);
  const base = active ? plan.limits : Object.fromEntries(LIMIT_KEYS.map((key) => [key, 0]));
  const overrides = sanitizeOverrides(profile?.overrides || {});
  const limits = { ...base };
  if (active) {
    for (const key of LIMIT_KEYS) {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) limits[key] = overrides[key];
    }
  }
  limits.max_concurrent = Math.min(50, Math.max(1, Number(limits.max_concurrent) || 1));
  return limits;
}

function publicLimit(value) {
  return value == null ? null : Number(value);
}

function isClientRole(role) {
  return normalizeRole(role) === ROLES.CLIENT;
}

function isClientRequest(req) {
  return isClientRole(req?.user?.accountRole || req?.user?.role);
}

const CLIENT_TASK_SENSITIVE_FIELDS = Object.freeze([
  'llm_provider', 'llm_model', 'gemini_model', 'model_used',
  'bull_job_id', 'bullJobId', 'job_id', 'jobId', 'worker_id', 'workerId', 'lease_token', 'leaseToken', 'lease_until', 'leaseUntil', 'heartbeat_at', 'heartbeatAt',
  'pending_outbox', 'pendingOutbox', 'bull_job_state', 'bullJobState', 'profile_queue', 'profileQueue', 'queue_reason', 'queueReason', 'queue_attempts', 'queueAttempts', 'queue_error', 'queueError',
  'recovery_attempts', 'recoveryAttempts', 'pipeline_checkpoint', 'pipelineCheckpoint',
  'deepseek_tokens_in', 'deepseek_tokens_out', 'deepseek_cost_usd',
  'gemini_tokens_in', 'gemini_tokens_out', 'gemini_cost_usd',
  'grok_tokens_in', 'grok_tokens_out', 'grok_cost_usd',
  'total_tokens', 'total_tokens_in', 'total_tokens_out', 'total_cost_usd',
  'tokens_in', 'tokens_out', 'cost_usd', 'api_cost_usd', 'tokensIn', 'tokensOut', 'costUsd', 'apiCostUsd', 'total_cost', 'totalCost',
  'prompt_size', 'promptSize', 'error_message', 'last_error', 'lastError', 'internal_error', 'internalError', 'error', 'logs', 'log', 'stage_logs', 'stageLogs', 'debug',
]);

function clientStatusMessage(status) {
  const messages = {
    draft: 'Черновик сохранён.',
    queued: 'Задача принята и ожидает запуска.',
    pending: 'Задача принята и ожидает запуска.',
    processing: 'Генерация выполняется.',
    running: 'Генерация выполняется.',
    in_progress: 'Генерация выполняется.',
    partial: 'Результат формируется.',
    completed: 'Результат готов.',
    done: 'Результат готов.',
    failed: 'Не удалось завершить генерацию. Попробуйте запустить задачу повторно.',
    error: 'Не удалось завершить генерацию. Попробуйте запустить задачу повторно.',
    timeout: 'Генерация превысила допустимое время. Попробуйте запустить задачу повторно.',
    paused: 'Задача приостановлена.',
    cancelled: 'Задача отменена.',
  };
  return messages[String(status || '').toLowerCase()] || 'Статус задачи обновляется.';
}

function sanitizeTaskForClient(task) {
  if (!task || typeof task !== 'object') return task;
  const safe = { ...task };
  for (const key of CLIENT_TASK_SENSITIVE_FIELDS) delete safe[key];
  if (safe.status) safe.status_message = clientStatusMessage(safe.status);
  return safe;
}

function sanitizeMetricsForClient(metrics) {
  if (!metrics || typeof metrics !== 'object') return null;
  const allowed = [
    'lsi_coverage', 'ngram_coverage', 'tfidf_status', 'eeat_score', 'pq_score',
    'anti_water_count', 'hallucination_count', 'hcu_status', 'spam_detected',
  ];
  return Object.fromEntries(allowed.filter((key) => Object.prototype.hasOwnProperty.call(metrics, key)).map((key) => [key, metrics[key]]));
}

function sanitizeBlockForClient(block) {
  if (!block || typeof block !== 'object') return block;
  const safe = { ...block };
  delete safe.audit_log_json;
  delete safe.tokens_in;
  delete safe.tokens_out;
  delete safe.cost_usd;
  return safe;
}

function clientVisibilityError() {
  const error = new Error('Технические логи доступны только сотрудникам и администраторам');
  error.status = 403;
  error.code = 'technical_visibility_restricted';
  return error;
}

async function loadUserProfile(userId, db = dbDefault) {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.name, u.email_verified, u.created_at, u.role AS legacy_role,
            p.account_role, p.plan_key, p.status, p.period_start, p.period_end,
            p.overrides, p.updated_at AS access_updated_at
       FROM users u
       LEFT JOIN user_access_profiles p ON p.user_id = u.id
      WHERE u.id = $1
      LIMIT 1`,
    [userId],
  );
  if (!rows.length) return null;
  const row = rows[0];
  const accountRole = normalizeRole(row.account_role, row.legacy_role);
  const planKey = normalizePlanKey(row.plan_key, accountRole);
  return {
    ...row,
    account_role: accountRole,
    plan_key: planKey,
    status: row.status || 'active',
    overrides: sanitizeOverrides(row.overrides || {}),
  };
}

async function getUsage(profile, db = dbDefault) {
  if (!profile) return {};
  const periodKey = periodKeyFor(profile);
  const { rows } = await db.query(
    `SELECT resource_key, COALESCE(SUM(units), 0)::int AS used
       FROM access_usage_reservations
      WHERE user_id = $1 AND period_key = $2 AND state IN ('reserved', 'consumed')
      GROUP BY resource_key`,
    [profile.id, periodKey],
  );
  const usage = rows.reduce((acc, row) => { acc[row.resource_key] = Number(row.used || 0); return acc; }, {});
  try {
    const { rows: projectRows } = await db.query(
      `SELECT (
         (SELECT COUNT(*) FROM projects WHERE user_id=$1)
         +
         (SELECT COUNT(*) FROM position_projects WHERE user_id=$1 AND parent_project_id IS NULL)
       )::int AS used`,
      [profile.id],
    );
    usage.projects_reports = Number(projectRows[0]?.used || 0);
  } catch (_) {
    // Old volumes are self-healed at startup; keep auth available during a
    // rolling migration if a legacy project table is momentarily unavailable.
  }
  return usage;
}

async function getUserEntitlements(userId, db = dbDefault) {
  const profile = await loadUserProfile(userId, db);
  if (!profile) return null;
  const limits = effectiveLimits(profile);
  const used = await getUsage(profile, db);
  const remaining = {};
  const effectiveStatus = isProfileActive(profile) ? profile.status : PROFILE_STATUSES.EXPIRED;
  for (const key of RESOURCE_KEYS) {
    remaining[key] = limits[key] == null ? null : Math.max(0, Number(limits[key]) - Number(used[key] || 0));
  }
  return {
    role: profile.account_role,
    plan: profile.plan_key,
    planName: PLAN_CATALOG[profile.plan_key]?.name || profile.plan_key,
    status: effectiveStatus,
    periodStart: profile.period_start || null,
    periodEnd: profile.period_end || null,
    periodKey: periodKeyFor(profile),
    limits: Object.fromEntries(Object.entries(limits).map(([key, value]) => [key, publicLimit(value)])),
    used,
    remaining,
    unlimited: Object.keys(limits).filter((key) => limits[key] == null),
    overrides: profile.overrides,
    catalog: profile.account_role === ROLES.CLIENT
      ? Object.values(PLAN_CATALOG).filter((plan) => [PLAN_KEYS.TRIAL, PLAN_KEYS.MINIMAL, PLAN_KEYS.MEDIUM, PLAN_KEYS.PRO].includes(plan.key)).map((plan) => ({ key: plan.key, name: plan.name, priceRub: plan.priceRub, period: plan.period, limits: plan.limits }))
      : undefined,
  };
}

async function ensureAccessProfile(userId, db = dbDefault) {
  const profile = await loadUserProfile(userId, db);
  if (profile) return profile;
  const { rows } = await db.query(
    `INSERT INTO user_access_profiles (user_id, account_role, plan_key, status, period_start, period_end, overrides)
     SELECT id,
            CASE WHEN role = 'admin' THEN 'admin' ELSE 'client' END,
            CASE WHEN role = 'admin' THEN 'internal' ELSE 'trial' END,
            'active', NOW(), NULL, '{}'::jsonb
       FROM users WHERE id = $1
     ON CONFLICT (user_id) DO NOTHING
     RETURNING user_id`,
    [userId],
  );
  return loadUserProfile(userId, db);
}

function entitlementError({ resourceKey, used, limit, units, profile, periodEnd }) {
  const labels = {
    article_generations: 'генерации статей по бесплатному доступу',
    seo_articles: 'SEO-тексты', blog_articles: 'статьи для блога', link_articles: 'ссылочные статьи',
    meta_categories: 'категории мета-тегов', relevance_runs: 'съёмы релевантности', article_topics: 'задачи тем статей',
  };
  const error = new Error(`Лимит тарифа исчерпан: ${labels[resourceKey] || resourceKey}. Доступно ${Math.max(0, Number(limit || 0) - Number(used || 0))}, требуется ${units}.`);
  error.status = 402;
  error.code = 'entitlement_limit';
  error.details = {
    resource: resourceKey, used: Number(used || 0), limit: Number(limit || 0), requested: Number(units || 0),
    remaining: Math.max(0, Number(limit || 0) - Number(used || 0)), plan: profile.plan_key,
    periodEnd: periodEnd || null, hint: profile.account_role === ROLES.EMPLOYEE ? 'Обратитесь к администратору для изменения индивидуального лимита.' : 'Выберите тариф выше или обратитесь к администратору.',
  };
  return error;
}

/**
 * Atomically reserves a billable unit. Call before inserting a new task row.
 * `taskId` + `itemIndex` form an idempotency key; retries never double-charge.
 */
async function admitUsage({ userId, resourceKey, units = 1, source, taskId, itemIndex = 0, db = dbDefault }) {
  const amount = Math.max(1, Math.floor(Number(units) || 0));
  if (!RESOURCE_KEYS.includes(resourceKey)) return { admitted: true, unlimited: true, reservationId: null };
  const profile = await ensureAccessProfile(userId, db);
  const limits = effectiveLimits(profile);
  const limit = limits[resourceKey];
  if (limit == null) return { admitted: true, unlimited: true, reservationId: null, profile };
  const periodKey = periodKeyFor(profile);
  const reservationTaskId = String(taskId || crypto.randomUUID());
  const reservationItemIndex = Math.max(0, Math.floor(Number(itemIndex) || 0));
  const client = db.getClient ? await db.getClient() : db;
  const shouldRelease = Boolean(client.release);
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`access-usage:${userId}:${periodKey}:${resourceKey}`]);
    const existing = await client.query(
      `SELECT id, units, state FROM access_usage_reservations
        WHERE user_id=$1 AND period_key=$2 AND resource_key=$3 AND source=$4 AND task_id=$5 AND item_index=$6
        FOR UPDATE`,
      [userId, periodKey, resourceKey, String(source || 'task'), reservationTaskId, reservationItemIndex],
    );
    if (existing.rows[0] && existing.rows[0].state !== 'released') {
      await client.query('COMMIT');
      return { admitted: true, idempotent: true, reservationId: existing.rows[0].id, profile };
    }
    const usage = await client.query(
      `SELECT COALESCE(SUM(units),0)::int AS used
         FROM access_usage_reservations
        WHERE user_id=$1 AND period_key=$2 AND resource_key=$3 AND state IN ('reserved','consumed')
          AND NOT (source=$4 AND task_id=$5 AND item_index=$6)`,
      [userId, periodKey, resourceKey, String(source || 'task'), reservationTaskId, reservationItemIndex],
    );
    const used = Number(usage.rows[0]?.used || 0);
    if (used + amount > Number(limit)) {
      await client.query('COMMIT');
      throw entitlementError({ resourceKey, used, limit, units: amount, profile, periodEnd: profile.period_end });
    }
    let row;
    if (existing.rows[0]) {
      row = await client.query(
        `UPDATE access_usage_reservations SET units=$7, state='reserved', released_at=NULL, updated_at=NOW()
          WHERE id=$1 RETURNING id`,
        [existing.rows[0].id, userId, periodKey, resourceKey, String(source || 'task'), reservationTaskId, amount],
      );
    } else {
      row = await client.query(
        `INSERT INTO access_usage_reservations
           (user_id, period_key, resource_key, source, task_id, item_index, units, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'reserved') RETURNING id`,
        [userId, periodKey, resourceKey, String(source || 'task'), reservationTaskId, reservationItemIndex, amount],
      );
    }
    await client.query('COMMIT');
    return { admitted: true, reservationId: row.rows[0].id, periodKey, profile };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    if (shouldRelease) client.release();
  }
}

async function commitUsageReservation(reservationId, db = dbDefault) {
  if (!reservationId) return;
  await db.query(`UPDATE access_usage_reservations SET state='consumed', consumed_at=COALESCE(consumed_at,NOW()), updated_at=NOW() WHERE id=$1 AND state='reserved'`, [reservationId]);
}

async function releaseUsageReservation(reservationId, db = dbDefault) {
  if (!reservationId) return;
  await db.query(`UPDATE access_usage_reservations SET state='released', released_at=NOW(), updated_at=NOW() WHERE id=$1 AND state='reserved'`, [reservationId]);
}

async function admitTaskUsage({ userId, taskType, taskId, units = 1, source = taskType, itemIndex = 0, db = dbDefault }) {
  const resourceKey = TASK_RESOURCE_MAP[String(taskType || '').toLowerCase()];
  if (!resourceKey) return { admitted: true, unlimited: true, reservationId: null };
  const profile = await ensureAccessProfile(userId, db);
  const role = normalizeRole(profile.account_role, profile.legacy_role);
  // Trial is a single shared five-article bucket across SEO/blog/link.
  const actualResource = profile.plan_key === PLAN_KEYS.TRIAL && ['seo_articles', 'blog_articles', 'link_articles'].includes(resourceKey)
    ? 'article_generations' : resourceKey;
  if (role === ROLES.ADMIN) return { admitted: true, unlimited: true, reservationId: null, profile };
  return admitUsage({ userId, resourceKey: actualResource, units, source, taskId, itemIndex, db });
}

async function withTaskUsageReservation({ userId, taskType, taskId, units = 1, source = taskType, itemIndex = 0, db = dbDefault, fn }) {
  if (typeof fn !== 'function') throw new TypeError('withTaskUsageReservation requires fn');
  const reservation = await admitTaskUsage({ userId, taskType, taskId, units, source, itemIndex, db });
  try {
    const result = await fn(reservation);
    await commitUsageReservation(reservation.reservationId, db);
    return result;
  } catch (error) {
    await releaseUsageReservation(reservation.reservationId, db).catch((releaseError) => {
      console.warn('[Entitlement] reservation release failed:', releaseError.message);
    });
    throw error;
  }
}

async function withProjectCapacity({ userId, db = dbDefault, fn }) {
  if (typeof fn !== 'function') throw new TypeError('withProjectCapacity requires fn');
  const profile = await ensureAccessProfile(userId, db);
  const limit = effectiveLimits(profile).projects_reports;
  if (limit == null || profile.account_role === ROLES.ADMIN) return fn(db);
  const client = db.getClient ? await db.getClient() : db;
  const shouldRelease = Boolean(client.release);
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`project-cap:${userId}`]);
    const { rows } = await client.query(
      `SELECT (
         (SELECT COUNT(*) FROM projects WHERE user_id=$1)
         +
         (SELECT COUNT(*) FROM position_projects WHERE user_id=$1 AND parent_project_id IS NULL)
       )::int AS count`,
      [userId],
    );
    const used = Number(rows[0]?.count || 0);
    if (used >= Number(limit)) {
      await client.query('COMMIT');
      throw entitlementError({ resourceKey: 'projects_reports', used, limit, units: 1, profile, periodEnd: profile.period_end });
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    if (shouldRelease) client.release();
  }
}

async function getEffectiveMaxConcurrent(userId, db = dbDefault) {
  const profile = await ensureAccessProfile(userId, db);
  return Number(effectiveLimits(profile).max_concurrent || 1);
}

function getPlanCatalog() {
  return Object.values(PLAN_CATALOG).filter((plan) => plan.key !== PLAN_KEYS.INTERNAL).map((plan) => ({
    key: plan.key, name: plan.name, priceRub: plan.priceRub, period: plan.period, limits: { ...plan.limits },
  }));
}

module.exports = {
  ROLES, PLAN_KEYS, PROFILE_STATUSES, PLAN_CATALOG, LIMIT_KEYS, RESOURCE_KEYS, TASK_RESOURCE_MAP,
  normalizeRole, normalizePlanKey, sanitizeOverrides, periodKeyFor, effectiveLimits,
  isClientRole, isClientRequest, clientStatusMessage, sanitizeTaskForClient,
  sanitizeMetricsForClient, sanitizeBlockForClient, clientVisibilityError,
  loadUserProfile, ensureAccessProfile, getUsage, getUserEntitlements, getPlanCatalog,
  admitUsage, admitTaskUsage, withTaskUsageReservation, withProjectCapacity, commitUsageReservation, releaseUsageReservation, getEffectiveMaxConcurrent,
};
