'use strict';

/**
 * projects/projectGrants.js — раздача доступов к проектам.
 *
 * Модель прав:
 *   • Владелец проекта (projects.user_id) — всегда роль `owner`, все scopes.
 *   • Любой другой зарегистрированный пользователь может получить «грант»
 *     с одной из ролей (viewer | analyst | manager) и набором scope
 *     (project | analyses | reports). Грант хранится в таблице
 *     project_grants (миграция 092) и может быть soft-revoked.
 *
 * Роли и разрешённые действия:
 *   viewer   — только чтение проекта/анализа/отчёта по выданным scope.
 *              Принудительно client-режим (X-Client-Mode игнорируется),
 *              чтобы клиент не видел технические поля (token_enc, raw_prompt и т.п.).
 *   analyst  — чтение во всех режимах (analyst|client) + редактирование
 *              отчётов/драфтов; не может пересобирать анализ и удалять.
 *   manager  — analyst + право триггерить пересборку анализа/отчёта.
 *   owner    — всё, что выше + удаление, шеринг, выдача доступов,
 *              привязка GSC/Я.Вебмастер.
 *
 * Чистые функции (canAct/normalize*) тестируются отдельно
 * (см. backend/scripts/test-project-grants.js); работающие с БД функции
 * принимают опц. dbInstance ради тестируемости.
 */

const db = require('../../config/db');

const ROLES        = Object.freeze(['viewer', 'analyst', 'manager']);
const SCOPES       = Object.freeze(['project', 'analyses', 'reports']);
const DEFAULT_SCOPES = Object.freeze(['project', 'analyses', 'reports']);

/** Возвращает валидную роль или null. */
function normalizeRole(value) {
  const v = typeof value === 'string' ? value.toLowerCase().trim() : '';
  return ROLES.includes(v) ? v : null;
}

/**
 * Нормализует список scope: уникальные, валидные, минимум один.
 * Возвращает null, если после фильтрации список пуст — это сигнал
 * для контроллера вернуть 400.
 */
function normalizeScopes(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const v = typeof item === 'string' ? item.toLowerCase().trim() : '';
    if (SCOPES.includes(v) && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out.length ? out : null;
}

/**
 * Полный объект «доступа» (использует middleware/контроллеры).
 *   • role:     'owner' | 'viewer' | 'analyst' | 'manager'
 *   • scopes:   массив выданных scope (для owner — все)
 *   • isOwner:  true для владельца
 *   • grantId / grantedBy / expiresAt — для грантов (для owner null)
 *
 * canAct/forcedClientMode применяются к результату.
 */
function buildOwnerAccess() {
  return {
    role: 'owner',
    scopes: [...DEFAULT_SCOPES],
    isOwner: true,
    grantId: null,
  };
}

function buildGrantAccess(grant) {
  const scopes = normalizeScopes(grant.scopes) || [];
  return {
    role: grant.role,
    scopes,
    isOwner: false,
    grantId: grant.id,
    grantedBy: grant.granted_by || null,
    expiresAt: grant.expires_at || null,
  };
}

/**
 * Проверяет, разрешено ли action в данном scope для access.
 *   action: 'read' | 'write' | 'run' | 'delete' | 'admin'
 *
 *   read   — viewer+ (нужен соотв. scope)
 *   write  — analyst+ (например, редактирование отчёта/драфта; нужен scope reports/analyses)
 *   run    — manager+ (запуск/пересборка анализа, экспорт snapshot)
 *   delete — owner-only
 *   admin  — owner-only (выдача доступов, шеринг, отвязка GSC)
 *
 * scope аргумент опционален: если задан — дополнительно проверяется,
 * что он в access.scopes (для owner — игнорируется, у владельца всё).
 */
function canAct(access, action, scope = null) {
  if (!access) return false;
  if (access.isOwner) return true;
  if (scope && !access.scopes.includes(scope)) return false;
  switch (action) {
    case 'read':   return ROLES.includes(access.role); // любой грант
    case 'write':  return access.role === 'analyst' || access.role === 'manager';
    case 'run':    return access.role === 'manager';
    case 'delete': return false;
    case 'admin':  return false;
    default:       return false;
  }
}

/**
 * Возвращает «принудительный» режим просмотра для гранта, либо null,
 * если ограничения нет. viewer всегда видит client-вид
 * (см. viewMode.sanitizeProject/sanitizeAnalysis).
 */
function forcedClientMode(access) {
  if (!access || access.isOwner) return null;
  return access.role === 'viewer' ? 'client' : null;
}

// ── DB layer ─────────────────────────────────────────────────────────

/**
 * Активный грант (без revoked, не истекший) пользователя на проект,
 * либо null.
 */
async function loadGrant(projectId, userId, dbInstance = db) {
  if (!projectId || !userId) return null;
  const { rows } = await dbInstance.query(
    `SELECT id, project_id, user_id, role, scopes, granted_by, granted_at, expires_at
       FROM project_grants
      WHERE project_id = $1 AND user_id = $2
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1`,
    [projectId, userId],
  );
  return rows[0] || null;
}

/**
 * Загружает проект, к которому пользователь имеет доступ (как владелец
 * или через активный грант). Возвращает { project, access } или null.
 *
 * Безопасно подменяет старый `_loadOwned(id, userId)` в read-путях
 * контроллера проектов.
 */
async function loadAccessibleProject(projectId, userId, dbInstance = db) {
  if (!projectId || !userId) return null;
  const { rows } = await dbInstance.query(
    `SELECT p.*, (p.user_id = $2) AS is_owner
       FROM projects p
      WHERE p.id = $1
        AND (
              p.user_id = $2
           OR EXISTS (
                SELECT 1 FROM project_grants g
                 WHERE g.project_id = p.id AND g.user_id = $2
                   AND g.revoked_at IS NULL
                   AND (g.expires_at IS NULL OR g.expires_at > NOW())
              )
        )
      LIMIT 1`,
    [projectId, userId],
  );
  if (!rows.length) return null;
  const project = rows[0];
  if (project.is_owner) return { project, access: buildOwnerAccess() };
  const grant = await loadGrant(projectId, userId, dbInstance);
  if (!grant) return null;
  return { project, access: buildGrantAccess(grant) };
}

/**
 * Список проектов: собственные + расшаренные через активный грант.
 * Каждая строка содержит дополнительные поля access_role и access_scopes;
 * для собственных проектов access_role = 'owner'.
 *
 * columnsSql — список колонок (как PUBLIC_COLUMNS в projects.controller).
 */
async function listAccessibleProjects(userId, columnsSql, dbInstance = db) {
  if (!userId) return [];
  // Сначала собственные (полные сведения).
  const ownSql = `
    SELECT ${columnsSql},
           'owner' AS access_role,
           '["project","analyses","reports"]'::jsonb AS access_scopes,
           true AS access_is_owner
      FROM projects
     WHERE user_id = $1`;
  const grantedSql = `
    SELECT ${columnsSql},
           g.role  AS access_role,
           g.scopes AS access_scopes,
           false   AS access_is_owner
      FROM projects
      JOIN project_grants g ON g.project_id = projects.id
     WHERE g.user_id = $1
       AND g.revoked_at IS NULL
       AND (g.expires_at IS NULL OR g.expires_at > NOW())
       AND projects.user_id <> $1`;
  const { rows } = await dbInstance.query(
    `${ownSql} UNION ALL ${grantedSql} ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

/** Полный список грантов проекта (включая revoked — для аудита). */
async function listGrants(projectId, { includeRevoked = true } = {}, dbInstance = db) {
  const sql = `
    SELECT g.id, g.project_id, g.user_id, g.role, g.scopes,
           g.granted_by, g.granted_at, g.expires_at, g.revoked_at, g.revoked_by, g.note,
           u.email AS user_email, u.name AS user_name
      FROM project_grants g
      JOIN users u ON u.id = g.user_id
     WHERE g.project_id = $1
       ${includeRevoked ? '' : 'AND g.revoked_at IS NULL'}
     ORDER BY g.granted_at DESC`;
  const { rows } = await dbInstance.query(sql, [projectId]);
  return rows;
}

/**
 * Создаёт или переоткрывает грант. Если активный грант для (project,user)
 * уже есть — обновляет роль/scopes/срок. Если был revoked — добавляет новую
 * строку. Возвращает свежий грант + действие ('created' | 'updated').
 */
async function upsertGrant({ projectId, userId, role, scopes, grantedBy, expiresAt = null, note = null }, dbInstance = db) {
  const r = normalizeRole(role);
  const s = normalizeScopes(scopes) || [...DEFAULT_SCOPES];
  if (!r) throw new Error('invalid role');
  if (!projectId || !userId) throw new Error('projectId and userId required');

  // Запретим выдавать грант владельцу самому себе.
  const { rows: ownerRows } = await dbInstance.query(
    `SELECT user_id FROM projects WHERE id = $1`, [projectId],
  );
  if (!ownerRows.length) throw new Error('project not found');
  if (ownerRows[0].user_id === userId) throw new Error('cannot grant access to project owner');

  const existing = await loadGrant(projectId, userId, dbInstance);
  if (existing) {
    const { rows } = await dbInstance.query(
      `UPDATE project_grants
          SET role = $1, scopes = $2::jsonb, expires_at = $3, note = COALESCE($4, note)
        WHERE id = $5
        RETURNING *`,
      [r, JSON.stringify(s), expiresAt, note, existing.id],
    );
    await _writeEvent(dbInstance, {
      grantId: existing.id, projectId, userId, actorId: grantedBy,
      action: 'updated', payload: { role: r, scopes: s, expires_at: expiresAt },
    });
    return { grant: rows[0], action: 'updated' };
  }
  const { rows } = await dbInstance.query(
    `INSERT INTO project_grants (project_id, user_id, role, scopes, granted_by, expires_at, note)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
     RETURNING *`,
    [projectId, userId, r, JSON.stringify(s), grantedBy || null, expiresAt, note],
  );
  await _writeEvent(dbInstance, {
    grantId: rows[0].id, projectId, userId, actorId: grantedBy,
    action: 'created', payload: { role: r, scopes: s, expires_at: expiresAt },
  });
  return { grant: rows[0], action: 'created' };
}

/** Soft-revoke: проставляет revoked_at/revoked_by. */
async function revokeGrant(grantId, actorId, dbInstance = db) {
  const { rows } = await dbInstance.query(
    `UPDATE project_grants
        SET revoked_at = NOW(), revoked_by = $2
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING *`,
    [grantId, actorId || null],
  );
  if (!rows.length) return null;
  const g = rows[0];
  await _writeEvent(dbInstance, {
    grantId: g.id, projectId: g.project_id, userId: g.user_id, actorId,
    action: 'revoked', payload: null,
  });
  return g;
}

async function _writeEvent(dbInstance, { grantId, projectId, userId, actorId, action, payload }) {
  try {
    await dbInstance.query(
      `INSERT INTO project_grant_events (grant_id, project_id, user_id, actor_id, action, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [grantId || null, projectId, userId, actorId || null, action,
       payload != null ? JSON.stringify(payload) : null],
    );
  } catch (e) {
    // Аудит-лог не должен ломать основную операцию.
    // eslint-disable-next-line no-console
    console.warn('[projectGrants] event write failed:', e.message);
  }
}

module.exports = {
  ROLES, SCOPES, DEFAULT_SCOPES,
  normalizeRole, normalizeScopes,
  buildOwnerAccess, buildGrantAccess,
  canAct, forcedClientMode,
  loadGrant, loadAccessibleProject, listAccessibleProjects,
  listGrants, upsertGrant, revokeGrant,
};
