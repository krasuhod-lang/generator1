'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const controller = fs.readFileSync(
  path.join(root, 'backend', 'src', 'controllers', 'infoArticle.controller.js'),
  'utf8',
);
const page = fs.readFileSync(
  path.join(root, 'frontend', 'src', 'views', 'InfoArticlePage.vue'),
  'utf8',
);
const pipeline = fs.readFileSync(
  path.join(root, 'backend', 'src', 'services', 'infoArticle', 'infoArticlePipeline.js'),
  'utf8',
);
const prompt = fs.readFileSync(
  path.join(root, 'backend', 'src', 'prompts', 'infoArticle', 'stage4_image_prompts.txt'),
  'utf8',
);

assert.match(controller, /inline_images_count/);
assert.match(controller, /return 1 \+ clampInlineImagesCount\(body\.inline_images_count\)/);
assert.match(controller, /MAX_INLINE_IMAGES_COUNT = 3/);

assert.match(page, /v-model\.number="form\.inline_images_count"/);
assert.match(page, /inline_images_count: inlineImagesCount/);
assert.match(page, /1 обложка/);
assert.ok(/0(?:–|\.\.)3/.test(page) || /<option :value="3">3<\/option>/.test(page));

assert.match(pipeline, /inline_images_count_required:/);
assert.match(pipeline, /1 обязательный cover/);
assert.match(prompt, /inline_images_count_required/);
assert.match(prompt, /при inline_images_count_required=0 не создавай никаких slot≥2/);

const { planImageIntents } = require(path.join(
  root,
  'backend',
  'src',
  'services',
  'images',
  'imageIntentPlanner',
));
const sections = [
  {
    key: 'process',
    h2: 'Как работает процесс',
    text: 'Сначала пользователь выполняет первый шаг, затем проверяет результат и сравнивает два варианта процесса. Порядок действий важен для настройки. После этого нужно повторить проверку, оценить изменения, зафиксировать результат и выбрать следующий этап по инструкции.',
  },
  {
    key: 'compare',
    h2: 'Сравнение вариантов',
    text: 'Сравним два варианта решения, их плюсы и минусы, стоимость и различия для выбора подходящего результата. В статье подробно разобраны варианты применения, преимущества и недостатки каждого решения, критерии выбора и типичные ошибки пользователя.',
  },
];

const coverOnly = planImageIntents({
  topic: 'Практическое руководство',
  sections,
  maxImages: 1,
  maxInlineImages: 3,
  editorialMode: 'relaxed',
}).filter((slot) => slot.slot != null);
assert.strictEqual(coverOnly.length, 1);
assert.strictEqual(coverOnly[0].slot, 1);
assert.strictEqual(coverOnly[0].image_intent, 'cover');

const coverPlusInline = planImageIntents({
  topic: 'Практическое руководство',
  sections,
  maxImages: 3,
  maxInlineImages: 3,
  editorialMode: 'relaxed',
}).filter((slot) => slot.slot != null);
assert.strictEqual(coverPlusInline.length, 3);
assert.strictEqual(coverPlusInline[0].slot, 1);
assert.strictEqual(new Set(coverPlusInline.slice(1).map((slot) => slot.section_key)).size, 2);

console.log('OK: blog image request contract');
