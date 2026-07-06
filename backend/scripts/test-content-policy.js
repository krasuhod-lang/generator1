'use strict';

/**
 * Тесты для services/contentPolicy (реестр правил контента, V6).
 *
 * Не требует Postgres/сети — проверяем sync-аксессоры на defaults и
 * подмешивание кэша через _setCacheForTest.
 *
 * Запуск: node backend/scripts/test-content-policy.js
 */

const assert = require('assert');
const policy = require('../src/services/contentPolicy');
const { DEFAULT_STOP_PHRASES, DEFAULT_THRESHOLDS } = require('../src/services/contentPolicy/defaults');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { failed++; console.log(`  ✘ ${name}\n    ${e.stack || e.message}`); }
}
function group(name, fn) { console.log(name); fn(); }

group('defaults fallback', () => {
  test('getStopPhrasesSync возвращает исторический список без БД', () => {
    policy._resetCache();
    const p = policy.getStopPhrasesSync();
    assert.ok(p.includes('В современном мире'));
    assert.strictEqual(p.length, DEFAULT_STOP_PHRASES.length);
  });

  test('getThresholds отдаёт дефолтные пороги', () => {
    policy._resetCache();
    const th = policy.getThresholds();
    assert.strictEqual(th.plagiarismMaxRatio, DEFAULT_THRESHOLDS.plagiarismMaxRatio);
    assert.strictEqual(th.minValueAdds, 3);
  });

  test('inline override имеет приоритет', () => {
    const th = policy.getThresholds({ minValueAdds: 5 });
    assert.strictEqual(th.minValueAdds, 5);
  });
});

group('DB cache merge (через _setCacheForTest)', () => {
  test('кэш-фразы объединяются с defaults без дублей', () => {
    policy._setCacheForTest({ stopPhrases: ['Уникальная фраза', 'В современном мире'] });
    const p = policy.getStopPhrasesSync();
    assert.ok(p.includes('Уникальная фраза'));
    // дубль (уже в defaults) не увеличивает список дважды
    const count = p.filter((x) => x.toLowerCase() === 'в современном мире').length;
    assert.strictEqual(count, 1);
    policy._resetCache();
  });

  test('threshold override из кэша применяется', () => {
    policy._setCacheForTest({ thresholds: { plagiarismMaxRatio: 0.05 } });
    assert.strictEqual(policy.getThresholds().plagiarismMaxRatio, 0.05);
    policy._resetCache();
  });
});

group('isYmylNiche', () => {
  test('медицинская ниша → true', () => {
    assert.strictEqual(policy.isYmylNiche('лечение заболеваний суставов'), true);
  });
  test('финансовая ниша → true', () => {
    assert.strictEqual(policy.isYmylNiche('рефинансирование кредита'), true);
  });
  test('коммерческая нейтральная ниша → false', () => {
    assert.strictEqual(policy.isYmylNiche('пластиковые окна в Москве'), false);
  });
  test('пустой ввод → false', () => {
    assert.strictEqual(policy.isYmylNiche(''), false);
    assert.strictEqual(policy.isYmylNiche(null), false);
  });
});

group('_mergeUnique', () => {
  test('чистит пустые и дедуплицирует case-insensitive', () => {
    const r = policy._mergeUnique(['A', ' b '], ['a', 'B', '', null, 'C']);
    assert.deepStrictEqual(r, ['A', 'b', 'C']);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
