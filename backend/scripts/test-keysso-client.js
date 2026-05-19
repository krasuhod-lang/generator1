'use strict';

/**
 * Smoke-tests для backend/src/services/forecaster/keyssoClient.js.
 *
 *   • graceful skip без API-ключа
 *   • парсинг разных форматов ответа keys.so
 *   • aggregateSignals: avg_position, %top10, median_competition, momentum
 *   • mock-fetch end-to-end + проверка in-memory кеша
 *
 * Запуск: `node backend/scripts/test-keysso-client.js`
 * Без реальных HTTP-вызовов: подменяем fetch локальной функцией.
 */

const ks = require('../src/services/forecaster/keyssoClient');

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else      { failed += 1; console.error(`  ✗ ${name}  ${extra}`); }
}

(async () => {
  console.log('\n=== graceful skips ===');
  const prev = process.env.KEYSSO_API_KEY;
  delete process.env.KEYSSO_API_KEY;
  ks._cacheClear();
  let resp = await ks.fetchPhraseSignals({ phrases: ['x'], domain: 'example.com' });
  ok('no API key → verdict=skipped, reason=no_api_key',
     resp.verdict === 'skipped' && resp.reason === 'no_api_key');

  process.env.KEYSSO_API_KEY = 'test-key';
  resp = await ks.fetchPhraseSignals({ phrases: ['x'], domain: '' });
  ok('no domain → verdict=skipped, reason=no_domain',
     resp.verdict === 'skipped' && resp.reason === 'no_domain');

  resp = await ks.fetchPhraseSignals({ phrases: [], domain: 'example.com' });
  ok('no phrases → verdict=skipped, reason=no_phrases',
     resp.verdict === 'skipped' && resp.reason === 'no_phrases');

  console.log('\n=== _parseResponse: data[domain][phrase] ===');
  const p1 = ks._parseResponse({
    data: { 'example.com': {
      'окна пвх':     { position: 3,  competition: 0.4, frequency: 800, position_3m_delta:  1 },
      'окна цены':    { position: 15, competition: 0.7, frequency: 400, position_3m_delta: -2 },
    } },
  }, 'example.com');
  ok('p1 size=2', p1.size === 2);
  ok('p1 окна пвх.position=3', p1.get('окна пвх')?.current_position === 3);
  ok('p1 окна цены.comp=0.7', p1.get('окна цены')?.top10_competition === 0.7);

  console.log('\n=== _parseResponse: results[] ===');
  const p2 = ks._parseResponse({
    results: [
      { phrase: 'Купить ОКНА', pos: 7, comp: 0.55, freq: 1200, trend: 0.5 },
      { keyword: 'установка',  position: 22, competition_index: 0.30 },
    ],
  });
  ok('p2 size=2', p2.size === 2);
  ok('p2 normalises case', p2.has('купить окна'));
  ok('p2 trend mapped', p2.get('купить окна')?.position_3m_delta === 0.5);

  console.log('\n=== _parseResponse: items[] (alt schema) ===');
  const p3 = ks._parseResponse({
    items: [
      { kw: 'a', pos: 1, comp: 0.10 },
      { kw: 'b', pos: 5, comp: 0.50 },
      { kw: 'c', pos: 12, comp: 0.80 },
      { kw: 'd', pos: 0,  comp: 0.30 },  // не в топ-100
    ],
  });
  ok('p3 size=4', p3.size === 4);
  ok('p3 pos clamped to 200 not raised', p3.get('a')?.current_position === 1);
  ok('p3 pos=0 stays 0', p3.get('d')?.current_position === 0);

  console.log('\n=== aggregateSignals ===');
  const agg = ks.aggregateSignals(p3, 4);
  ok('aggregate.requested=4', agg.requested === 4);
  ok('aggregate.matched=4',   agg.matched === 4);
  // avg of 1,5,12 (3 with pos>0) = 6.0
  ok('avg_current_position == 6.0',
     Math.abs(agg.avg_current_position - 6.0) < 0.01,
     `got=${agg.avg_current_position}`);
  // 2/4 in top10 = 50%
  ok('phrases_in_top10_pct == 50.0',
     Math.abs(agg.phrases_in_top10_pct - 50.0) < 0.01,
     `got=${agg.phrases_in_top10_pct}`);
  // 3/4 in top30 = 75%
  ok('phrases_in_top30_pct == 75.0',
     Math.abs(agg.phrases_in_top30_pct - 75.0) < 0.01,
     `got=${agg.phrases_in_top30_pct}`);
  // 1/4 off top50 (d=0) = 25%
  ok('phrases_off_top50_pct == 25.0',
     Math.abs(agg.phrases_off_top50_pct - 25.0) < 0.01,
     `got=${agg.phrases_off_top50_pct}`);
  ok('median_competition computed', agg.median_competition != null);

  console.log('\n=== aggregate momentum classifier ===');
  const posSignals = new Map();
  posSignals.set('a', { current_position: 5, top10_competition: 0.1, demand_index: 100, position_3m_delta:  2 });
  posSignals.set('b', { current_position: 8, top10_competition: 0.2, demand_index: 50,  position_3m_delta:  1 });
  ok('momentum positive when avg delta > 0.5',
     ks.aggregateSignals(posSignals, 2).momentum === 'positive');

  const negSignals = new Map();
  negSignals.set('a', { current_position: 5, top10_competition: 0.1, demand_index: 100, position_3m_delta: -3 });
  negSignals.set('b', { current_position: 8, top10_competition: 0.2, demand_index: 50,  position_3m_delta: -1 });
  ok('momentum negative when avg delta < -0.5',
     ks.aggregateSignals(negSignals, 2).momentum === 'negative');

  const flatSignals = new Map();
  flatSignals.set('a', { current_position: 5, top10_competition: 0.1, demand_index: 100, position_3m_delta:  0 });
  flatSignals.set('b', { current_position: 8, top10_competition: 0.2, demand_index: 50,  position_3m_delta:  0 });
  ok('momentum neutral when ~0',
     ks.aggregateSignals(flatSignals, 2).momentum === 'neutral');

  console.log('\n=== mock fetch end-to-end + cache ===');
  ks._cacheClear();
  let calls = 0;
  const fakeFetch = async (url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    const out  = {};
    out[body.domain] = {};
    for (const ph of body.phrases) {
      out[body.domain][ph] = { position: 5, competition: 0.3, frequency: 100, position_3m_delta: 1 };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: out }),
    };
  };
  process.env.KEYSSO_API_KEY = 'test-key';
  const r1 = await ks.fetchPhraseSignals({
    phrases: ['ph1', 'ph2', 'ph3'],
    domain:  'example.com',
    region:  'msk',
    fetchImpl: fakeFetch,
  });
  ok('mock: verdict=ok', r1.verdict === 'ok');
  ok('mock: matched=3',  r1.matched === 3);
  ok('mock: cache_hits=0 first run', r1.cache_hits === 0);
  ok('mock: 1 http call (batch size > 3)', calls === 1, `calls=${calls}`);

  // повторный вызов — должен попасть в кэш
  const r2 = await ks.fetchPhraseSignals({
    phrases: ['ph1', 'ph2', 'ph3'],
    domain:  'example.com',
    region:  'msk',
    fetchImpl: fakeFetch,
  });
  ok('mock: 2nd run cache_hits=3', r2.cache_hits === 3, `cache_hits=${r2.cache_hits}`);
  ok('mock: 2nd run no extra http call', calls === 1, `calls=${calls}`);

  console.log('\n=== respects maxPhrasesPerTask ===');
  ks._cacheClear();
  calls = 0;
  const big = Array.from({ length: 1000 }, (_, i) => `phrase_${i}`);
  const r3 = await ks.fetchPhraseSignals({
    phrases: big,
    domain:  'example.com',
    fetchImpl: fakeFetch,
  });
  ok('mock: requested <= maxPhrasesPerTask (300)', r3.requested <= 300, `requested=${r3.requested}`);

  console.log('\n=== graceful on HTTP error (no throw) ===');
  ks._cacheClear();
  const failFetch = async () => ({ ok: false, status: 500, text: async () => '{"err":"oops"}' });
  const r4 = await ks.fetchPhraseSignals({
    phrases: ['x', 'y'],
    domain:  'example.com',
    fetchImpl: failFetch,
  });
  ok('mock: 500 → verdict=ok, matched=0 (graceful)',
     r4.verdict === 'ok' && r4.matched === 0,
     `verdict=${r4.verdict} matched=${r4.matched}`);

  if (prev !== undefined) process.env.KEYSSO_API_KEY = prev;
  else delete process.env.KEYSSO_API_KEY;

  console.log(`\n=== Result: ${passed} passed / ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
})();
