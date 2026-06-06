'use strict';

/* Smoke-тесты для projects/strategyMap.buildStrategyMap (ТЗ п.5). */

const assert = require('assert');
const { buildStrategyMap, STAGES } = require('../src/services/projects/strategyMap');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log('FAIL  -', name, '\n        ', e.message); }
}

function rf(factors, extra = {}) {
  return { available: true, score: 60, factors, summary: 'sum', ...extra };
}

test('unavailable when rankingFactors missing', () => {
  assert.strictEqual(buildStrategyMap(null).available, false);
  assert.strictEqual(buildStrategyMap({ available: false }).available, false);
});

test('unavailable when no factors', () => {
  assert.strictEqual(buildStrategyMap(rf([])).available, false);
});

test('builds 5 ordered stages', () => {
  const out = buildStrategyMap(rf([
    { key: 'eat', label: 'E-E-A-T', group: 'trust', status: 'ok' },
  ]));
  assert.strictEqual(out.available, true);
  assert.strictEqual(out.stages.length, STAGES.length);
  out.stages.forEach((s, i) => assert.strictEqual(s.step, i + 1));
});

test('actions only from gap/critical factors with action', () => {
  const out = buildStrategyMap(rf([
    { key: 'eat', label: 'E-E-A-T', group: 'trust', status: 'critical', action: 'Добавить кейсы', finding: 'нет' },
    { key: 'schema', label: 'Schema', group: 'tech', status: 'ok', action: 'noop' },
    { key: 'relevance', label: 'Релевантность', group: 'content', status: 'gap', action: 'Расширить', finding: 'мало' },
  ]));
  const trust = out.stages.find((s) => s.id === 'trust');
  const content = out.stages.find((s) => s.id === 'content');
  const foundation = out.stages.find((s) => s.id === 'foundation');
  assert.strictEqual(trust.action_count, 1);
  assert.strictEqual(content.action_count, 1);
  assert.strictEqual(foundation.action_count, 0); // schema ok → не действие
});

test('stage status aggregates worst factor status', () => {
  const out = buildStrategyMap(rf([
    { key: 'relevance', label: 'A', group: 'content', status: 'ok' },
    { key: 'page_decay', label: 'B', group: 'content', status: 'critical', action: 'x' },
  ]));
  const content = out.stages.find((s) => s.id === 'content');
  assert.strictEqual(content.status, 'critical');
});

test('critical actions sorted before gap', () => {
  const out = buildStrategyMap(rf([
    { key: 'relevance', label: 'B-gap', group: 'content', status: 'gap', action: 'x' },
    { key: 'page_decay', label: 'A-crit', group: 'content', status: 'critical', action: 'y' },
  ]));
  const content = out.stages.find((s) => s.id === 'content');
  assert.strictEqual(content.actions[0].status, 'critical');
});

test('carries score, goal and kpis', () => {
  const out = buildStrategyMap(rf([
    { key: 'eat', label: 'E', group: 'trust', status: 'ok' },
  ], { score: 73 }));
  assert.strictEqual(out.score, 73);
  assert.ok(/позиц/i.test(out.goal));
  assert.strictEqual(out.kpis.length, 3);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
