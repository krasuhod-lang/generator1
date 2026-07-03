'use strict';

/**
 * Тесты для V6 write-side (contentPolicy/rulesRepo.normalizeRuleInput) и
 * read-side журнала gate (qualityCore/reportsRepo.listReports).
 *
 * Без Postgres/сети: валидатор чист, а БД-функции проверяются через
 * фейковый db-клиент (перехватывает SQL+params).
 *
 * Запуск: node backend/scripts/test-content-policy-api.js
 */

const assert = require('assert');
const rulesRepo = require('../src/services/contentPolicy/rulesRepo');
const contentPolicy = require('../src/services/contentPolicy');
const { reportsRepo } = require('../src/services/qualityCore');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { failed++; console.log(`  ✘ ${name}\n    ${e.stack || e.message}`); }
}

function expectBadRequest(fn, code) {
  try { fn(); assert.fail('ожидалась ошибка 400'); }
  catch (e) {
    if (e instanceof assert.AssertionError) throw e;
    assert.strictEqual(e.status, 400, `status должен быть 400, получено ${e.status}`);
    if (code) assert.strictEqual(e.code, code, `code должен быть ${code}, получено ${e.code}`);
  }
}

async function main() {
  console.log('normalizeRuleInput — валидные');
  await test('stop_phrase из phrase → { phrases:[...] }', () => {
    const r = rulesRepo.normalizeRuleInput({ rule_type: 'stop_phrase', payload: { phrase: 'в современном мире' } });
    assert.deepStrictEqual(r.payload, { phrases: ['в современном мире'] });
    assert.strictEqual(r.scope, 'global');
    assert.strictEqual(r.scope_ref, null);
    assert.strictEqual(r.active, true);
  });
  await test('stop_phrase дедуп + trim из phrases[]', () => {
    const r = rulesRepo.normalizeRuleInput({ rule_type: 'stop_phrase', payload: { phrases: [' Вода ', 'вода', 'мусор'] } });
    assert.deepStrictEqual(r.payload.phrases, ['Вода', 'мусор']);
  });
  await test('banned_formulation ок', () => {
    const r = rulesRepo.normalizeRuleInput({ rule_type: 'banned_formulation', payload: { phrase: '100% гарантия' } });
    assert.deepStrictEqual(r.payload.phrases, ['100% гарантия']);
  });
  await test('ymyl_flag из keyword/keywords → { keywords:[...] }', () => {
    const r = rulesRepo.normalizeRuleInput({ rule_type: 'ymyl_flag', payload: { keyword: 'диагноз', keywords: ['лечение', 'диагноз'] } });
    assert.deepStrictEqual(r.payload.keywords, ['диагноз', 'лечение']);
  });
  await test('value_add_catalog из items', () => {
    const r = rulesRepo.normalizeRuleInput({ rule_type: 'value_add_catalog', payload: { items: ['quiz', 'quiz', 'map'] } });
    assert.deepStrictEqual(r.payload.items, ['quiz', 'map']);
  });
  await test('threshold с валидным ключом', () => {
    const r = rulesRepo.normalizeRuleInput({ rule_type: 'threshold', payload: { minValueAdds: 4, plagiarismMaxRatio: 0.1 } });
    assert.deepStrictEqual(r.payload, { minValueAdds: 4, plagiarismMaxRatio: 0.1 });
  });
  await test('scope=locale требует scope_ref и сохраняет его', () => {
    const r = rulesRepo.normalizeRuleInput({ rule_type: 'stop_phrase', scope: 'locale', scope_ref: 'ru', payload: { phrase: 'x' } });
    assert.strictEqual(r.scope, 'locale');
    assert.strictEqual(r.scope_ref, 'ru');
  });
  await test('active=false пробрасывается', () => {
    const r = rulesRepo.normalizeRuleInput({ rule_type: 'stop_phrase', payload: { phrase: 'x' }, active: false });
    assert.strictEqual(r.active, false);
  });

  console.log('normalizeRuleInput — ошибки');
  await test('неизвестный rule_type → 400 invalid_rule_type', () => {
    expectBadRequest(() => rulesRepo.normalizeRuleInput({ rule_type: 'nope', payload: {} }), 'invalid_rule_type');
  });
  await test('неизвестный scope → 400 invalid_scope', () => {
    expectBadRequest(() => rulesRepo.normalizeRuleInput({ rule_type: 'stop_phrase', scope: 'planet', payload: { phrase: 'x' } }), 'invalid_scope');
  });
  await test('не-global scope без scope_ref → 400 scope_ref_required', () => {
    expectBadRequest(() => rulesRepo.normalizeRuleInput({ rule_type: 'stop_phrase', scope: 'project', payload: { phrase: 'x' } }), 'scope_ref_required');
  });
  await test('пустой payload у stop_phrase → 400 empty_payload', () => {
    expectBadRequest(() => rulesRepo.normalizeRuleInput({ rule_type: 'stop_phrase', payload: { phrases: ['  ', ''] } }), 'empty_payload');
  });
  await test('threshold с чужим ключом → 400 unknown_threshold_key', () => {
    expectBadRequest(() => rulesRepo.normalizeRuleInput({ rule_type: 'threshold', payload: { hackKey: 1 } }), 'unknown_threshold_key');
  });
  await test('threshold пустой → 400 empty_payload', () => {
    expectBadRequest(() => rulesRepo.normalizeRuleInput({ rule_type: 'threshold', payload: {} }), 'empty_payload');
  });

  console.log('round-trip refresh()');
  await test('нормализованные payloads мёржатся в кэш и sync-аксессоры', async () => {
    const norm = [
      rulesRepo.normalizeRuleInput({ rule_type: 'stop_phrase', payload: { phrase: 'уникальная-стоп-фраза' } }),
      rulesRepo.normalizeRuleInput({ rule_type: 'ymyl_flag', payload: { keyword: 'редкая-ymyl-ниша' } }),
      rulesRepo.normalizeRuleInput({ rule_type: 'threshold', payload: { minValueAdds: 7 } }),
      rulesRepo.normalizeRuleInput({ rule_type: 'value_add_catalog', payload: { items: ['уникальный-value-add'] } }),
    ];
    const fakeDb = { query: async () => ({ rows: norm.map((n) => ({ rule_type: n.rule_type, payload: n.payload })) }) };
    contentPolicy._resetCache();
    await contentPolicy.refresh({ force: true, db: fakeDb });
    assert.ok(contentPolicy.getStopPhrasesSync().includes('уникальная-стоп-фраза'));
    assert.strictEqual(contentPolicy.isYmylNiche('текст про редкая-ymyl-ниша тут'), true);
    assert.strictEqual(contentPolicy.getThresholds().minValueAdds, 7);
    assert.ok(contentPolicy.getValueAddCatalogSync().includes('уникальный-value-add'));
    contentPolicy._resetCache();
  });

  console.log('rulesRepo write-side (fake db)');
  await test('createRule шлёт INSERT с нормализованным payload + инвалидирует кэш', async () => {
    const calls = [];
    const fakeDb = {
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (/INSERT INTO content_policy_rules/.test(sql)) {
          return { rows: [{ id: 1, scope: 'global', rule_type: 'stop_phrase', payload: JSON.parse(params[3]), active: true }] };
        }
        return { rows: [] }; // refresh SELECT
      },
    };
    const row = await rulesRepo.createRule({ input: { rule_type: 'stop_phrase', payload: { phrase: 'abc' } }, createdBy: null, db: fakeDb });
    assert.strictEqual(row.id, 1);
    const insert = calls.find((c) => /INSERT/.test(c.sql));
    assert.ok(insert, 'INSERT должен быть выполнен');
    assert.strictEqual(insert.params[2], 'stop_phrase');
    assert.deepStrictEqual(JSON.parse(insert.params[3]), { phrases: ['abc'] });
    assert.ok(calls.some((c) => /SELECT[\s\S]*content_policy_rules/.test(c.sql)), 'refresh SELECT (инвалидация кэша) должен вызваться');
    contentPolicy._resetCache();
  });
  await test('createRule с битым payload → 400 (INSERT не вызывается)', async () => {
    const calls = [];
    const fakeDb = { query: async (sql) => { calls.push(sql); return { rows: [] }; } };
    let threw = false;
    try { await rulesRepo.createRule({ input: { rule_type: 'threshold', payload: { bogus: 1 } }, db: fakeDb }); }
    catch (e) { threw = true; assert.strictEqual(e.status, 400); }
    assert.ok(threw, 'должно бросить 400');
    assert.ok(!calls.some((s) => /INSERT/.test(s)), 'INSERT не должен выполняться при невалидном вводе');
  });

  console.log('reportsRepo.listReports (fake db)');
  await test('фильтры pipeline+task_id → параметризованный WHERE', async () => {
    let captured = null;
    const fakeDb = { query: async (sql, params) => { captured = { sql, params }; return { rows: [] }; } };
    await reportsRepo.listReports({ pipeline: 'info', taskId: 42, db: fakeDb });
    assert.ok(/pipeline_type = \$1/.test(captured.sql));
    assert.ok(/task_id = \$2/.test(captured.sql));
    assert.deepStrictEqual(captured.params, ['info', 42]);
  });
  await test('невалидный pipeline → 400', async () => {
    let threw = false;
    try { await reportsRepo.listReports({ pipeline: 'bogus', db: { query: async () => ({ rows: [] }) } }); }
    catch (e) { threw = true; assert.strictEqual(e.status, 400); }
    assert.ok(threw);
  });
  await test('summarizeForTask агрегирует blockers/warnings', async () => {
    const rows = [
      { gate_name: 'banned_formulations', pass: false, blocking: true },
      { gate_name: 'freshness', pass: false, blocking: false },
      { gate_name: 'intent', pass: true, blocking: false },
    ];
    const fakeDb = { query: async () => ({ rows }) };
    const s = await reportsRepo.summarizeForTask({ pipeline: 'info', taskId: 1, db: fakeDb });
    assert.strictEqual(s.canPublish, false);
    assert.deepStrictEqual(s.blockers, ['banned_formulations']);
    assert.deepStrictEqual(s.warnings, ['freshness']);
    assert.strictEqual(s.total, 3);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
