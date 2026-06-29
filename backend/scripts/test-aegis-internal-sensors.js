'use strict';

/**
 * Тесты для aegis/internalSensors.js (задача 2).
 *
 * Используем mock dbInstance (как в test-project-grants.js): query()
 * матчит SQL по нормализованному началу строки. Фича-флаг включаем через
 * переменную окружения ДО require.
 *
 * Запуск: node backend/scripts/test-aegis-internal-sensors.js
 */

process.env.AEGIS_BRAIN_INTERNAL_LEARNING = '1';

const assert = require('assert');
const sensors = require('../src/services/aegis/internalSensors');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { failed++; console.log(`  ✘ ${name}\n    ${e.message}`); }
}

function makeDb(handler) {
  return {
    queries: [],
    async query(sql, params) {
      this.queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return handler(sql.replace(/\s+/g, ' ').trim(), params) || { rows: [] };
    },
  };
}

const SAMPLE_SNAPSHOT = {
  kpi: { clicks: 1000, impressions: 50000, ctr: 0.02, position: 12.3 },
  action_plan: {
    recommendations: [
      { kind: 'striking_distance', expected_clicks_gain: 200, priority: 'high' },
      { kind: 'meta_rewrite',      expected_clicks_gain: 50,  priority: 'med'  },
    ],
    summary: { expected_clicks_total: 250, expected_traffic_uplift_pct: 25 },
  },
  insights: {
    intent_split:      { commercial: 0.4, info: 0.6 },
    striking_distance: [{ url: 'a' }, { url: 'b' }, { url: 'c' }],
  },
};

(async () => {
  console.log('internalSensors');

  await test('_enabled() = true (флаг выставлен через env)', () => {
    assert.strictEqual(sensors._enabled(), true);
  });

  await test('extractFeatures: KPI + action_plan_size + intent_split', () => {
    const f = sensors.extractFeatures(SAMPLE_SNAPSHOT);
    assert.strictEqual(f.kpi.clicks, 1000);
    assert.strictEqual(f.action_plan_size, 2);
    assert.strictEqual(f.striking_distance_count, 3);
    assert.ok(f.intent_split);
  });

  await test('extractFeatures: null/garbage → null', () => {
    assert.strictEqual(sensors.extractFeatures(null), null);
    assert.strictEqual(sensors.extractFeatures('abc'), null);
  });

  await test('extractRecommendation: компактный список без текста', () => {
    const r = sensors.extractRecommendation(SAMPLE_SNAPSHOT);
    assert.strictEqual(r.count, 2);
    assert.strictEqual(r.items[0].kind, 'striking_distance');
    assert.strictEqual(r.items[0].expected_clicks, 200);
  });

  await test('extractPredictedKpi: суммарный uplift', () => {
    const p = sensors.extractPredictedKpi(SAMPLE_SNAPSHOT);
    assert.strictEqual(p.expected_clicks, 250);
    assert.strictEqual(p.expected_traffic_uplift_pct, 25);
  });

  await test('recordAnalysisObservation: пишет в БД и возвращает id', async () => {
    const db = makeDb((sql, params) => {
      if (sql.startsWith('SELECT contribute_to_brain')) {
        return { rows: [{ contribute_to_brain: true }] };
      }
      if (sql.startsWith('INSERT INTO aegis_internal_observations')) {
        assert.strictEqual(params[0], 42); // projectId
        return { rows: [{ id: 7, taken_at: new Date('2026-01-01') }] };
      }
      return { rows: [] };
    });
    const res = await sensors.recordAnalysisObservation(
      { projectId: 42, analysisId: 100, snapshot: SAMPLE_SNAPSHOT, costUsd: 0.5 },
      db,
    );
    assert.strictEqual(res.id, 7);
    assert.strictEqual(res.skipped, false);
    assert.strictEqual(db.queries.length, 2);
  });

  await test('recordAnalysisObservation: opt-out проекта → skipped', async () => {
    const db = makeDb((sql) => {
      if (sql.startsWith('SELECT contribute_to_brain')) {
        return { rows: [{ contribute_to_brain: false }] };
      }
      throw new Error('INSERT не должен вызываться');
    });
    const res = await sensors.recordAnalysisObservation(
      { projectId: 1, snapshot: SAMPLE_SNAPSHOT }, db,
    );
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(res.reason, 'opted_out');
  });

  await test('recordAnalysisObservation: нет projectId → skipped без БД', async () => {
    const db = makeDb(() => { throw new Error('db не должна вызываться'); });
    const res = await sensors.recordAnalysisObservation({ projectId: null }, db);
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(res.reason, 'no_project');
  });

  await test('recordAnalysisObservation: проект не найден → skipped', async () => {
    const db = makeDb(() => ({ rows: [] }));
    const res = await sensors.recordAnalysisObservation(
      { projectId: 999, snapshot: SAMPLE_SNAPSHOT }, db,
    );
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(res.reason, 'project_not_found');
  });

  await test('recordAnalysisObservation: ошибка БД → skipped (не бросает)', async () => {
    const db = { async query() { throw new Error('boom'); } };
    const res = await sensors.recordAnalysisObservation(
      { projectId: 1, snapshot: SAMPLE_SNAPSHOT }, db,
    );
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(res.reason, 'error');
  });

  await test('updateObservationOutcome: считает reward + UPDATE', async () => {
    let updated = null;
    const db = makeDb((sql, params) => {
      if (sql.startsWith('SELECT id, features, predicted_kpi')) {
        return { rows: [{
          id: 7,
          features:      { kpi: { clicks: 1000, position: 12 } },
          predicted_kpi: { cost_usd: 0.5 },
        }] };
      }
      if (sql.startsWith('UPDATE aegis_internal_observations')) {
        updated = params;
        return { rows: [] };
      }
      return { rows: [] };
    });
    const fresh = { kpi: { clicks: 1500, position: 8 } };
    const res = await sensors.updateObservationOutcome(7, fresh, db);
    assert.strictEqual(res.id, 7);
    assert.ok(Number.isFinite(res.reward));
    assert.ok(res.reward > 0, 'клики выросли, позиция упала → +reward');
    assert.ok(updated, 'UPDATE должен быть вызван');
  });

  await test('updateObservationOutcome: observation не найден → skipped', async () => {
    const db = makeDb(() => ({ rows: [] }));
    const res = await sensors.updateObservationOutcome(404, {}, db);
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(res.reason, 'not_found');
  });

  await test('getBrainHealth: возвращает агрегаты', async () => {
    const db = makeDb((sql) => {
      assert.ok(sql.startsWith('SELECT COUNT(*)::int'));
      assert.ok(sql.includes("scope = 'internal_product'"));
      return { rows: [{ total: 12, with_outcome: 5, avg_reward: 0.3, latest_taken_at: new Date() }] };
    });
    const h = await sensors.getBrainHealth(db);
    assert.strictEqual(h.total, 12);
    assert.strictEqual(h.with_outcome, 5);
  });

  // Флаг ВЫКЛЮЧЕН: imitate cold start.
  await test('recordAnalysisObservation: при выключенном флаге → skipped без БД', async () => {
    // Подмена флага: monkey-patch _enabled через require cache не нужна,
    // просто проверим что delete env + reload модуля даёт skipped.
    delete require.cache[require.resolve('../src/services/aegis/internalSensors')];
    delete require.cache[require.resolve('../src/services/aegis/featureFlags')];
    delete process.env.AEGIS_BRAIN_INTERNAL_LEARNING;
    const s2 = require('../src/services/aegis/internalSensors');
    const db = { async query() { throw new Error('не должен вызываться'); } };
    const res = await s2.recordAnalysisObservation(
      { projectId: 1, snapshot: SAMPLE_SNAPSHOT }, db,
    );
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(res.reason, 'flag_off');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
