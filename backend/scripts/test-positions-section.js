'use strict';

/**
 * Smoke-tests for positions section helpers (ТЗ §1.5):
 *
 *  • computeTopsDistribution — pure: правильное распределение позиций по
 *    bucket'ам топов, обработка null/«не в топе».
 *  • buildSharedPositionsSection — через стаб db: возвращает null при
 *    отсутствии связанного position_projects; в client-режиме скрывает
 *    технические поля; ограничивает таблицу keywordsTable по
 *    sharedKeywordsLimit; формирует sane settings.
 *
 * Запуск:  node backend/scripts/test-positions-section.js
 */

const assert = require('assert');
const path = require('path');
const Module = require('module');

let passed = 0;
let failed = 0;
function test(name, fn) {
  const p = (async () => {
    try { await fn(); console.log(`✓ ${name}`); passed += 1; }
    catch (err) { console.error(`✗ ${name}\n  ${err.message}\n  ${err.stack}`); failed += 1; }
  })();
  return p;
}

// ── Pure computeTopsDistribution ───────────────────────────────────────
const { computeTopsDistribution } = require('../src/services/positionTracker/analytics');

(async () => {
  await test('computeTopsDistribution: simple buckets', () => {
    const out = computeTopsDistribution(
      [
        { position: 1 }, { position: 2 }, { position: 3 },     // top_3
        { position: 4 }, { position: 5 },                       // top_5
        { position: 7 }, { position: 9 }, { position: 10 },     // top_10
        { position: 15 },                                       // top_20
        { position: 99 },                                       // top_100
        { position: null }, { position: 0 }, {},                // not_top
      ],
      [3, 5, 10, 20, 50, 100],
    );
    const byLabel = Object.fromEntries(out.map((b) => [b.label, b.count]));
    assert.strictEqual(byLabel.top_3, 3);
    assert.strictEqual(byLabel.top_5, 2);
    assert.strictEqual(byLabel.top_10, 3);
    assert.strictEqual(byLabel.top_20, 1);
    assert.strictEqual(byLabel.top_50, 0);
    assert.strictEqual(byLabel.top_100, 1);
    assert.strictEqual(byLabel.not_top, 3);
  });

  await test('computeTopsDistribution: empty input', () => {
    const out = computeTopsDistribution([]);
    assert.ok(out.find((b) => b.label === 'top_3').count === 0);
    assert.ok(out.find((b) => b.label === 'not_top').count === 0);
  });

  await test('computeTopsDistribution: custom buckets sorted ascending', () => {
    const out = computeTopsDistribution(
      [{ position: 5 }, { position: 18 }],
      [20, 10, 5],
    );
    const labels = out.filter((b) => b.bucket != null).map((b) => b.label);
    assert.deepStrictEqual(labels, ['top_5', 'top_10', 'top_20']);
    assert.strictEqual(out.find((b) => b.label === 'top_5').count, 1);
    assert.strictEqual(out.find((b) => b.label === 'top_20').count, 1);
  });

  // ── buildSharedPositionsSection through db stub ────────────────────
  // Подменяем '../../config/db' для модуля sharedPositionsBuilder:
  const dbStub = { queryQueue: [], async query(sql, params) {
    const fn = this.queryQueue.shift();
    if (typeof fn !== 'function') throw new Error('no stub for: ' + sql.slice(0, 80));
    return fn(sql, params);
  }};
  const analyticsStub = {
    getProjectSummary: async () => ({ total_keywords: 12, average_position: 17.5, top_10_share: 0.42 }),
    getProjectSeries: async () => [
      { date: '2026-06-01', avg_position: 18 },
      { date: '2026-06-08', avg_position: 17 },
    ],
    getTopsDistribution: async () => ({
      buckets: [3, 5, 10],
      current:  [{ bucket: 3, label: 'top_3', count: 2 }, { bucket: 10, label: 'top_10', count: 5 }],
      previous: [{ bucket: 3, label: 'top_3', count: 1 }, { bucket: 10, label: 'top_10', count: 4 }],
      deltas:   [{ label: 'top_3', delta: 1 }, { label: 'top_10', delta: 1 }],
      total_keywords: 12,
      period_days: 7,
    }),
    getKeywordsTable: async () => {
      // 60 ключей — чтобы проверить срез по sharedKeywordsLimit=50.
      return Array.from({ length: 60 }, (_, i) => ({
        keyword_id: `kw-${i}`,
        query: `query ${i}`,
        position: i % 30 + 1,
        prev_position: i % 30 + 2,
        delta: -1,
        direction: 'up',
        target_url: 'https://example.com/page',
        tags: ['internal-tag'],
        engine: 'yandex',
        checked_at: '2026-06-26',
        found_url: 'https://example.com/found',
      }));
    },
  };
  const realResolve = Module._resolveFilename;
  const realLoad = Module._load;
  const builderPath = require.resolve('../src/services/projects/sharedPositionsBuilder');
  const dbPath = require.resolve('../src/config/db');
  const analyticsPath = require.resolve('../src/services/positionTracker/analytics');
  // Чистим кэш на случай повторных загрузок.
  delete require.cache[builderPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbStub };
  require.cache[analyticsPath] = { id: analyticsPath, filename: analyticsPath, loaded: true, exports: analyticsStub };
  const { buildSharedPositionsSection } = require('../src/services/projects/sharedPositionsBuilder');

  await test('buildSharedPositionsSection: no linked position_projects → null', async () => {
    dbStub.queryQueue.push(() => ({ rows: [] }));
    const res = await buildSharedPositionsSection('seo-proj-1', 'client', {});
    assert.strictEqual(res, null);
  });

  await test('buildSharedPositionsSection: client mode strips internal keyword fields and truncates to 50', async () => {
    // 1) linked lookup
    dbStub.queryQueue.push(() => ({ rows: [{
      id: 'pos-proj-1', engine: 'yandex', geo_lr: '213', geo_loc: '',
      device: 'desktop', schedule: 'daily', last_run_at: null,
    }] }));
    // 2) hasRows check
    dbStub.queryQueue.push(() => ({ rows: [{ '?column?': 1 }] }));
    // 3) last_run query (analytics calls are stubbed; this only is the final db call inside builder)
    dbStub.queryQueue.push(() => ({ rows: [{
      id: 'run-1', engine: 'yandex', status: 'finished', error: null,
      keywords_total: 60, keywords_done: 60,
      started_at: '2026-06-26T08:00:00Z', finished_at: '2026-06-26T08:10:00Z',
    }] }));

    const res = await buildSharedPositionsSection('seo-proj-1', 'client', { period: 'week' });
    assert.ok(res, 'result not null');
    assert.strictEqual(res.enabled, true);
    assert.strictEqual(res.has_data, true);
    assert.strictEqual(res.settings.engine, 'yandex');
    assert.strictEqual(res.settings.geo_lr, '213');
    // Должно быть ровно 50 строк (sharedKeywordsLimit default).
    assert.strictEqual(res.keywords_table.length, 50, `got ${res.keywords_table.length}`);
    assert.ok(res.keywords_truncated, 'truncated flag set');
    assert.strictEqual(res.keywords_truncated.total, 60);
    // Сортировка по position ASC → первая строка с position=1.
    assert.strictEqual(res.keywords_table[0].position, 1);
    // Client mode НЕ содержит keyword_id / target_url / tags / engine / checked_at.
    const k = res.keywords_table[0];
    assert.strictEqual(k.keyword_id, undefined, `keyword_id leaked: ${k.keyword_id}`);
    assert.strictEqual(k.target_url, undefined);
    assert.strictEqual(k.tags, undefined);
    assert.strictEqual(k.engine, undefined);
    assert.strictEqual(k.checked_at, undefined);
    // Должны остаться публичные поля.
    assert.strictEqual(k.query, 'query 0');
    assert.ok('position' in k);
    assert.ok('delta' in k);
    // position_project_id скрыт в client-режиме.
    assert.strictEqual(res.position_project_id, undefined);
    // last_run — без id и error в client-режиме.
    assert.strictEqual(res.last_run.id, undefined);
    assert.strictEqual(res.last_run.error, undefined);
    assert.strictEqual(res.last_run.status, 'finished');
  });

  await test('buildSharedPositionsSection: analyst mode keeps internal keyword fields', async () => {
    dbStub.queryQueue.push(() => ({ rows: [{
      id: 'pos-proj-1', engine: 'yandex', geo_lr: '213', geo_loc: '',
      device: 'desktop', schedule: 'daily', last_run_at: null,
    }] }));
    dbStub.queryQueue.push(() => ({ rows: [{ '?column?': 1 }] }));
    dbStub.queryQueue.push(() => ({ rows: [{
      id: 'run-1', engine: 'yandex', status: 'finished', error: null,
      keywords_total: 60, keywords_done: 60,
      started_at: '2026-06-26T08:00:00Z', finished_at: '2026-06-26T08:10:00Z',
    }] }));

    const res = await buildSharedPositionsSection('seo-proj-1', 'analyst', { period: 'week' });
    assert.strictEqual(res.position_project_id, 'pos-proj-1');
    const k = res.keywords_table[0];
    assert.ok(k.keyword_id, 'analyst should expose keyword_id');
    assert.ok(k.target_url, 'analyst should expose target_url');
    assert.strictEqual(k.engine, 'yandex');
    assert.ok(res.last_run.id, 'analyst should expose run id');
  });

  await test('buildSharedPositionsSection: empty parentProjectId → null', async () => {
    const res = await buildSharedPositionsSection('', 'client', {});
    assert.strictEqual(res, null);
  });

  await test('buildSharedPositionsSection: has_data=false when no position_results', async () => {
    dbStub.queryQueue.push(() => ({ rows: [{
      id: 'pos-proj-2', engine: 'google', geo_lr: '', geo_loc: 'US-NY',
      device: 'mobile', schedule: 'weekly', last_run_at: null,
    }] }));
    dbStub.queryQueue.push(() => ({ rows: [] })); // no results yet
    const res = await buildSharedPositionsSection('seo-proj-2', 'client', {});
    assert.strictEqual(res.enabled, true);
    assert.strictEqual(res.has_data, false);
    assert.strictEqual(res.settings.engine, 'google');
    assert.strictEqual(res.settings.geo_loc, 'US-NY');
    // Без summary/series/keywords_table.
    assert.strictEqual(res.summary, undefined);
    assert.strictEqual(res.keywords_table, undefined);
  });

  // Restore module overrides.
  Module._resolveFilename = realResolve;
  Module._load = realLoad;

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
