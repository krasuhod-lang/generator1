'use strict';

/**
 * cannibalization/runner.js — оркестрация фоновой задачи сканера
 * каннибализации (по образцу analysisRunner/positionTracker/runner).
 *
 *   queued → running → (snap H1 → collect SERP → analyze → [AI]) → done|error
 *
 * Прогресс и метрики пишутся в cannibalization_tasks.stats; итог — в .result.
 * Отмена (status='cancelled') проверяется между запросами через shouldStop.
 */

const db           = require('../../config/db');
const queriesSvc   = require('./queries');
const serpCollector= require('./serpCollector');
const analyzer     = require('./analyzer');
const aiExplainer  = require('./aiExplainer');

async function _setStats(taskId, stats) {
  await db.query(
    `UPDATE cannibalization_tasks SET stats = $2::jsonb WHERE id = $1`,
    [taskId, JSON.stringify(stats || {})],
  );
}

async function _isCancelled(taskId) {
  const { rows } = await db.query(
    `SELECT status FROM cannibalization_tasks WHERE id = $1`, [taskId],
  );
  return !rows.length || rows[0].status === 'cancelled';
}

async function runTask({ taskId }) {
  const { rows } = await db.query(
    `SELECT id, crawl_task_id, lr, engine, options
       FROM cannibalization_tasks WHERE id = $1`, [taskId],
  );
  if (!rows.length) throw new Error('task_not_found');
  const task = rows[0];
  const opts = task.options || {};
  const engine = task.engine === 'google' ? 'google' : 'yandex';
  const topN          = Math.max(1, Number(opts.topN) || 10);
  const minCommonUrls = Math.max(1, Number(opts.minCommonUrls) || 4);
  const maxQueries    = Math.max(1, Number(opts.maxQueries) || 300);
  const useAI         = !!opts.useAI;

  await db.query(
    `UPDATE cannibalization_tasks SET status='running', started_at=NOW() WHERE id=$1`,
    [taskId],
  );

  // 1) Собираем запросы из H1 краулера.
  const { queries, skipped, duplicates, truncated } =
    await queriesSvc.loadQueriesFromCrawl(task.crawl_task_id, { maxQueries });
  if (!queries.length) {
    throw new Error('Нет пригодных H1 для проверки (запустите краулер и убедитесь, что H1 собраны).');
  }

  // Определяем «свой домен» из первого source_url — для доп. сигнала.
  let ownDomain = null;
  for (const q of queries) { if (q.source_url) { ownDomain = q.source_url; break; } }

  const baseStats = {
    phase: 'collecting', total: queries.length, done: 0,
    skipped, duplicates, truncated, engine, lr: task.lr || null,
    minCommonUrls, topN, errors: 0,
  };
  await _setStats(taskId, baseStats);

  // 2) Снимаем выдачу.
  const { collected, errors } = await serpCollector.collect(taskId, queries, {
    engine, lr: task.lr || '', topN,
    shouldStop: () => _isCancelled(taskId),
    onProgress: async (done) => {
      try { await _setStats(taskId, { ...baseStats, done, errors: errors ? errors.length : 0 }); }
      catch (_) { /* no-op */ }
    },
  });

  if (await _isCancelled(taskId)) return;

  // 3) Анализируем.
  await _setStats(taskId, { ...baseStats, phase: 'analyzing', done: queries.length,
    errors: errors.length });
  const report = analyzer.buildReport(collected, { minCommonUrls, topN, engine, lr: task.lr, ownDomain });
  report.collectErrors = errors;

  // 4) Опциональный AI-вердикт.
  if (useAI && report.clusters.length) {
    try {
      await _setStats(taskId, { ...baseStats, phase: 'ai', done: queries.length, errors: errors.length });
      const ai = await aiExplainer.explain(report.clusters);
      if (ai) report.ai = ai;
    } catch (_) { /* AI необязателен */ }
  }

  await db.query(
    `UPDATE cannibalization_tasks
        SET status='done', result=$2::jsonb, finished_at=NOW(),
            stats = stats || $3::jsonb
      WHERE id=$1 AND status <> 'cancelled'`,
    [taskId, JSON.stringify(report), JSON.stringify({ phase: 'done', errors: errors.length })],
  );
}

module.exports = { runTask };
