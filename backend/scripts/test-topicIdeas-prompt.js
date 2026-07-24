'use strict';

/**
 * test-topicIdeas-prompt.js — smoke-тест промпта topicIdeas.txt.
 * Проверяет, что после интерполяции с фиктивными значениями ВСЕ
 * placeholder'ы вида `{{...}}` заменены, и что в шаблоне есть ключевые
 * якорные секции (TOPIC_IDEAS_JSON, anti-fluff и пр.).
 *
 * Запуск:  node backend/scripts/test-topicIdeas-prompt.js
 */

const fs   = require('fs');
const path = require('path');
const assert = require('assert');

const PROMPT_PATH = path.join(__dirname, '..', 'src', 'prompts', 'articleTopics', 'topicIdeas.txt');

// Используем тот же _interpolate, что в pipeline. Чтобы не вытаскивать
// его из модуля, дублируем минимальную реализацию: {{KEY}} → values[KEY].
function interpolate(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_m, key) => (
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : `{{${key}}}`
  ));
}

let _cases = 0, _pass = 0;
function check(name, fn) {
  _cases += 1;
  try { fn(); _pass += 1; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); }
}

const tmpl = fs.readFileSync(PROMPT_PATH, 'utf-8');

console.log('▶ Шаблон topicIdeas.txt — структура');
check('Файл не пустой и содержит anti-fluff контракт', () => {
  assert.ok(tmpl.length > 1000);
  assert.match(tmpl, /ANTI-FLUFF/);
});
check('Содержит секции 1..7', () => {
  for (const n of [1, 2, 3, 4, 5, 6, 7]) {
    assert.match(tmpl, new RegExp(`##\\s*${n}\\.`), `missing ## ${n}.`);
  }
});
check('Содержит TOPIC_IDEAS_JSON sentinel', () => {
  assert.match(tmpl, /TOPIC_IDEAS_JSON_START/);
  assert.match(tmpl, /TOPIC_IDEAS_JSON_END/);
});
check('Содержит {{TOPIC_COUNT}} placeholder', () => {
  assert.match(tmpl, /\{\{TOPIC_COUNT\}\}/);
});
check('Содержит {{NICHE}} {{REGION}} {{AUDIENCE}} {{TARGET_URL}} {{BRAND_HINT}}', () => {
  for (const k of ['NICHE', 'REGION', 'AUDIENCE', 'TARGET_URL', 'BRAND_HINT']) {
    assert.match(tmpl, new RegExp(`\\{\\{${k}\\}\\}`), `missing {{${k}}}`);
  }
});

console.log('▶ Интерполяция плейсхолдеров');
check('После рендера НЕТ незаменённых {{...}} (для известных ключей)', () => {
  const rendered = interpolate(tmpl, {
    NICHE:      'оформление ВНЖ Португалии',
    REGION:     'Россия',
    AUDIENCE:   'B2C',
    TARGET_URL: 'https://example.com/portugal',
    BRAND_HINT: 'Бренд X — консалтинг',
    TOPIC_COUNT: '7',
    CURRENT_YEAR: '2026',
    EXCLUDED_TOPICS_LIST:    '(нет — генерируй свободно)',
    EXCLUDED_CLUSTERS_LIST:  '(нет)',
    REALTIME_RESEARCH_BLOCK: '(real-time ресёрч недоступен)',
  });
  // Не должно остаться плейсхолдеров вообще.
  const leftover = rendered.match(/\{\{[A-Z_]+\}\}/g);
  assert.strictEqual(leftover, null,
    `Незаменённые плейсхолдеры: ${(leftover || []).join(', ')}`);
});

check('TOPIC_COUNT подставлен буквально (не "{{TOPIC_COUNT}}" в JSON)', () => {
  const rendered = interpolate(tmpl, {
    NICHE: 'x', REGION: 'y', AUDIENCE: 'z',
    TARGET_URL: 'https://e.com', BRAND_HINT: '-',
    TOPIC_COUNT: '15',
  });
  // В JSON-блоке топика подставляется как число.
  assert.match(rendered, /"topic_count_requested":\s*15/);
});

console.log(`\n${_pass}/${_cases} passed`);
process.exit(_pass === _cases ? 0 : 1);
