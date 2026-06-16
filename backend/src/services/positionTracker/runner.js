'use strict';

/**
 * positionTracker/runner.js
 *
 * Запускает «съём» позиций для проекта: создаёт строки в position_runs
 * (по одной на движок) и параллельно (с ограниченным concurrency) проходит
 * по активным ключевым запросам, опрашивая XMLStock через xmlstockSerp.
 * Результаты пишутся в position_results, прогресс — в position_runs.
 *
 * Идемпотентность: UNIQUE(run_id, keyword_id, engine) в position_results,
 * INSERT … ON CONFLICT DO NOTHING — повторный запуск раннера на том же
 * run_id не дублирует строки.
 */

const db = require('../../config/db');
const xmlstock = require('./xmlstockSerp');

const DEFAULT_CONCURRENCY = parseInt(process.env.POSITION_TRACKER_CONCURRENCY, 10) || 3;

function _engineList(engineCol) {
  if (engineCol === 'both') return ['yandex', 'google'];
  return [engineCol];
}

async function _loadProject(projectId) {
  const { rows } = await db.query(
    `SELECT id, user_id, name, domain, engine::text AS engine,
            geo_lr, geo_loc, device::text AS device
       FROM position_projects
      WHERE id = $1`,
    [projectId],
  );
  return rows[0] || null;
}

async function _loadActiveKeywords(projectId) {
  const { rows } = await db.query(
    `SELECT id, query, target_url
       FROM position_keywords
      WHERE project_id = $1 AND is_active = TRUE
      ORDER BY created_at ASC`,
    [projectId],
  );
  return rows;
}

async function _createRun(projectId, engine, total) {
  const { rows } = await db.query(
    `INSERT INTO position_runs (project_id, engine, status, keywords_total)
     VALUES ($1, $2, 'queued', $3)
     RETURNING id, project_id, engine, status::text AS status,
               keywords_total, keywords_done, started_at`,
    [projectId, engine, total],
  );
  return rows[0];
}

async function _markRunProcessing(runId) {
  await db.query(
    `UPDATE position_runs
        SET status = 'processing', started_at = NOW()
      WHERE id = $1`,
    [runId],
  );
}

async function _bumpDone(runId) {
  await db.query(
    `UPDATE position_runs SET keywords_done = keywords_done + 1 WHERE id = $1`,
    [runId],
  );
}

async function _finishRun(runId, status, errorMsg) {
  await db.query(
    `UPDATE position_runs
        SET status = $2, error = $3, finished_at = NOW()
      WHERE id = $1`,
    [runId, status, errorMsg || null],
  );
}

async function _saveResult(row) {
  await db.query(
    `INSERT INTO position_results
       (run_id, project_id, keyword_id, engine, position, found_url, serp_snippet)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (run_id, keyword_id, engine) DO NOTHING`,
    [
      row.run_id, row.project_id, row.keyword_id, row.engine,
      row.position, row.found_url, row.serp_snippet,
    ],
  );
}

/**
 * Параллельная обработка массива с ограниченным concurrency без зависимостей.
 */
async function _runWithConcurrency(items, limit, worker) {
  const results = [];
  let cursor = 0;
  const lim = Math.max(1, Math.min(limit, items.length));
  async function loop() {
    while (cursor < items.length) {
      const idx = cursor; cursor += 1;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (err) {
        results[idx] = { error: err };
      }
    }
  }
  const runners = [];
  for (let i = 0; i < lim; i += 1) runners.push(loop());
  await Promise.all(runners);
  return results;
}

async function _checkKeyword(engine, project, kw) {
  if (engine === 'yandex') {
    return xmlstock.fetchYandexPosition(kw.query, {
      domain: project.domain,
      lr: project.geo_lr || '',
    });
  }
  if (engine === 'google') {
    return xmlstock.fetchGooglePosition(kw.query, {
      domain: project.domain,
      loc: project.geo_loc || '',
      lr: project.geo_lr || '',
      device: project.device || '',
    });
  }
  throw new Error(`Unknown engine: ${engine}`);
}

/**
 * Запустить съём для проекта по всем активным ключам.
 *
 * @param {string} projectId
 * @param {object} [opts]
 * @param {string} [opts.engine]      — переопределить движок (yandex|google|both).
 * @param {number} [opts.concurrency] — ограничение параллелизма XMLStock-запросов.
 * @param {function} [opts.checkFn]   — для тестов: подмена xmlstock-вызова.
 * @returns {Promise<Array>} массив объектов { engine, run_id, ok, error, results }
 */
async function runPositionRun(projectId, opts = {}) {
  const project = await _loadProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const engines = _engineList(opts.engine || project.engine);
  const keywords = await _loadActiveKeywords(projectId);
  const concurrency = opts.concurrency || DEFAULT_CONCURRENCY;
  const checkFn = opts.checkFn || _checkKeyword;

  const summary = [];

  for (const engine of engines) {
    const run = await _createRun(projectId, engine, keywords.length);
    const runSummary = { engine, run_id: run.id, ok: 0, error: 0, results: [] };
    summary.push(runSummary);

    if (keywords.length === 0) {
      await _finishRun(run.id, 'done', null);
      continue;
    }

    await _markRunProcessing(run.id);

    try {
      const out = await _runWithConcurrency(keywords, concurrency, async (kw) => {
        try {
          const r = await checkFn(engine, project, kw);
          await _saveResult({
            run_id: run.id,
            project_id: projectId,
            keyword_id: kw.id,
            engine,
            position: r.position,
            found_url: r.foundUrl,
            serp_snippet: r.snippet,
          });
          await _bumpDone(run.id);
          return { keyword_id: kw.id, query: kw.query, position: r.position, foundUrl: r.foundUrl };
        } catch (err) {
          // одиночный сбой не валит весь run — просто помечаем «не найдено».
          await _saveResult({
            run_id: run.id,
            project_id: projectId,
            keyword_id: kw.id,
            engine,
            position: null,
            found_url: null,
            serp_snippet: `error: ${err.message || err}`.slice(0, 800),
          });
          await _bumpDone(run.id);
          return { keyword_id: kw.id, query: kw.query, position: null, error: err.message || String(err) };
        }
      });
      for (const r of out) {
        if (r && r.error) runSummary.error += 1; else runSummary.ok += 1;
        if (r) runSummary.results.push(r);
      }
      await _finishRun(run.id, 'done', null);
    } catch (err) {
      runSummary.error = keywords.length;
      await _finishRun(run.id, 'error', err.message || String(err));
    }
  }

  await db.query(
    `UPDATE position_projects SET last_run_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [projectId],
  );

  return summary;
}

/**
 * Перевести зависшие runs (processing >2h) в error при рестарте сервера.
 */
async function recoverStuckPositionRuns() {
  const { rowCount } = await db.query(
    `UPDATE position_runs
        SET status = 'error',
            error = COALESCE(error, 'Recovered from stuck state on restart'),
            finished_at = NOW()
      WHERE status IN ('queued', 'processing')
        AND started_at < NOW() - INTERVAL '2 hours'`,
  );
  if (rowCount > 0) {
    console.log(`[positionTracker] Recovered ${rowCount} stuck runs`);
  }
  return rowCount;
}

module.exports = {
  runPositionRun,
  recoverStuckPositionRuns,
  _runWithConcurrency,
};
