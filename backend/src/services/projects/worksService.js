'use strict';

/**
 * projects/worksService.js — Works Log Module (PR-5 эпика
 * premium-ui-and-client-mode-implementation).
 *
 * Хранилище: таблица `project_works` (миграция 082_project_works.sql).
 * Контракт ТЗ §6.5:
 *   • в Analyst Mode возвращаются все поля (description, impact, links);
 *   • в Client Mode возвращаются только `client_summary`, заголовок,
 *     дата и тип; работы со статусом 'planned' скрыты от клиента.
 *
 * Модуль чистый: ввод/вывод — JS-объекты; БД работа через переданный `db`
 * (либо через локальный require('../../db'), как у других сервисов проекта).
 */

const db = require('../../config/db');

const VALID_STATUSES = Object.freeze(['planned', 'in_progress', 'done']);
const DEFAULT_STATUS = 'done';

const ALL_FIELDS = Object.freeze([
  'id', 'project_id', 'performed_at', 'type', 'status',
  'title', 'description', 'client_summary', 'impact', 'links',
  'client_visible',
  'created_at', 'updated_at',
]);

// Технические поля, которые НЕ показываются клиенту (PR-2 view-mode принцип).
const CLIENT_HIDDEN_FIELDS = Object.freeze(['description', 'impact', 'client_visible']);

function _isValidStatus(s) {
  return VALID_STATUSES.includes(s);
}

function _normalizeType(t) {
  if (typeof t !== 'string') return 'other';
  const v = t.trim().toLowerCase();
  return v || 'other';
}

function _normalizeStatus(s) {
  return _isValidStatus(s) ? s : DEFAULT_STATUS;
}

function _coerceDate(v) {
  if (!v) return new Date();
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : new Date();
}

/**
 * Санитизация одной записи под режим просмотра.
 * mode === 'client' → срезаем технические поля; в title не лезем —
 * предполагается, что SEO-специалист пишет title нейтрально.
 */
function sanitizeWorkForMode(row, mode) {
  if (!row || typeof row !== 'object') return row;
  if (mode !== 'client') return row;
  const out = { ...row };
  for (const field of CLIENT_HIDDEN_FIELDS) {
    delete out[field];
  }
  // Если client_summary пустой — используем title как fallback,
  // чтобы клиент всегда видел осмысленную строку.
  if (!out.client_summary) {
    out.client_summary = out.title || '';
  }
  return out;
}

/**
 * Список работ проекта. Сортировка — по performed_at DESC (последние сверху).
 *
 * opts:
 *   • mode    — 'analyst' | 'client'; при 'client' прячем 'planned' работы
 *               и режем технические поля.
 *   • status  — фильтр по статусу (опционально).
 *   • limit   — ограничение (по умолчанию 200).
 */
async function listWorks(projectId, opts = {}) {
  const mode = opts.mode === 'client' ? 'client' : 'analyst';
  const limit = Math.max(1, Math.min(500, Number(opts.limit || 200)));
  const params = [projectId];
  const wheres = ['project_id = $1'];
  if (opts.status && _isValidStatus(opts.status)) {
    params.push(opts.status);
    wheres.push(`status = $${params.length}`);
  }
  if (mode === 'client') {
    wheres.push(`status <> 'planned'`);
    // 083_works_client_visible: клиент видит только записи, явно
    // помеченные как видимые. Дефолт колонки TRUE, поэтому существующие
    // работы продолжают показываться без миграции данных.
    wheres.push(`client_visible IS TRUE`);
  }
  const { rows } = await db.query(
    `SELECT ${ALL_FIELDS.join(', ')}
       FROM project_works
      WHERE ${wheres.join(' AND ')}
      ORDER BY performed_at DESC, created_at DESC
      LIMIT ${limit}`,
    params,
  );
  return rows.map((r) => sanitizeWorkForMode(r, mode));
}

/**
 * Создание записи о работе.
 *
 * input: { performed_at?, type?, status?, title*, description?, client_summary?, impact?, links? }
 * Возвращает созданную строку (в режиме «аналитик»).
 */
async function createWork(projectId, input = {}, opts = {}) {
  const title = String(input.title || '').trim();
  if (!title) {
    const e = new Error('worksService.createWork: title required');
    e.code = 'INVALID_INPUT';
    throw e;
  }
  const performedAt = _coerceDate(input.performed_at).toISOString();
  const type = _normalizeType(input.type);
  const status = _normalizeStatus(input.status);
  const description = input.description ? String(input.description) : null;
  const clientSummary = input.client_summary ? String(input.client_summary) : null;
  const impact = input.impact && typeof input.impact === 'object' ? input.impact : null;
  const links = Array.isArray(input.links) ? input.links : null;
  // 083_works_client_visible: дефолт TRUE — обратная совместимость; явный
  // false возможен только когда специалист сознательно скрывает работу.
  const clientVisible = input.client_visible === false ? false : true;
  const createdBy = opts.userId || null;

  const { rows } = await db.query(
    `INSERT INTO project_works
       (project_id, performed_at, type, status, title, description, client_summary, impact, links, client_visible, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)
     RETURNING ${ALL_FIELDS.join(', ')}`,
    [
      projectId,
      performedAt,
      type,
      status,
      title,
      description,
      clientSummary,
      impact ? JSON.stringify(impact) : null,
      links ? JSON.stringify(links) : null,
      clientVisible,
      createdBy,
    ],
  );
  return rows[0] || null;
}

/**
 * Обновление записи. patch — частичный объект тех же полей, что в createWork.
 * Возвращает обновлённую строку или null, если не найдено.
 */
async function updateWork(projectId, workId, patch = {}) {
  if (!patch || typeof patch !== 'object') patch = {};
  const sets = [];
  const params = [projectId, workId];

  function push(sql, value) {
    params.push(value);
    sets.push(`${sql} = $${params.length}`);
  }

  if (patch.title !== undefined)          push('title', String(patch.title || '').trim() || 'Без названия');
  if (patch.performed_at !== undefined)   push('performed_at', _coerceDate(patch.performed_at).toISOString());
  if (patch.type !== undefined)           push('type', _normalizeType(patch.type));
  if (patch.status !== undefined)         push('status', _normalizeStatus(patch.status));
  if (patch.description !== undefined)    push('description', patch.description ? String(patch.description) : null);
  if (patch.client_summary !== undefined) push('client_summary', patch.client_summary ? String(patch.client_summary) : null);
  if (patch.impact !== undefined)         push('impact::jsonb',
    patch.impact && typeof patch.impact === 'object' ? JSON.stringify(patch.impact) : null);
  if (patch.links !== undefined)          push('links::jsonb',
    Array.isArray(patch.links) ? JSON.stringify(patch.links) : null);
  if (patch.client_visible !== undefined) push('client_visible', patch.client_visible === false ? false : true);

  if (!sets.length) {
    // Ничего не меняли — вернём текущую запись для идемпотентности.
    const { rows } = await db.query(
      `SELECT ${ALL_FIELDS.join(', ')} FROM project_works WHERE id = $2 AND project_id = $1`,
      params,
    );
    return rows[0] || null;
  }
  sets.push(`updated_at = NOW()`);

  const { rows } = await db.query(
    `UPDATE project_works
        SET ${sets.join(', ')}
      WHERE id = $2 AND project_id = $1
      RETURNING ${ALL_FIELDS.join(', ')}`,
    params,
  );
  return rows[0] || null;
}

async function deleteWork(projectId, workId) {
  const { rowCount } = await db.query(
    `DELETE FROM project_works WHERE id = $2 AND project_id = $1`,
    [projectId, workId],
  );
  return rowCount > 0;
}

module.exports = {
  listWorks,
  createWork,
  updateWork,
  deleteWork,
  sanitizeWorkForMode,
  VALID_STATUSES,
};
