#!/usr/bin/env node
'use strict';

/**
 * Smoke-tests for aegis/experimentLoop (B4) — pure functions:
 *   binaryEntropy, uncertaintyFromConfidence, strikingDistanceScore,
 *   composeUncertainty, computeExperimentReward, classifyOutcome.
 * Не требует БД и сети.
 */

const assert = require('assert');
const exp = require('../src/services/aegis/experimentLoop');

let passed = 0, failed = 0;
const _pending = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      _pending.push(r.then(
        () => { console.log(`✅ ${name}`); passed++; },
        (e) => { console.error(`❌ ${name}\n   ${e.message}`); failed++; }
      ));
      return;
    }
    console.log(`✅ ${name}`); passed++;
  }
  catch (e) { console.error(`❌ ${name}\n   ${e.message}`); failed++; }
}

// ── binaryEntropy ─────────────────────────────────────────────────────
test('binaryEntropy: max at p=0.5', () => {
  assert.strictEqual(exp.binaryEntropy(0.5), 1);
});
test('binaryEntropy: zero at extremes', () => {
  assert.strictEqual(exp.binaryEntropy(0), 0);
  assert.strictEqual(exp.binaryEntropy(1), 0);
});
test('binaryEntropy: clamps out-of-range', () => {
  assert.strictEqual(exp.binaryEntropy(-1), 0);
  assert.strictEqual(exp.binaryEntropy(2), 0);
});
test('binaryEntropy: symmetric', () => {
  assert.strictEqual(exp.binaryEntropy(0.3), exp.binaryEntropy(0.7));
});

// ── uncertaintyFromConfidence ─────────────────────────────────────────
test('uncertaintyFromConfidence: confidence=1 → 0', () => {
  assert.strictEqual(exp.uncertaintyFromConfidence(1), 0);
});
test('uncertaintyFromConfidence: confidence=0 → 1', () => {
  assert.strictEqual(exp.uncertaintyFromConfidence(0), 1);
});
test('uncertaintyFromConfidence: missing → 0.5 (neutral)', () => {
  assert.strictEqual(exp.uncertaintyFromConfidence(null), 0.5);
  assert.strictEqual(exp.uncertaintyFromConfidence(undefined), 0.5);
  assert.strictEqual(exp.uncertaintyFromConfidence('x'), 0.5);
});

// ── strikingDistanceScore ─────────────────────────────────────────────
test('strikingDistance: peak at 11..20', () => {
  const peak = exp.strikingDistanceScore(15);
  assert.ok(peak === 1.0);
  assert.ok(exp.strikingDistanceScore(2) < peak);
  assert.ok(exp.strikingDistanceScore(60) < peak);
});
test('strikingDistance: invalid → 0', () => {
  assert.strictEqual(exp.strikingDistanceScore(null), 0);
  assert.strictEqual(exp.strikingDistanceScore(0), 0);
  assert.strictEqual(exp.strikingDistanceScore(-3), 0);
});

// ── composeUncertainty ────────────────────────────────────────────────
test('composeUncertainty: striking-distance dominates when biobrain neutral', () => {
  const high = exp.composeUncertainty({ confidence: null, position: 15, priority: 0 });
  const low  = exp.composeUncertainty({ confidence: null, position: 1,  priority: 0 });
  assert.ok(high > low, `${high} should be > ${low}`);
});
test('composeUncertainty: bounded [0,1]', () => {
  const r = exp.composeUncertainty({ confidence: 0, position: 15, priority: 100 });
  assert.ok(r >= 0 && r <= 1, `out of range: ${r}`);
});
test('composeUncertainty: high priority lifts score', () => {
  const a = exp.composeUncertainty({ confidence: 0.5, position: 5, priority: 0 });
  const b = exp.composeUncertainty({ confidence: 0.5, position: 5, priority: 9 });
  assert.ok(b > a);
});

// ── computeExperimentReward ───────────────────────────────────────────
test('reward: pos 20→3 + clicks gain → high', () => {
  const r = exp.computeExperimentReward({ baselinePosition: 20, postPosition: 3, deltaClicks: 50 });
  assert.ok(r > 0.7, `reward too low: ${r}`);
});
test('reward: pos 5→25 (deteriorated) → low', () => {
  const r = exp.computeExperimentReward({ baselinePosition: 5, postPosition: 25, deltaClicks: -10 });
  assert.ok(r < 0.4, `reward too high: ${r}`);
});
test('reward: missing post → finite, 0..1', () => {
  const r = exp.computeExperimentReward({ baselinePosition: 10 });
  assert.ok(Number.isFinite(r) && r >= 0 && r <= 1);
});

// ── classifyOutcome ──────────────────────────────────────────────────
test('outcome: position improved & high reward → won', () => {
  assert.strictEqual(exp.classifyOutcome({ reward: 0.8, deltaPosition: -5 }), 'won');
});
test('outcome: position worsened → lost', () => {
  assert.strictEqual(exp.classifyOutcome({ reward: 0.5, deltaPosition: +3 }), 'lost');
});
test('outcome: very low reward → lost', () => {
  assert.strictEqual(exp.classifyOutcome({ reward: 0.1, deltaPosition: -1 }), 'lost');
});
test('outcome: small movement → inconclusive', () => {
  assert.strictEqual(exp.classifyOutcome({ reward: 0.4, deltaPosition: -0.2 }), 'inconclusive');
});
test('outcome: nulls → inconclusive', () => {
  assert.strictEqual(exp.classifyOutcome({}), 'inconclusive');
});

// ── closeStaleExperiments + runOnce wiring ────────────────────────────
// Используем in-memory mock db.query для проверки SQL-вызова и stats.
function mockDb(handlers) {
  return {
    calls: [],
    async query(sql, params) {
      this.calls.push({ sql, params });
      for (const [pattern, handler] of handlers) {
        if (pattern.test(sql)) return handler(sql, params);
      }
      return { rows: [] };
    },
  };
}

test('closeStaleExperiments: db_not_wired without db', async () => {
  const r = await exp.closeStaleExperiments(null);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'db_not_wired');
  assert.strictEqual(r.closed, 0);
});

test('closeStaleExperiments: passes measureAfterDays+staleGraceDays as TTL', async () => {
  const db = mockDb([
    [/UPDATE aegis_experiments[\s\S]+SET status\s*=\s*'measured'/i,
      () => ({ rows: [{ id: 1 }, { id: 2 }] })],
  ]);
  const r = await exp.closeStaleExperiments(db);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.closed, 2);
  // ttl param = measureAfterDays(14) + staleGraceDays(7) = 21
  assert.deepStrictEqual(db.calls[0].params, [21]);
  // Должен фильтровать только planned/dispatched
  assert.match(db.calls[0].sql, /status\s+IN\s*\(\s*'planned'\s*,\s*'dispatched'\s*\)/i);
  // И сравнивать по COALESCE(dispatched_at, planned_at)
  assert.match(db.calls[0].sql, /COALESCE\(\s*dispatched_at\s*,\s*planned_at\s*\)/i);
});

test('runOnce: returns picked/planned/dispatched/stale_closed/in_progress', async () => {
  const db = mockDb([
    // closeStaleExperiments
    [/UPDATE aegis_experiments[\s\S]+SET status\s*=\s*'measured'/i,
      () => ({ rows: [] })],
    // orphan-dispatch sweep (autoDispatch=true) — none pending
    [/SELECT id FROM aegis_experiments[\s\S]+status\s*=\s*'planned'/i,
      () => ({ rows: [] })],
    // _loadCandidates
    [/FROM aegis_seo_actions/i,
      () => ({ rows: [] })],
    // _countInProgress
    [/SUM\(CASE WHEN status='planned'/i,
      () => ({ rows: [{ planned: 5, dispatched: 2 }] })],
  ]);
  const r = await exp.runOnce(db);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.picked, 0);
  assert.strictEqual(r.planned, 0);
  assert.strictEqual(r.dispatched, 0);
  assert.strictEqual(r.stale_closed, 0);
  assert.strictEqual(r.orphan_dispatched, 0);
  assert.deepStrictEqual(r.in_progress, { planned: 5, dispatched: 2 });
});

test('runOnce: orphan-dispatch sweeps pre-existing planned rows when autoDispatch=true', async () => {
  // Имитируем 3 «осиротевшие» planned-записи (как в реальной админ-панели:
  // planned=38 до того, как заработал autoDispatch). runOnce должен
  // перевести их в 'dispatched', чтобы measure-таймер стартовал и
  // WHERE NOT EXISTS разблокировал новые URL.
  const orphans = [{ id: 'o1' }, { id: 'o2' }, { id: 'o3' }];
  const db = mockDb([
    [/UPDATE aegis_experiments[\s\S]+SET status\s*=\s*'measured'/i,
      () => ({ rows: [] })],
    // orphan list
    [/SELECT id FROM aegis_experiments[\s\S]+status\s*=\s*'planned'/i,
      () => ({ rows: orphans })],
    // dispatchExperiment SELECT — статус 'planned', чтобы дойти до UPDATE
    [/SELECT id, site_key, target_url, queries, hypothesis, status[\s\S]+aegis_experiments WHERE id/i,
      (_sql, params) => ({ rows: [{
        id: params[0], site_key: 'site', target_url: '/u',
        queries: [], hypothesis: [], status: 'planned',
      }] })],
    // dispatchExperiment UPDATE
    [/UPDATE aegis_experiments[\s\S]+SET status\s*=\s*'dispatched'/i,
      () => ({ rows: [] })],
    [/FROM aegis_seo_actions/i, () => ({ rows: [] })],
    [/SUM\(CASE WHEN status='planned'/i,
      () => ({ rows: [{ planned: 0, dispatched: 3 }] })],
  ]);
  const r = await exp.runOnce(db);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.orphan_dispatched, 3);
  // SELECT по 'planned' должен идти ДО _loadCandidates — иначе
  // WHERE NOT EXISTS отфильтрует кандидатов.
  const orphanIdx = db.calls.findIndex((c) =>
    /SELECT id FROM aegis_experiments[\s\S]+status\s*=\s*'planned'/i.test(c.sql));
  const loadIdx = db.calls.findIndex((c) => /FROM aegis_seo_actions/i.test(c.sql));
  assert.ok(orphanIdx >= 0 && loadIdx >= 0 && orphanIdx < loadIdx,
    `orphan sweep (#${orphanIdx}) must precede _loadCandidates (#${loadIdx})`);
});

(async () => {
  await Promise.all(_pending);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
