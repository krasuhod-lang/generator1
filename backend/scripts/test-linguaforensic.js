'use strict';

/**
 * Тесты для services/linguaForensic (LinguaForensic v3.6 layer).
 *
 * Не требует Postgres/сети — проверяются skill-файл, промпты и защита
 * объёма (±15%). LLM-вызовы не выполняются.
 *
 * Запуск: node backend/scripts/test-linguaforensic.js
 */

const assert = require('assert');
const fs = require('fs');
const lf = require('../src/services/linguaForensic');

const { buildDetectPrompt, buildRewritePrompt, _volumeOk, _wordCount, _normalizeReport, SKILL_PATH, PIPELINE_DOMAINS } = lf._internal;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { failed++; console.log(`  ✘ ${name}\n    ${e.stack || e.message}`); }
}

console.log('linguaForensic: skill-файл');

test('skill-файл существует и содержит ключевые разделы v3.6', () => {
  const skill = fs.readFileSync(SKILL_PATH, 'utf8');
  assert.ok(skill.length > 50000, 'skill слишком короткий');
  for (const section of [
    '284',                          // базовые признаки
    'Категория 12',                 // структурные маркеры
    'Категория 13. Knockoff-слой',  // knockoff
    'Матрица весов по доменам',
    'РЕЖИМЫ РАБОТЫ',
    'Режим 2. Полная детекция',
    'Режим 3. Стратегический рерайт',
    'Режим 4. Циклический',
    'Режим 5. Сравнительный анализ',
    'Техника F1',
    'Техника F7',
    'Пост-валидация с fluency-метриками',
    'Важные принципы',
  ]) {
    assert.ok(skill.includes(section), `нет раздела: ${section}`);
  }
});

test('loadSkill() возвращает содержимое', () => {
  assert.ok((lf.loadSkill() || '').includes('LinguaForensic'));
});

console.log('linguaForensic: промпты');

test('detect-промпт содержит режим, домен и текст', () => {
  const p = buildDetectPrompt('<p>Текст статьи</p>', PIPELINE_DOMAINS.info);
  assert.ok(p.includes('Режим 2'));
  assert.ok(p.includes(PIPELINE_DOMAINS.info));
  assert.ok(p.includes('Текст статьи'));
  assert.ok(p.includes('robotness_score'));
});

test('rewrite-промпт содержит режим 3, маркеры и ограничения', () => {
  const report = {
    robotness_score: 72,
    recommended_strategy: 'Экспертная',
    recommended_intensity: 'Medium',
    structural_markers_found: ['12.1 — hedge-opener: «в современном мире»'],
    fluency_issues: ['F3: пассив'],
    top_contributing_categories: [{ category: 'Lexical Richness', contribution_pct: 28 }],
  };
  const p = buildRewritePrompt('<p>Текст</p>', report, PIPELINE_DOMAINS.seo);
  assert.ok(p.includes('Режим 3'));
  assert.ok(p.includes('72%'));
  assert.ok(p.includes('hedge-opener'));
  assert.ok(p.includes('±15%'));
  assert.ok(p.includes('rewritten_html'));
});

console.log('linguaForensic: защита объёма и нормализация');

test('_wordCount игнорирует теги', () => {
  assert.strictEqual(_wordCount('<p>раз два <b>три</b></p>'), 3);
});

test('_volumeOk принимает ±15% и отклоняет большее', () => {
  const base = Array(100).fill('слово').join(' ');
  const ok = Array(110).fill('слово').join(' ');
  const bad = Array(150).fill('слово').join(' ');
  assert.strictEqual(_volumeOk(base, ok), true);
  assert.strictEqual(_volumeOk(base, bad), false);
  assert.strictEqual(_volumeOk(base, ''), false);
});

test('_normalizeReport вытаскивает knockoff и списки', () => {
  const r = _normalizeReport({
    robotness_score: '63',
    knockoff: { s_statistic: 0.04, symmetric: true },
    structural_markers_found: ['12.4'],
    recommended_strategy: 'Нарративная',
  });
  assert.strictEqual(r.robotness_score, 63);
  assert.strictEqual(r.knockoff_s, 0.04);
  assert.strictEqual(r.knockoff_symmetric, true);
  assert.deepStrictEqual(r.structural_markers_found, ['12.4']);
  assert.strictEqual(_normalizeReport(null), null);
});

console.log('linguaForensic: graceful-поведение runLinguaForensicPass');

test('слишком короткий текст → skipped, текст не меняется', async () => {
  const { html, report } = await lf.runLinguaForensicPass('<p>коротко</p>', { pipeline: 'info' });
  assert.strictEqual(html, '<p>коротко</p>');
  assert.strictEqual(report.verdict, 'skipped');
});

process.on('exit', () => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
});
