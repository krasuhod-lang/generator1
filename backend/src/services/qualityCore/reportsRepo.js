'use strict';

/**
 * qualityCore/reportsRepo — read-side журнала quality_gate_reports (V1, Фаза 2).
 *
 * Фаза 1 создала таблицу quality_gate_reports и qualityGate.persistReport()
 * (write-side), но не дала способа её прочитать. Здесь — выборка журнала
 * решений gate по задаче любого пайплайна (seo|link|info) для админ-UI/логов.
 */

const PIPELINES = Object.freeze(['seo', 'link', 'info']);

function _db(db) { return db || require('../../config/db'); }

/**
 * listReports — строки журнала gate с опциональными фильтрами.
 * @param {object} [opts] — { pipeline, taskId, limit, db }
 * @returns {Promise<object[]>}
 */
async function listReports(opts = {}) {
  const db = _db(opts.db);
  const where = [];
  const params = [];
  if (opts.pipeline) {
    if (!PIPELINES.includes(String(opts.pipeline))) {
      const e = new Error('invalid_pipeline'); e.status = 400; e.code = 'invalid_pipeline'; throw e;
    }
    params.push(String(opts.pipeline)); where.push(`pipeline_type = $${params.length}`);
  }
  if (opts.taskId != null && opts.taskId !== '') {
    const tid = Number(opts.taskId);
    if (!Number.isInteger(tid)) { const e = new Error('invalid_task_id'); e.status = 400; e.code = 'invalid_task_id'; throw e; }
    params.push(tid); where.push(`task_id = $${params.length}`);
  }
  const limit = Math.min(2000, Math.max(1, Number(opts.limit) || 500));
  const sql =
    `SELECT id, pipeline_type, task_id, gate_name, pass, blocking, score, evidence, created_at
       FROM quality_gate_reports
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY pipeline_type, task_id DESC, gate_name
      LIMIT ${limit}`;
  const { rows } = await db.query(sql, params);
  return rows;
}

/**
 * summarizeForTask — свернуть журнал одной задачи в вердикт publish/blockers.
 * Полезно для быстрой отметки «эта статья прошла gate» в списках.
 * @param {object} params — { pipeline, taskId, db }
 * @returns {Promise<{ canPublish:boolean, blockers:string[], warnings:string[], total:number }>}
 */
async function summarizeForTask({ pipeline, taskId, db } = {}) {
  const rows = await listReports({ pipeline, taskId, db });
  const blockers = [];
  const warnings = [];
  for (const r of rows) {
    if (r.pass) continue;
    if (r.blocking) blockers.push(r.gate_name);
    else warnings.push(r.gate_name);
  }
  return { canPublish: blockers.length === 0, blockers, warnings, total: rows.length };
}

module.exports = { PIPELINES, listReports, summarizeForTask };
