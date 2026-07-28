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

  console.log('── topicDiscovery: Perplexity-сигналы ──');

  await run('_extractPerplexityTrends: JSON-контракт { trends: [...] }', async () => {
    const out = topicDiscovery._internal._extractPerplexityTrends({
      trends: ['рост спроса', 'новые ГОСТы', 'рост спроса'],
    });
    assert.deepStrictEqual(out, ['рост спроса', 'новые ГОСТы']);
  });

  await run('_extractPerplexityTrends: массив объектов и голый массив', async () => {
    assert.deepStrictEqual(
      topicDiscovery._internal._extractPerplexityTrends({ questions: [{ question: 'сколько стоит?' }] }),
      ['сколько стоит?'],
    );
    assert.deepStrictEqual(
      topicDiscovery._internal._extractPerplexityTrends(['a', 'b']),
      ['a', 'b'],
    );
  });

  await run('_extractPerplexityTrends: текстовый список (обратная совместимость)', async () => {
    const out = topicDiscovery._internal._extractPerplexityTrends({ text: '1. первый\n- второй' });
    assert.deepStrictEqual(out, ['первый', 'второй']);
  });

  await run('_collectPerplexityTrends: просит строгий JSON и ограничивает retries', async () => {
    const prevKey = process.env.PERPLEXITY_API_KEY;
    process.env.PERPLEXITY_API_KEY = 'test-key';
    try {
      let seen = null;
      const trends = await topicDiscovery._internal._collectPerplexityTrends({
        niche: 'шины',
        query: 'зимние шины',
        log: () => {},
        deps: {
          callLLM: async (adapter, system, prompt, opts) => {
            seen = { adapter, system, prompt, opts };
            return { trends: ['тренд 1', 'тренд 2'] };
          },
        },
      });
      assert.deepStrictEqual(trends, ['тренд 1', 'тренд 2']);
      assert.strictEqual(seen.adapter, 'perplexity');
      assert.ok(/JSON/i.test(seen.system), 'system-промт обязан требовать JSON');
      assert.ok(/"trends"/.test(seen.system), 'system-промт обязан задавать контракт trends');
      assert.ok(/JSON/i.test(seen.prompt), 'user-промт обязан требовать JSON');
      assert.strictEqual(seen.opts.retries, 2);
    } finally {
      if (prevKey === undefined) delete process.env.PERPLEXITY_API_KEY;
      else process.env.PERPLEXITY_API_KEY = prevKey;
    }
  });

  await run('_collectPerplexityTrends: сбой LLM → fail-open []', async () => {
    const prevKey = process.env.PERPLEXITY_API_KEY;
    process.env.PERPLEXITY_API_KEY = 'test-key';
    try {
      const trends = await topicDiscovery._internal._collectPerplexityTrends({
        niche: 'шины',
        log: () => {},
        deps: { callLLM: async () => { throw new Error('JSON parse failed'); } },
      });
      assert.deepStrictEqual(trends, []);
    } finally {
      if (prevKey === undefined) delete process.env.PERPLEXITY_API_KEY;
      else process.env.PERPLEXITY_API_KEY = prevKey;
    }
  });

  await run('_collectPerplexityTrends: без PERPLEXITY_API_KEY вызова нет', async () => {
    const prevKey = process.env.PERPLEXITY_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    try {
      let called = 0;
      const trends = await topicDiscovery._internal._collectPerplexityTrends({
        niche: 'шины',
        log: () => {},
        deps: { callLLM: async () => { called += 1; return { trends: ['x'] }; } },
      });
      assert.deepStrictEqual(trends, []);
      assert.strictEqual(called, 0);
    } finally {
      if (prevKey !== undefined) process.env.PERPLEXITY_API_KEY = prevKey;
    }
  });

  await run('runTopicDiscovery: тренды Perplexity попадают в paa_questions', async () => {
    const prevKey = process.env.PERPLEXITY_API_KEY;
    process.env.PERPLEXITY_API_KEY = 'test-key';
    try {
      let payload = null;
      const result = await topicDiscovery.runTopicDiscovery({
        query: 'зимние шины',
        niche: 'шины',
        paaQuestions: ['какие шины лучше'],
        deps: {
          collectTrends: async () => null,
          callLLM: async () => ({ trends: ['шипы vs липучка 2026'] }),
          runTopicDiscovery: async (p) => { payload = p; return { topic_status: 'lack' }; },
        },
      });
      assert.strictEqual(result.signals_used.perplexity, 1);
      assert.ok(payload.paa_questions.includes('шипы vs липучка 2026'));
      assert.ok(payload.paa_questions.includes('какие шины лучше'));
    } finally {
      if (prevKey === undefined) delete process.env.PERPLEXITY_API_KEY;
      else process.env.PERPLEXITY_API_KEY = prevKey;
    }
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
