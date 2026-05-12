'use strict';

/**
 * test-topicIdeas-controller.js — валидация POST /topic-ideas controller'а
 * без поднятия БД и без реального вызова Gemini. Проверяем граничные
 * случаи topic_count, длины niche, enum audience, target_url-формат и
 * env-гейт ARTICLE_TOPICS_TOPIC_IDEAS_ENABLED.
 *
 * Запуск:  node backend/scripts/test-topicIdeas-controller.js
 */

const assert = require('assert');
const path   = require('path');
const Module = require('module');

// ── Подменяем зависимости контроллера на in-memory заглушки ──────────
// Используем patch require, чтобы не тянуть реальные db/pg/Gemini.
const ORIG_RESOLVE = Module._resolveFilename;
const ORIG_LOAD    = Module._load;

const fakeDb = {
  // Возвращает «вставленную» строку с предсказуемым id.
  inserts: [],
  query(sql, params) {
    if (/INSERT INTO article_topic_tasks/i.test(sql)) {
      const row = {
        id: '00000000-0000-0000-0000-000000000001',
        mode: 'topic_ideas',
        niche: params[1],
        status: 'queued',
        topic_count_requested: params[4],
        created_at: new Date().toISOString(),
      };
      fakeDb.inserts.push({ sql, params });
      return Promise.resolve({ rows: [row], rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  },
};
const fakePipeline = { processArticleTopicTask: async () => null };
const fakeTrends   = { findDuplicateDeepDives: async () => [] };
const fakeConcurrency = { withUserSlot: (_uid, fn) => fn() };

Module._load = function (request, parent, ...rest) {
  if (request === '../config/db') return fakeDb;
  if (request === '../services/articleTopics/articleTopicsPipeline') return fakePipeline;
  if (request === '../services/articleTopics/articleTopicsTrends') return fakeTrends;
  if (request === '../utils/perUserConcurrency') return fakeConcurrency;
  return ORIG_LOAD.apply(this, [request, parent, ...rest]);
};

// Загружаем контроллер уже с подменами.
const controllerPath = path.join(__dirname, '..', 'src', 'controllers', 'articleTopics.controller');
delete require.cache[require.resolve(controllerPath)];
const ctrl = require(controllerPath);

// Восстанавливаем загрузчик, чтобы node-modules грузились нормально дальше.
Module._load = ORIG_LOAD;
Module._resolveFilename = ORIG_RESOLVE;

// ── Mini test harness ───────────────────────────────────────────────
let _cases = 0, _pass = 0;
function check(name, fn) {
  _cases += 1;
  return Promise.resolve()
    .then(() => fn())
    .then(() => { _pass += 1; console.log(`  ✓ ${name}`); })
    .catch((err) => console.error(`  ✗ ${name}\n    ${err.message}`));
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(b)      { this.body = b; return this; },
  };
  return res;
}
function makeReq(body) {
  return { user: { id: 'user-1' }, body: body || {} };
}

async function call(body) {
  const req = makeReq(body);
  const res = makeRes();
  let nextErr = null;
  await ctrl.createArticleTopicIdeasTask(req, res, (e) => { nextErr = e; });
  return { req, res, nextErr };
}

(async function main() {
  console.log('▶ Валидация niche');
  await check('niche < 3 → 400', async () => {
    const { res } = await call({ niche: 'ab' });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /Ниша/);
  });
  await check('niche отсутствует → 400', async () => {
    const { res } = await call({});
    assert.strictEqual(res.statusCode, 400);
  });

  console.log('▶ Валидация topic_count');
  await check('topic_count = 0 → 400', async () => {
    const { res } = await call({ niche: 'тест нишa', topic_count: 0 });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /topic_count/);
  });
  await check('topic_count = -1 → 400', async () => {
    const { res } = await call({ niche: 'тест нишa', topic_count: -1 });
    assert.strictEqual(res.statusCode, 400);
  });
  await check('topic_count = 31 → 400 (выше потолка по дефолту 30)', async () => {
    const { res } = await call({ niche: 'тест нишa', topic_count: 31 });
    assert.strictEqual(res.statusCode, 400);
  });
  await check('topic_count = "abc" → 400', async () => {
    const { res } = await call({ niche: 'тест нишa', topic_count: 'abc' });
    assert.strictEqual(res.statusCode, 400);
  });
  await check('topic_count = 5.5 (дробь) → 400', async () => {
    const { res } = await call({ niche: 'тест нишa', topic_count: 5.5 });
    assert.strictEqual(res.statusCode, 400);
  });
  await check('topic_count = null/undefined → default 10', async () => {
    fakeDb.inserts = [];
    const { res } = await call({ niche: 'тест нишa', topic_count: null });
    assert.strictEqual(res.statusCode, 201);
    const lastInsert = fakeDb.inserts[fakeDb.inserts.length - 1];
    assert.strictEqual(lastInsert.params[4], 10);
  });
  await check('topic_count = 1 (нижняя граница) → 201', async () => {
    const { res } = await call({ niche: 'тест нишa', topic_count: 1 });
    assert.strictEqual(res.statusCode, 201);
  });
  await check('topic_count = 30 (верхняя граница) → 201', async () => {
    const { res } = await call({ niche: 'тест нишa', topic_count: 30 });
    assert.strictEqual(res.statusCode, 201);
  });

  console.log('▶ Валидация target_url');
  await check('target_url без http(s) → 400', async () => {
    const { res } = await call({ niche: 'тест нишa', target_url: 'example.com' });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /http/);
  });
  await check('target_url с https → 201', async () => {
    const { res } = await call({ niche: 'тест нишa', target_url: 'https://example.com/page' });
    assert.strictEqual(res.statusCode, 201);
  });
  await check('Пустой target_url → 201 (опциональное поле)', async () => {
    const { res } = await call({ niche: 'тест нишa', target_url: '' });
    assert.strictEqual(res.statusCode, 201);
  });

  console.log('▶ Валидация audience (enum)');
  await check('audience не из enum → пустая строка (мягкая валидация)', async () => {
    fakeDb.inserts = [];
    const { res } = await call({ niche: 'тест нишa', audience: 'мусор' });
    assert.strictEqual(res.statusCode, 201);
    const last = fakeDb.inserts[fakeDb.inserts.length - 1];
    // params: [user_id, niche, region, audience, topicCount, ctxJson]
    assert.strictEqual(last.params[3], '');
  });
  await check('audience = "B2B" сохраняется', async () => {
    fakeDb.inserts = [];
    const { res } = await call({ niche: 'тест нишa', audience: 'B2B' });
    assert.strictEqual(res.statusCode, 201);
    const last = fakeDb.inserts[fakeDb.inserts.length - 1];
    assert.strictEqual(last.params[3], 'B2B');
  });

  console.log('▶ module_context_used.topic_ideas_inputs пишется при INSERT');
  await check('inputs (target_url/brand_hint/topic_count) попадают в JSONB', async () => {
    fakeDb.inserts = [];
    await call({
      niche: 'тест нишa',
      target_url: 'https://example.com',
      brand_hint: 'Бренд X',
      topic_count: 7,
    });
    const last = fakeDb.inserts[fakeDb.inserts.length - 1];
    const ctx = JSON.parse(last.params[5]);
    assert.deepStrictEqual(ctx.topic_ideas_inputs, {
      target_url: 'https://example.com',
      brand_hint: 'Бренд X',
      topic_count: 7,
    });
  });

  console.log('▶ Env-гейт ARTICLE_TOPICS_TOPIC_IDEAS_ENABLED');
  await check('ENABLED=false → 503', async () => {
    process.env.ARTICLE_TOPICS_TOPIC_IDEAS_ENABLED = 'false';
    try {
      const { res } = await call({ niche: 'тест нишa', topic_count: 3 });
      assert.strictEqual(res.statusCode, 503);
    } finally {
      delete process.env.ARTICLE_TOPICS_TOPIC_IDEAS_ENABLED;
    }
  });
  await check('ENABLED unset → default ON (201)', async () => {
    delete process.env.ARTICLE_TOPICS_TOPIC_IDEAS_ENABLED;
    const { res } = await call({ niche: 'тест нишa', topic_count: 3 });
    assert.strictEqual(res.statusCode, 201);
  });

  console.log('▶ LIMITS sanity');
  await check('LIMITS exposes topic_count bounds', () => {
    const { LIMITS } = ctrl._testing;
    assert.strictEqual(LIMITS.topic_count_min, 1);
    assert.strictEqual(LIMITS.topic_count_max, 30);
    assert.strictEqual(LIMITS.topic_count_default, 10);
  });

  console.log(`\n${_pass}/${_cases} passed`);
  process.exit(_pass === _cases ? 0 : 1);
})();
