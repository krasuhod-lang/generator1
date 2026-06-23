'use strict';

/**
 * projects/freshnessService.js — управление свежестью данных внешних источников
 * (ТЗ §5.2). Сводит каждую успешную/упавшую синхронизацию проекта в одну
 * запись data_source_health и отдаёт UI-готовый статус.
 *
 * Источники нормализованы строкой `source`:
 *   'gsc' | 'yandex_webmaster' | 'keys_so' | 'backlinks'
 *
 * Статусы (ТЗ §5.2):
 *   'ok'      — sync свежий, период целый, источник догнал expected_max_date;
 *   'partial' — данные текущего незакрытого периода (не ошибка, но не headline);
 *   'stale'   — sync давно не обновлялся (см. freshness.staleAfterHours);
 *   'gap'     — sync проходит, но source_max_date отстаёт от expected_max_date;
 *   'error'   — последний sync упал или давно не было успешных.
 *
 * Безопасное API: graceful — при отсутствии таблицы (старый клон) функции
 * возвращают пустой массив / no-op, чтобы основной флоу аналитики продолжал
 * работать (см. ensureSchema в backend/server.js — таблица создаётся на старте).
 */

const pool = require('../../config/db');
const { getProjectsConfig } = require('./config');

const SUPPORTED_SOURCES = Object.freeze(['gsc', 'yandex_webmaster', 'keys_so', 'backlinks']);
const VALID_STATUSES = Object.freeze(['ok', 'partial', 'stale', 'gap', 'error']);

function _normalizeSource(source) {
  const s = String(source || '').trim().toLowerCase();
  if (!s) throw new Error('freshnessService: source required');
  // Допускаем алиасы.
  if (s === 'yandex' || s === 'ydx' || s === 'webmaster') return 'yandex_webmaster';
  if (s === 'keyso' || s === 'keys.so') return 'keys_so';
  return s;
}

function _isoDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string') return value.slice(0, 10);
  return null;
}

/**
 * Вычислить статус по уже сохранённой записи и текущему времени.
 * Используется и при записи (определяем статус сразу), и при чтении
 * (re-evaluate с учётом протёкшего времени без новых sync).
 */
function _computeStatus(record, now = new Date()) {
  if (!record) return 'error';
  const cfg = getProjectsConfig().periods.freshness;
  const lastSync = record.last_successful_sync_at
    ? new Date(record.last_successful_sync_at)
    : null;

  if (record.status === 'error' && !lastSync) return 'error';

  if (!lastSync) return 'error';
  const hours = (now - lastSync) / 3600000;
  if (hours > cfg.errorAfterHours) return 'error';
  if (hours > cfg.staleAfterHours) return 'stale';

  if (record.expected_max_date && record.source_max_date) {
    const exp = new Date(`${_isoDate(record.expected_max_date)}T00:00:00Z`);
    const src = new Date(`${_isoDate(record.source_max_date)}T00:00:00Z`);
    const gapDays = Math.round((exp - src) / 86400000);
    if (gapDays > cfg.gapDays) return 'gap';
  }

  if (record.is_partial_period) return 'partial';
  return 'ok';
}

/**
 * Зафиксировать успешный sync источника.
 *
 * @param {object} args
 * @param {number|string} args.projectId
 * @param {string}        args.source             — gsc | yandex_webmaster | keys_so | backlinks
 * @param {Date|string}   [args.sourceMaxDate]    — самая свежая дата с данными в источнике.
 * @param {Date|string}   [args.expectedMaxDate]  — какую дату мы ожидали (now - lagDays).
 * @param {number}        [args.rowsLastSync]     — кол-во строк, полученных за этот sync.
 * @param {boolean}       [args.isPartialPeriod]  — попал ли в окно текущий незакрытый месяц.
 * @param {object}        [args.meta]             — дополнительные данные (range, fromCache…).
 * @returns {Promise<{status:string}>}
 */
async function recordSyncSuccess(args) {
  if (!args || !args.projectId) return { status: 'error' };
  const projectId = String(args.projectId);
  if (!projectId) return { status: 'error' };
  const source = _normalizeSource(args.source);
  const record = {
    last_successful_sync_at: new Date(),
    source_max_date: _isoDate(args.sourceMaxDate),
    expected_max_date: _isoDate(args.expectedMaxDate),
    rows_last_sync: Number(args.rowsLastSync) || 0,
    is_partial_period: Boolean(args.isPartialPeriod),
    status: 'ok',
    last_error: null,
    meta: args.meta || null,
  };
  record.status = _computeStatus(record);
  try {
    await pool.query(
      `INSERT INTO data_source_health
         (project_id, source, last_successful_sync_at, source_max_date,
          expected_max_date, rows_last_sync, is_partial_period, status,
          last_error, meta, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9::jsonb, NOW())
       ON CONFLICT (project_id, source) DO UPDATE SET
         last_successful_sync_at = EXCLUDED.last_successful_sync_at,
         source_max_date         = EXCLUDED.source_max_date,
         expected_max_date       = EXCLUDED.expected_max_date,
         rows_last_sync          = EXCLUDED.rows_last_sync,
         is_partial_period       = EXCLUDED.is_partial_period,
         status                  = EXCLUDED.status,
         last_error              = NULL,
         meta                    = EXCLUDED.meta,
         updated_at              = NOW()`,
      [
        projectId, source,
        record.last_successful_sync_at,
        record.source_max_date, record.expected_max_date,
        record.rows_last_sync, record.is_partial_period, record.status,
        record.meta ? JSON.stringify(record.meta) : null,
      ]
    );
  } catch (e) {
    // graceful: таблица может ещё не существовать (миграция не применилась)
    // — не валим основной flow аналитики.
    if (process.env.NODE_ENV !== 'test') {
      // eslint-disable-next-line no-console
      console.warn('[freshnessService] recordSyncSuccess failed:', e.message);
    }
  }
  return { status: record.status };
}

/**
 * Зафиксировать упавший sync.
 */
async function recordSyncError(args) {
  if (!args || !args.projectId) return { status: 'error' };
  const projectId = String(args.projectId);
  if (!projectId) return { status: 'error' };
  const source = _normalizeSource(args.source);
  const message = String((args.error && args.error.message) || args.error || 'unknown')
    .slice(0, 2000);
  try {
    await pool.query(
      `INSERT INTO data_source_health
         (project_id, source, status, last_error, rows_last_sync, updated_at)
       VALUES ($1, $2, 'error', $3, 0, NOW())
       ON CONFLICT (project_id, source) DO UPDATE SET
         status     = 'error',
         last_error = EXCLUDED.last_error,
         updated_at = NOW()`,
      [projectId, source, message]
    );
  } catch (e) {
    if (process.env.NODE_ENV !== 'test') {
      // eslint-disable-next-line no-console
      console.warn('[freshnessService] recordSyncError failed:', e.message);
    }
  }
  return { status: 'error' };
}

/**
 * Полная картина свежести по проекту.
 * @returns {Promise<Array<object>>}
 */
async function getProjectFreshness(projectId) {
  const id = String(projectId || '').trim();
  if (!id) return [];
  try {
    const { rows } = await pool.query(
      `SELECT source, last_successful_sync_at, source_max_date, expected_max_date,
              rows_last_sync, is_partial_period, status, last_error, meta, updated_at
         FROM data_source_health
        WHERE project_id = $1
        ORDER BY source ASC`,
      [id]
    );
    const now = new Date();
    return rows.map((r) => {
      // re-evaluate status в момент чтения — sync может был ok, но протух.
      const reEvaluated = _computeStatus(r, now);
      return {
        source: r.source,
        status: reEvaluated,
        last_successful_sync_at: r.last_successful_sync_at,
        source_max_date: _isoDate(r.source_max_date),
        expected_max_date: _isoDate(r.expected_max_date),
        rows_last_sync: Number(r.rows_last_sync) || 0,
        is_partial_period: Boolean(r.is_partial_period),
        last_error: r.last_error || null,
        meta: r.meta || null,
        updated_at: r.updated_at,
      };
    });
  } catch (e) {
    if (process.env.NODE_ENV !== 'test') {
      // eslint-disable-next-line no-console
      console.warn('[freshnessService] getProjectFreshness failed:', e.message);
    }
    return [];
  }
}

module.exports = {
  recordSyncSuccess,
  recordSyncError,
  getProjectFreshness,
  // экспорт для тестов:
  _computeStatus,
  SUPPORTED_SOURCES,
  VALID_STATUSES,
};
