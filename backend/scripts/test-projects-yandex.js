'use strict';

/**
 * Smoke-тест интеграции Яндекс.Вебмастера в модуле «Проекты».
 * Покрывает детерминированные части без сети: OAuth state (общий с GSC),
 * формирование auth-url, _resolveHostId и модуль сопоставления источников
 * (sourceComparison) с рекомендациями.
 *
 * Запуск: node backend/scripts/test-projects-yandex.js
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-projects-yandex';

const assert = require('assert');

let passed = 0;
let failed = 0;
const asyncQueue = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    // eslint-disable-next-line no-console
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    // eslint-disable-next-line no-console
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}
// Асинхронные тесты выполняются строго последовательно (часть из них
// подменяет глобальный axios.get и общий кэш — параллельный запуск гонялся бы).
function atest(name, fn) {
  asyncQueue.push(async () => {
    try {
      await fn();
      passed += 1;
      // eslint-disable-next-line no-console
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.error(`  ✗ ${name}\n    ${err.message}`);
    }
  });
}

// ── ydxClient: OAuth state + auth-url ───────────────────────────────
const ydx = require('../src/services/projects/ydxClient');

test('ydx buildState/verifyState roundtrip', () => {
  const st = ydx.buildState('proj-1', 'user-1');
  const decoded = ydx.verifyState(st);
  assert.ok(decoded, 'state must verify');
  assert.strictEqual(decoded.projectId, 'proj-1');
  assert.strictEqual(decoded.userId, 'user-1');
});

test('ydx verifyState rejects tampered state', () => {
  const st = ydx.buildState('p', 'u');
  const bad = st.slice(0, -2) + (st.slice(-2) === 'AA' ? 'BB' : 'AA');
  assert.strictEqual(ydx.verifyState(bad), null);
});

test('ydx buildAuthUrl throws when not configured', () => {
  const saved = process.env.YANDEX_CLIENT_ID;
  delete process.env.YANDEX_CLIENT_ID;
  assert.throws(() => ydx.buildAuthUrl('p', 'u'), (e) => e.code === 'ydx_not_configured');
  if (saved != null) process.env.YANDEX_CLIENT_ID = saved;
});

test('ydx buildAuthUrl builds proper OAuth url when configured', () => {
  process.env.YANDEX_CLIENT_ID = 'cid';
  process.env.YANDEX_CLIENT_SECRET = 'secret';
  process.env.YANDEX_OAUTH_REDIRECT_URI = 'https://app/api/oauth/yandex/callback';
  const url = ydx.buildAuthUrl('p', 'u');
  assert.ok(url.startsWith('https://oauth.yandex.ru/authorize?'), 'yandex authorize endpoint');
  assert.ok(url.includes('client_id=cid'), 'client_id present');
  assert.ok(url.includes('response_type=code'), 'code flow');
  assert.ok(/state=/.test(url), 'state present');
  delete process.env.YANDEX_CLIENT_ID;
  delete process.env.YANDEX_CLIENT_SECRET;
  delete process.env.YANDEX_OAUTH_REDIRECT_URI;
});

// ── ydxService: _resolveHostId ──────────────────────────────────────
const ydxService = require('../src/services/projects/ydxService');

test('ydxService _resolveHostId maps selected site to host_id', () => {
  const project = {
    ydx_site_url: 'example.com',
    ydx_available_sites: [
      { siteUrl: 'example.com', hostId: 'https:example.com:443' },
      { siteUrl: 'other.com', hostId: 'https:other.com:443' },
    ],
  };
  assert.strictEqual(ydxService._resolveHostId(project), 'https:example.com:443');
});

test('ydxService _resolveHostId falls back to site url when no match', () => {
  assert.strictEqual(
    ydxService._resolveHostId({ ydx_site_url: 'x.com', ydx_available_sites: [] }),
    'x.com',
  );
});

// ── ydxClient.queryPopularAll: безлимитная постраничная выборка ──────
const axios = require('axios');

async function withStubbedAxios(pages, fn) {
  const orig = axios.get;
  ydx._clearCache();
  axios.get = async (url) => {
    const m = String(url).match(/[?&]offset=(\d+)/);
    const offset = m ? Number(m[1]) : 0;
    return { data: { queries: pages[offset] || [] } };
  };
  try { return await fn(); } finally { axios.get = orig; }
}

function _q(n) {
  return Array.from({ length: n }, (_, i) => ({ query_text: `q${i}`, indicators: {} }));
}

atest('queryPopularAll paginates until a short page (no limit)', async () => {
  // pageSize=500 (config). Две полные страницы + короткая последняя.
  const pages = { 0: _q(500), 500: _q(500), 1000: _q(10) };
  const rows = await withStubbedAxios(pages, () =>
    ydx.queryPopularAll('tok', 'uid', 'host', { dateFrom: '2024-01-01', dateTo: '2024-01-28' }));
  assert.strictEqual(rows.length, 1010, 'pulls all rows across pages');
});

atest('queryPopularAll stops on first empty page', async () => {
  const rows = await withStubbedAxios({ 0: [] }, () =>
    ydx.queryPopularAll('tok', 'uid', 'host', { dateFrom: '2024-01-01', dateTo: '2024-01-28' }));
  assert.strictEqual(rows.length, 0);
});

// ── sourceComparison ────────────────────────────────────────────────
const { compareSources } = require('../src/services/projects/sourceComparison');

const GSC = {
  totals: { clicks: 100, impressions: 1000, ctr: 10, position: 5 },
  topQueries: [
    { key: 'купить телефон', clicks: 50, impressions: 400, ctr: 12.5, position: 3 },
    { key: 'обзор телефона', clicks: 5, impressions: 100, ctr: 5, position: 8 },
  ],
};
const YDX = {
  totals: { clicks: 20, impressions: 900, ctr: 2.2, position: 9 },
  topQueries: [
    { key: 'Купить Телефон', clicks: 2, impressions: 300, ctr: 0.67, position: 15 },
    { key: 'цена телефона', clicks: 3, impressions: 120, ctr: 2.5, position: 6 },
  ],
};

test('compareSources flags both sources present', () => {
  const r = compareSources(GSC, YDX);
  assert.strictEqual(r.has_google, true);
  assert.strictEqual(r.has_yandex, true);
});

test('compareSources matches queries case-insensitively', () => {
  const r = compareSources(GSC, YDX);
  assert.strictEqual(r.queries.overlap_count, 1, 'купить телефон overlaps regardless of case');
  assert.strictEqual(r.queries.only_google_count, 1, 'обзор телефона only in Google');
  assert.strictEqual(r.queries.only_yandex_count, 1, 'цена телефона only in Yandex');
});

test('compareSources computes position_delta (>0 means better in Yandex)', () => {
  const r = compareSources(GSC, YDX);
  const overlap = r.queries.overlap[0];
  // google position 3, yandex position 15 → delta = 3 - 15 = -12 (better in Google)
  assert.strictEqual(overlap.position_delta, -12);
});

test('compareSources totals include share split for clicks/impressions', () => {
  const r = compareSources(GSC, YDX);
  const clicks = r.totals.find((t) => t.metric === 'Клики');
  assert.strictEqual(clicks.google, 100);
  assert.strictEqual(clicks.yandex, 20);
  assert.strictEqual(clicks.google_share, 83.3);
  assert.strictEqual(clicks.yandex_share, 16.7);
});

test('compareSources recommends connecting the missing source', () => {
  const onlyG = compareSources(GSC, null);
  assert.ok(onlyG.recommendations.some((rec) => /Подключите Яндекс/i.test(rec.title)));
  const onlyY = compareSources(null, YDX);
  assert.ok(onlyY.recommendations.some((rec) => /Подключите Google/i.test(rec.title)));
});

test('compareSources recommends Yandex work when its click share is low', () => {
  const r = compareSources(GSC, YDX); // yandex ~16.7% clicks
  assert.ok(r.recommendations.some((rec) => /Слабые позиции в Яндексе/i.test(rec.title)));
});

test('compareSources surfaces queries lagging in one engine', () => {
  const r = compareSources(GSC, YDX);
  // купить телефон: Google pos 3 vs Yandex pos 15 → lagging in Yandex
  assert.ok(r.recommendations.some((rec) => /проседают в Яндексе/i.test(rec.title)));
});

test('compareSources with no data returns info recommendation', () => {
  const r = compareSources(null, null);
  assert.strictEqual(r.has_google, false);
  assert.strictEqual(r.has_yandex, false);
  assert.ok(r.recommendations.some((rec) => rec.priority === 'info'));
});

test('compareSources is pure (does not mutate inputs)', () => {
  const g = JSON.parse(JSON.stringify(GSC));
  const y = JSON.parse(JSON.stringify(YDX));
  compareSources(g, y);
  assert.deepStrictEqual(g, JSON.parse(JSON.stringify(GSC)));
  assert.deepStrictEqual(y, JSON.parse(JSON.stringify(YDX)));
});

// eslint-disable-next-line no-console
(async () => {
  for (const run of asyncQueue) { await run(); } // eslint-disable-line no-await-in-loop
  // eslint-disable-next-line no-console
  console.log(`\nYandex/Projects smoke: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
