'use strict';

/**
 * Offline-тесты semantic fact-check слоя: без DeepSeek API и без сети.
 * Запуск: node backend/scripts/test-semantic-factcheck.js
 */

const assert = require('assert');
const {
  extractSemanticClaims,
  verifySemanticClaims,
  runSemanticFactCheck,
  MAX_SEMANTIC_CLAIMS,
} = require('../src/services/infoArticle/factCheck.service');

let passed = 0;
let failed = 0;
const asyncCases = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      asyncCases.push(
        r.then(() => { passed += 1; console.log(`  ✔ ${name}`); })
          .catch((e) => { failed += 1; console.log(`  ✘ ${name}\n    ${e.stack || e.message}`); }),
      );
    } else {
      passed += 1;
      console.log(`  ✔ ${name}`);
    }
  } catch (e) {
    failed += 1;
    console.log(`  ✘ ${name}\n    ${e.stack || e.message}`);
  }
}

console.log('semantic fact-check');

test('extractSemanticClaims находит определения без чисел', () => {
  const html = `
    <p>Фотосинтез — это процесс преобразования световой энергии в химическую.</p>
    <p>Компания Apple представила новый подход к приватности пользователей.</p>
    <p>В 2026 году числовое утверждение должно уйти в deterministic слой.</p>
  `;
  const claims = extractSemanticClaims(html);
  assert.ok(claims.some((c) => c.text.includes('Фотосинтез')), JSON.stringify(claims));
  assert.ok(claims.some((c) => c.text.includes('Apple')), JSON.stringify(claims));
  assert.ok(!claims.some((c) => c.text.includes('2026')), JSON.stringify(claims));
});

test('extractSemanticClaims ограничивает объём MAX_SEMANTIC_CLAIMS', () => {
  const html = Array.from({ length: MAX_SEMANTIC_CLAIMS + 5 }, (_, i) => (
    `<p>Термин Семантика${String.fromCharCode(1040 + i)} — это проверяемое определение без цифровых токенов.</p>`
  )).join('');
  const claims = extractSemanticClaims(html);
  assert.strictEqual(claims.length, MAX_SEMANTIC_CLAIMS);
});

test('verifySemanticClaims fail-open без DEEPSEEK_API_KEY', async () => {
  const oldKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const claims = extractSemanticClaims('<p>Фотосинтез — это процесс преобразования световой энергии.</p>');
    const result = await verifySemanticClaims(claims, { evidence: [] });
    assert.strictEqual(result.semanticSkipped, true);
    assert.ok(result.length >= 1);
    assert.ok(result.every((r) => r.status === 'skipped'));
  } finally {
    if (oldKey) process.env.DEEPSEEK_API_KEY = oldKey;
  }
});

test('runSemanticFactCheck сохраняет deterministic summary при skipped semantic layer', async () => {
  const oldKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const report = await runSemanticFactCheck(
      '<p>Фотосинтез — это процесс преобразования световой энергии.</p><p>В 2024 году показатель достиг 50%.</p>',
      { evidence: [{ url: 'https://example.test', h1: 'Источник', snippets: [{ text: 'В 2024 году показатель достиг 50%.', score: 1 }] }] },
    );
    assert.ok(report.summary.total >= 1);
    assert.strictEqual(report.semantic.semanticSkipped, true);
    assert.strictEqual(report.semantic.summary.skipped, report.semantic.summary.total);
  } finally {
    if (oldKey) process.env.DEEPSEEK_API_KEY = oldKey;
  }
});

Promise.all(asyncCases).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
});
