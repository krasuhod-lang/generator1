'use strict';

const assert = require('assert');
const { detectBannedPatterns } = require('../src/services/linkArticle/qualityPatterns');

{
  const html = '<h1>Тест</h1><p>В современном мире тема требует внимания.</p><ul><li>Факт</li></ul>';
  const report = detectBannedPatterns(html);
  assert(report.banned_intros.includes('в современном мире'));
  assert.strictEqual(report.has_table_or_list, true);
  assert.strictEqual(report.ok, false);
}

{
  const html = [
    '<p>Метод — это способ снизить риск и выбрать понятный порядок действий.</p>',
    '<p>Подход — это способ снизить риск и выбрать понятный порядок действий.</p>',
    '<p>Решение — это способ снизить риск и выбрать понятный порядок действий.</p>',
    '<ul><li>Конкретный факт</li></ul>',
  ].join('');
  const report = detectBannedPatterns(html);
  assert.strictEqual(report.repetitive_structure, true);
  assert.strictEqual(report.ok, false);
}

{
  const html = '<h1>Тест</h1><p>Короткий прямой ответ без водной вводной.</p>';
  const report = detectBannedPatterns(html);
  assert.strictEqual(report.has_table_or_list, false);
  assert.strictEqual(report.ok, false);
}

{
  const html = [
    '<h1>Тест</h1>',
    '<p>Материал сразу объясняет критерии выбора и ограничения.</p>',
    '<table><tr><td>Критерий</td><td>Что проверить</td></tr></table>',
  ].join('');
  const report = detectBannedPatterns(html);
  assert.deepStrictEqual(report.banned_intros, []);
  assert.strictEqual(report.repetitive_structure, false);
  assert.strictEqual(report.has_table_or_list, true);
  assert.strictEqual(report.ok, true);
}

console.log('test-link-quality-patterns: ok');
