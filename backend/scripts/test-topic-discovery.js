'use strict';

/**
 * test-topic-discovery.js — юнит-тесты M-1 Topic Discovery без сети/LLM.
 * Покрывает: trendsCollector (кэш/rate-limit/normalize/fail-open),
 * topicDiscovery.service (агрегация сигналов, per-source fail-open,
 * нормализация результата) и checkTopicDiscovery (warning-логика).
 *
 * Запуск: node backend/scripts/test-topic-discovery.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const trendsCollector = require('../src/services/topicDiscovery/trendsCollector');
const topicDiscovery = require('../src/services/topicDiscovery/topicDiscovery.service');
const checkers = require('../src/services/qualityCore/checkers');

let passed = 0;
let failed = 0;

// Синхронный раннер для async-тестов по очереди.
async function run(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n      ${e.message}`); }
}

function makeRawTrends({ values = [10, 20, 30], top = ['a'], rising = ['b'] } = {}) {
  return {
    interestOverTime: {
      default: { timelineData: values.map((v) => ({ value: [v] })) },
    },
    relatedQueries: {
      default: {
        rankedList: [
          { rankedKeyword: top.map((q) => ({ query: q })) },
          { rankedKeyword: rising.map((q) => ({ query: q })) },
        ],
      },
    },
  };
}

(async () => {
  console.log('── trendsCollector ──');

  await run('_normalize: demand_signal = среднее interest', async () => {
    const d = trendsCollector._internal._normalize('kw', makeRawTrends({ values: [0, 50, 100] }), Date.now());
    assert.strictEqual(d.demand_signal, 50);
    assert.strictEqual(d.keyword, 'kw');
  });

  await run('_normalize: trend_slope положителен при росте', async () => {
    const d = trendsCollector._internal._normalize('kw', makeRawTrends({ values: [10, 10, 10, 90, 90, 90] }), Date.now());
    assert.ok(d.trend_slope > 0, `slope=${d.trend_slope}`);
  });

  await run('_normalize: rising/top queries извлечены', async () => {
    const d = trendsCollector._internal._normalize('kw', makeRawTrends({ top: ['top1'], rising: ['rise1'] }), Date.now());
    assert.deepStrictEqual(d.top_queries, ['top1']);
    assert.deepStrictEqual(d.rising_queries, ['rise1']);
  });

  await run('_normalize: пустое сырьё → null (fail-open)', async () => {
    const d = trendsCollector._internal._normalize('kw', { interestOverTime: null, relatedQueries: null }, Date.now());
    assert.strictEqual(d, null);
  });

  await run('collectTrends: пустой keyword → null', async () => {
    const r = await trendsCollector.collectTrends('', { fetcher: async () => makeRawTrends() });
    assert.strictEqual(r, null);
  });

  await run('collectTrends: fetcher бросает → null (fail-open)', async () => {
    trendsCollector._internal._resetRateLimit();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-'));
    const r = await trendsCollector.collectTrends('kw', {
      fetcher: async () => { throw new Error('banned'); },
      overrides: { cacheDir: dir, minIntervalMs: 0 },
    });
    assert.strictEqual(r, null);
  });

  await run('collectTrends: кэширует и читает из кэша', async () => {
    trendsCollector._internal._resetRateLimit();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-'));
    let calls = 0;
    const fetcher = async () => { calls += 1; return makeRawTrends({ values: [40, 40, 40] }); };
    const now = 1000;
    const r1 = await trendsCollector.collectTrends('cachekw', { fetcher, overrides: { cacheDir: dir, minIntervalMs: 0 }, now });
    assert.ok(r1 && r1.demand_signal === 40);
    // Второй вызов должен взять из кэша, fetcher не вызывается снова.
    const r2 = await trendsCollector.collectTrends('cachekw', { fetcher, overrides: { cacheDir: dir, minIntervalMs: 0 }, now: now + 100 });
    assert.strictEqual(calls, 1, `fetcher вызван ${calls} раз(а)`);
    assert.deepStrictEqual(r2, r1);
  });

  await run('collectTrends: rate-limit → null если рано', async () => {
    trendsCollector._internal._resetRateLimit();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-'));
    const fetcher = async () => makeRawTrends();
    const r1 = await trendsCollector.collectTrends('rlkw', { fetcher, overrides: { cacheDir: dir, minIntervalMs: 5000 }, now: 10000 });
    assert.ok(r1);
    // Другой ключ сразу же (в пределах интервала) → rate-limited → null.
    const r2 = await trendsCollector.collectTrends('rlkw2', { fetcher, overrides: { cacheDir: dir, minIntervalMs: 5000 }, now: 10500 });
    assert.strictEqual(r2, null);
  });

  await run('collectTrends: TOPIC_TRENDS disabled → null', async () => {
    const r = await trendsCollector.collectTrends('kw', { fetcher: async () => makeRawTrends(), overrides: { enabled: false } });
    assert.strictEqual(r, null);
  });

  console.log('── topicDiscovery.service ──');

  await run('runTopicDiscovery: агрегирует reddit+paa+trends и вызывает gist', async () => {
    let receivedPayload = null;
    const result = await topicDiscovery.runTopicDiscovery({
      query: 'зимние шины',
      niche: 'шины',
      paaQuestions: ['какие шины лучше', 'когда менять шины'],
      deps: {
        runRedditMapperPipeline: async () => ({ digest: { core_pains: ['дорого', 'шумят'], must_cover_topics: ['выбор размера'] } }),
        collectTrends: async () => ({ demand_signal: 80, rising_queries: ['шины 2026'] }),
        runTopicDiscovery: async (payload) => {
          receivedPayload = payload;
          return { topic_status: 'void', topic_score: 82, go_decision: true, sub_niche_suggestions: [], reasoning: 'ok' };
        },
      },
    });
    assert.strictEqual(result.topic_state, 'void');
    assert.strictEqual(result.topic_score, 82);
    assert.strictEqual(result.signals_used.reddit > 0, true);
    assert.strictEqual(result.signals_used.paa, 2);
    assert.strictEqual(result.signals_used.trends, true);
    assert.ok(receivedPayload.reddit_insights.length > 0);
    assert.ok(Array.isArray(receivedPayload.paa_questions));
    assert.ok(receivedPayload.trends_data);
  });

  await run('runTopicDiscovery: reddit сбой не роняет (per-source fail-open)', async () => {
    const result = await topicDiscovery.runTopicDiscovery({
      query: 'kw',
      deps: {
        runRedditMapperPipeline: async () => { throw new Error('reddit down'); },
        collectTrends: async () => null,
        runTopicDiscovery: async () => ({ topic_status: 'lack', topic_score: 60 }),
      },
    });
    assert.strictEqual(result.topic_state, 'lack');
    assert.strictEqual(result.signals_used.reddit, 0);
    assert.strictEqual(result.signals_used.trends, false);
  });

  await run('runTopicDiscovery: gist недоступен → safe fallback balance+manual_review', async () => {
    const result = await topicDiscovery.runTopicDiscovery({
      query: 'kw',
      deps: {
        runRedditMapperPipeline: async () => ({ digest: {} }),
        collectTrends: async () => null,
        runTopicDiscovery: async () => { throw new Error('gist 500'); },
      },
    });
    assert.strictEqual(result.topic_state, 'balance');
    assert.strictEqual(result.manual_review, true);
    assert.strictEqual(result.go_decision, true);
  });

  await run('runTopicDiscovery: пустой query → safe fallback', async () => {
    const result = await topicDiscovery.runTopicDiscovery({ query: '   ' });
    assert.strictEqual(result.topic_state, 'balance');
    assert.strictEqual(result.manual_review, true);
  });

  await run('runTopicDiscovery: невалидный topic_status нормализуется в balance', async () => {
    const result = await topicDiscovery.runTopicDiscovery({
      query: 'kw',
      deps: {
        collectTrends: async () => null,
        runTopicDiscovery: async () => ({ topic_status: 'weird', topic_score: 'nan' }),
      },
    });
    assert.strictEqual(result.topic_state, 'balance');
    assert.strictEqual(result.topic_score, null);
  });

  await run('runTopicDiscovery: PAA из serpVerification.cases[].paa', async () => {
    let payload = null;
    await topicDiscovery.runTopicDiscovery({
      query: 'kw',
      serpVerification: { cases: [{ paa: ['q1', 'q2'] }, { related_queries: ['q3'] }] },
      deps: {
        collectTrends: async () => null,
        runTopicDiscovery: async (p) => { payload = p; return { topic_status: 'balance' }; },
      },
    });
    assert.deepStrictEqual(payload.paa_questions.sort(), ['q1', 'q2', 'q3']);
  });

  console.log('── checkTopicDiscovery ──');

  await run('checkTopicDiscovery: balance+manual_review → warning (не blocker)', async () => {
    const v = checkers.checkTopicDiscovery({ topic_state: 'balance', manual_review: true });
    assert.strictEqual(v.pass, false);
    assert.strictEqual(v.blocking, false);
  });

  await run('checkTopicDiscovery: void → pass', async () => {
    const v = checkers.checkTopicDiscovery({ topic_state: 'void', manual_review: false });
    assert.strictEqual(v.pass, true);
    assert.strictEqual(v.blocking, false);
  });

  await run('checkTopicDiscovery: balance без manual_review → pass', async () => {
    const v = checkers.checkTopicDiscovery({ topic_state: 'balance', manual_review: false });
    assert.strictEqual(v.pass, true);
  });

  await run('checkTopicDiscovery: нет отчёта → na/pass', async () => {
    const v = checkers.checkTopicDiscovery(null);
    assert.strictEqual(v.pass, true);
    assert.strictEqual(v.verdict, 'na');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
