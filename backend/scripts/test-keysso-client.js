'use strict';

/**
 * Smoke-tests для backend/src/services/forecaster/keyssoClient.js.
 *
 *   • graceful skip без API-ключа / без домена / без фраз
 *   • mapping произвольного «региона» в код базы keys.so
 *   • парсинг ответа /report/simple/organic/keywords
 *   • aggregateSignals: avg_position, %top10/30, momentum, медиана только
 *     если есть competition (его API не отдаёт → медиана null)
 *   • mock-fetch end-to-end: пагинация, авторизация X-Keyso-TOKEN, кэш
 *   • graceful на HTTP-ошибке первой страницы
 *
 * Запуск: `node backend/scripts/test-keysso-client.js`
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

  console.log('\n=== _resolveBase: region aliases ===');
  ok('msk → msk',                ks._resolveBase('msk',                'msk') === 'msk');
  ok('"Москва" → msk',           ks._resolveBase('Москва',             'msk') === 'msk');
  ok('"Россия" → msk',           ks._resolveBase('Россия',             'msk') === 'msk');
  ok('"Санкт-Петербург" → spb',  ks._resolveBase('Санкт-Петербург',    'msk') === 'spb');
  ok('"СПб" → spb',              ks._resolveBase('СПб',                'msk') === 'spb');
  ok('"Екатеринбург" → ekb',     ks._resolveBase('Екатеринбург',       'msk') === 'ekb');
  ok('unknown → fallback',       ks._resolveBase('Антарктида',         'msk') === 'msk');
  ok('empty → fallback',         ks._resolveBase('',                   'msk') === 'msk');
  ok('"google" → gru',           ks._resolveBase('google',             'msk') === 'gru');

  console.log('\n=== _parsePage: real keys.so shape ===');
  const p1 = ks._parsePage({
    current_page: 1, per_page: 25, last_page: 1, total: 3,
    data: [
      { word: 'окна пвх',  pos: 3,  ws: 14000, wsk: 800, delta:  1 },
      { word: 'окна цены', pos: 15, ws:  4000, wsk: 400, delta: -2 },
      { word: 'установка', pos:  0, ws:   100, wsk:  10, delta:  0 },
    ],
  });
  ok('p1 size=3', p1.size === 3);
  ok('p1 pos parsed',           p1.get('окна пвх')?.current_position === 3);
  ok('p1 freq from wsk',        p1.get('окна пвх')?.demand_index === 800);
  ok('p1 delta parsed',         p1.get('окна цены')?.position_3m_delta === -2);
  ok('p1 pos=0 stays 0',        p1.get('установка')?.current_position === 0);
  ok('p1 competition=null',     p1.get('окна пвх')?.top10_competition === null);
  ok('p1 normalises case+space',
     ks._parsePage({ data: [{ word: '  Купить ОКНА  ', pos: 7 }] }).has('купить окна'));

  console.log('\n=== aggregateSignals ===');
  const agg = ks.aggregateSignals(p1, 5);
  ok('aggregate.requested=5', agg.requested === 5);
  ok('aggregate.matched=3',   agg.matched === 3);
  // avg of 3,15 (2 with pos>0) = 9.0
  ok('avg_current_position == 9.0',
     Math.abs(agg.avg_current_position - 9.0) < 0.01,
     `got=${agg.avg_current_position}`);
  // 1/3 in top10
  ok('phrases_in_top10_pct ≈ 33.3', Math.abs(agg.phrases_in_top10_pct - 33.3) < 0.1);
  // 2/3 in top30
  ok('phrases_in_top30_pct ≈ 66.7', Math.abs(agg.phrases_in_top30_pct - 66.7) < 0.1);
  // 1 off top50 (pos=0)
  ok('phrases_off_top50_pct ≈ 33.3', Math.abs(agg.phrases_off_top50_pct - 33.3) < 0.1);
  // competition is null in all rows → median должен быть null
  ok('median_competition is null when API не отдаёт', agg.median_competition === null);

  console.log('\n=== aggregate momentum classifier ===');
  const mk = (delta) => ({ current_position: 5, top10_competition: null, demand_index: 100, position_3m_delta: delta });
  const posSignals = new Map([['a', mk(2)], ['b', mk(1)]]);
  ok('momentum positive when avg delta > 0.5',
     ks.aggregateSignals(posSignals, 2).momentum === 'positive');
  const negSignals = new Map([['a', mk(-3)], ['b', mk(-1)]]);
  ok('momentum negative when avg delta < -0.5',
     ks.aggregateSignals(negSignals, 2).momentum === 'negative');
  const flatSignals = new Map([['a', mk(0)], ['b', mk(0)]]);
  ok('momentum neutral when ~0',
     ks.aggregateSignals(flatSignals, 2).momentum === 'neutral');

  console.log('\n=== mock fetch end-to-end + cache + auth header ===');
  ks._cacheClear();
  let calls = 0;
  let lastHeaders = null;
  let lastUrl = null;
  // Имитация API keys.so: возвращает 2 страницы по 2 элемента.
  const fakeFetch = async (url, init) => {
    calls += 1;
    lastHeaders = init.headers || {};
    lastUrl = url;
    const u = new URL(url);
    const page = Number(u.searchParams.get('page'));
    if (page === 1) {
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          current_page: 1, per_page: 2, last_page: 2, total: 3,
          data: [
            { word: 'ph1', pos: 5,  wsk: 200, delta:  1 },
            { word: 'ph2', pos: 12, wsk: 100, delta: -1 },
          ],
        }),
      };
    }
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        current_page: 2, per_page: 2, last_page: 2, total: 3,
        data: [{ word: 'ph3', pos: 25, wsk: 80, delta: 0 }],
      }),
    };
  };

  process.env.KEYSSO_API_KEY = 'secret-token';
  const r1 = await ks.fetchPhraseSignals({
    phrases: ['ph1', 'ph2', 'ph3', 'ph_missing'],
    domain:  'https://example.com/',
    region:  'Москва',
    fetchImpl: fakeFetch,
  });
  ok('mock: verdict=ok',                r1.verdict === 'ok');
  ok('mock: matched=3 (intersect)',     r1.matched === 3, `matched=${r1.matched}`);
  ok('mock: requested=4',               r1.requested === 4);
  ok('mock: paginated 2 pages',         calls === 2, `calls=${calls}`);
  ok('mock: domain stripped of scheme', r1.domain === 'example.com');
  ok('mock: region resolved to msk',    r1.region === 'msk', `region=${r1.region}`);
  ok('mock: uses X-Keyso-TOKEN header', lastHeaders && lastHeaders['X-Keyso-TOKEN'] === 'secret-token');
  ok('mock: hits /report/simple/organic/keywords',
     typeof lastUrl === 'string' && lastUrl.includes('/report/simple/organic/keywords'));
  ok('mock: query has base=msk',        typeof lastUrl === 'string' && lastUrl.includes('base=msk'));
  ok('mock: query has domain=example.com',
     typeof lastUrl === 'string' && lastUrl.includes('domain=example.com'));

  // Повторный вызов — должен попасть в кеш (calls не вырастет)
  const r2 = await ks.fetchPhraseSignals({
    phrases: ['ph1'],
    domain:  'example.com',
    region:  'мск',
    fetchImpl: fakeFetch,
  });
  ok('mock: 2nd run cache_hits>0', r2.cache_hits > 0, `cache_hits=${r2.cache_hits}`);
  ok('mock: 2nd run no extra http calls', calls === 2, `calls=${calls}`);
  ok('mock: 2nd run matched=1',    r2.matched === 1);

  console.log('\n=== respects maxPhrasesPerTask cap ===');
  ks._cacheClear();
  calls = 0;
  const big = Array.from({ length: 1000 }, (_, i) => `phrase_${i}`);
  const emptyFetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ current_page: 1, per_page: 500, last_page: 1, total: 0, data: [] }),
  });
  const r3 = await ks.fetchPhraseSignals({
    phrases: big,
    domain:  'example.com',
    fetchImpl: emptyFetch,
  });
  ok('mock: requested capped at 300', r3.requested === 300, `requested=${r3.requested}`);

  console.log('\n=== graceful on HTTP error of first page (verdict=error, no throw) ===');
  ks._cacheClear();
  const failFetch = async () => ({ ok: false, status: 500, text: async () => '{"err":"oops"}' });
  const r4 = await ks.fetchPhraseSignals({
    phrases: ['x', 'y'],
    domain:  'example.com',
    fetchImpl: failFetch,
  });
  ok('mock: 500 → verdict=error',
     r4.verdict === 'error',
     `verdict=${r4.verdict} reason=${r4.reason}`);
  ok('mock: 500 → matched=0',
     r4.matched === 0, `matched=${r4.matched}`);

  console.log('\n=== graceful on 401 (wrong token) ===');
  ks._cacheClear();
  const unauthFetch = async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' });
  const r5 = await ks.fetchPhraseSignals({
    phrases: ['x'],
    domain:  'example.com',
    fetchImpl: unauthFetch,
  });
  ok('mock: 401 → verdict=error', r5.verdict === 'error');
  ok('mock: 401 → reason mentions 401',
     typeof r5.reason === 'string' && r5.reason.includes('401'),
     `reason=${r5.reason}`);

  if (prev !== undefined) process.env.KEYSSO_API_KEY = prev;
  else delete process.env.KEYSSO_API_KEY;

  console.log(`\n=== Result: ${passed} passed / ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
})();
