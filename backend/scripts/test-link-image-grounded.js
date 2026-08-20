'use strict';

const assert = require('assert');
const { _embedImages } = require('../src/services/linkArticle/linkArticlePipeline');

const png = Buffer.from('not-a-real-png').toString('base64');
const html = [
  '<h1>Статья</h1>',
  '<h2>Введение</h2><p>Текст.</p>',
  '<!-- IMAGE_SLOT_1 -->',
  '<h2>Как работает процесс очистки</h2><p>Подробное описание.</p>',
  '<!-- IMAGE_SLOT_2 -->',
  '<!-- IMAGE_SLOT_3 -->',
].join('');

const out = _embedImages(html, [
  {
    slot: 1,
    status: 'done',
    image_base64: png,
    mime_type: 'image/png',
    alt_ru: 'Обложка статьи',
    grounded_planning: true,
  },
  {
    slot: 2,
    section_h2: 'Как работает процесс очистки',
    status: 'done',
    image_base64: png,
    mime_type: 'image/png',
    alt_ru: 'Схема процесса очистки',
    grounded_planning: true,
  },
]);

assert.strictEqual((out.match(/IMAGE_SLOT_/g) || []).length, 0);
assert.strictEqual((out.match(/class="link-article-image"/g) || []).length, 2);
assert.ok(out.indexOf('Схема процесса очистки') < out.indexOf('<h2>Как работает процесс очистки</h2>'));
console.log('✅ test-link-image-grounded: all checks passed');
process.exit(0);
