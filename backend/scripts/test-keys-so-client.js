'use strict';

/* Tests for reports/keysSoClient (HTTP mock).
 * Verifies the real Keys.so API contract (X-Keyso-TOKEN header,
 * /report/simple/domain_dashboard endpoint, it1/it3/it10/it50/vis fields,
 * embedded history keyed YYYY.MM with visAvg).
 */

const assert = require('assert');

process.env.KEYS_SO_API_KEY = 'test-key';
const {
  getDomainDashboard, getDomainOverview, getDomainHistory,
  _normalizeDomain, _normalizeBase, _monthKeyToDate,
  KeysSoError,
} = require('../src/services/reports/keysSoClient');

let passed = 0; let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log('FAIL  -', name, '\n        ', e.message); }
}

function makeClient(handler) {
  return {
    calls: [],
    get(url, opts) {
      this.calls.push({ url, opts });
      const out = handler(url, opts, this.calls.length);
      if (out && out.then) return out;
      return Promise.resolve(out);
    },
  };
}

const DASH = {
  it1: 12, it3: 45, it5: 110, it10: 210, it50: 980,
  vis: 0.062, dr: 47, pagesinindex: 1234,
  adtraf: 50, adkeyscnt: 30,
  history: {
    '2026.01': { it1: 5, it3: 22, it10: 150, it50: 800, visAvg: 0.04 },
    '2026.02': { it1: 8, it3: 30, it10: 180, it50: 900, visAvg: 0.05 },
    '2026.03': { it1: 12, it3: 45, it10: 210, it50: 980, visAvg: 0.062 },
  },
};

(async () => {
  await test('_normalizeDomain strips scheme/path/www/case', () => {
    assert.strictEqual(_normalizeDomain('HTTPS://www.Vyruchai.RU/path?x=1'), 'vyruchai.ru');
    assert.strictEqual(_normalizeDomain('example.com'), 'example.com');
  });

  await test('_normalizeBase falls back to msk for invalid', () => {
    assert.strictEqual(_normalizeBase('SPB'), 'spb');
    assert.strictEqual(_normalizeBase(''), 'msk');
    assert.strictEqual(_normalizeBase('xx'), 'msk');
  });

  await test('_monthKeyToDate handles YYYY.MM and YYYY-MM', () => {
    assert.strictEqual(_monthKeyToDate('2026.03'), '2026-03-01');
    assert.strictEqual(_monthKeyToDate('2026-3'), '2026-03-01');
    assert.strictEqual(_monthKeyToDate('garbage'), null);
  });

  await test('getDomainDashboard hits correct path and headers', async () => {
    const httpClient = makeClient((url, opts) => {
      assert.strictEqual(url, 'https://api.keys.so/report/simple/domain_dashboard');
      assert.strictEqual(opts.headers['X-Keyso-TOKEN'], 'test-key');
      assert.strictEqual(opts.params.base, 'msk');
      assert.strictEqual(opts.params.domain, 'example.ru');
      return { data: DASH };
    });
    const r = await getDomainDashboard('Example.RU', { httpClient });
    assert.strictEqual(r.overview.domain, 'example.ru');
    assert.strictEqual(r.overview.visibility, 0.062);
    assert.strictEqual(r.overview.keywords_top1, 12);
    assert.strictEqual(r.overview.keywords_top10, 210);
    assert.strictEqual(r.overview.keywords_total, 980);
    assert.strictEqual(r.overview.domain_rating, 47);
    assert.strictEqual(r.history.length, 3);
    assert.strictEqual(r.history[0].date, '2026-01-01');
    assert.strictEqual(r.history[2].keywords_top10, 210);
  });

  await test('getDomainDashboard passes custom base', async () => {
    const httpClient = makeClient((url, opts) => {
      assert.strictEqual(opts.params.base, 'spb');
      return { data: DASH };
    });
    await getDomainDashboard('x.ru', { httpClient, base: 'spb' });
  });

  await test('getDomainOverview is a thin wrapper', async () => {
    const httpClient = makeClient(() => ({ data: DASH }));
    const o = await getDomainOverview('x.ru', { httpClient });
    assert.strictEqual(o.keywords_top10, 210);
    assert.strictEqual(o.visibility, 0.062);
    assert.strictEqual(o.yandex_traffic, null);     // API has no per-engine split
    assert.strictEqual(o.google_traffic, null);
  });

  await test('getDomainHistory slices to last N months sorted', async () => {
    const httpClient = makeClient(() => ({ data: DASH }));
    const out = await getDomainHistory('x.ru', 2, { httpClient });
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].date, '2026-02-01');
    assert.strictEqual(out[1].date, '2026-03-01');
  });

  await test('throws KeysSoError when no API key', async () => {
    const orig = process.env.KEYS_SO_API_KEY;
    const orig2 = process.env.KEYSSO_API_KEY;
    delete process.env.KEYS_SO_API_KEY;
    delete process.env.KEYSSO_API_KEY;
    try {
      await getDomainDashboard('x.ru', { httpClient: makeClient(() => ({ data: {} })) });
      throw new Error('should have thrown');
    } catch (e) {
      assert.ok(e instanceof KeysSoError);
      assert.strictEqual(e.code, 'no_api_key');
    } finally {
      process.env.KEYS_SO_API_KEY = orig;
      if (orig2) process.env.KEYSSO_API_KEY = orig2;
    }
  });

  await test('falls back to KEYSSO_API_KEY when KEYS_SO_API_KEY missing', async () => {
    const orig = process.env.KEYS_SO_API_KEY;
    delete process.env.KEYS_SO_API_KEY;
    process.env.KEYSSO_API_KEY = 'fallback-key';
    try {
      const httpClient = makeClient((_url, opts) => {
        assert.strictEqual(opts.headers['X-Keyso-TOKEN'], 'fallback-key');
        return { data: DASH };
      });
      await getDomainDashboard('x.ru', { httpClient });
    } finally {
      process.env.KEYS_SO_API_KEY = orig;
      delete process.env.KEYSSO_API_KEY;
    }
  });

  await test('retries once on 5xx then succeeds', async () => {
    let n = 0;
    const httpClient = {
      get(_url, _opts) {
        n += 1;
        if (n === 1) {
          const err = new Error('boom');
          err.response = { status: 502 };
          return Promise.reject(err);
        }
        return Promise.resolve({ data: DASH });
      },
    };
    const r = await getDomainDashboard('x.ru', { httpClient });
    assert.strictEqual(n, 2);
    assert.strictEqual(r.overview.keywords_top10, 210);
  });

  await test('retries once on 429 then succeeds', async () => {
    let n = 0;
    const httpClient = {
      get(_url, _opts) {
        n += 1;
        if (n === 1) {
          const err = new Error('rate-limited');
          err.response = { status: 429, headers: { 'retry-after': '0' } };
          return Promise.reject(err);
        }
        return Promise.resolve({ data: DASH });
      },
    };
    const r = await getDomainDashboard('x.ru', { httpClient });
    assert.strictEqual(n, 2);
    assert.strictEqual(r.overview.keywords_top10, 210);
  });

  await test('does not retry on 401 (auth)', async () => {
    let n = 0;
    const httpClient = {
      get() {
        n += 1;
        const err = new Error('unauth');
        err.response = { status: 401, data: { message: 'bad token' } };
        return Promise.reject(err);
      },
    };
    try { await getDomainDashboard('x.ru', { httpClient }); throw new Error('expected'); }
    catch (e) {
      assert.ok(e instanceof KeysSoError);
      assert.strictEqual(e.code, 'unauthorized');
      assert.strictEqual(n, 1);
    }
  });

  await test('history with malformed entries is filtered', async () => {
    const httpClient = makeClient(() => ({ data: {
      ...DASH,
      history: { 'bad-key': { it1: 1 }, '2026.01': { it1: 2, visAvg: 0.01 } },
    } }));
    const r = await getDomainDashboard('x.ru', { httpClient });
    assert.strictEqual(r.history.length, 1);
    assert.strictEqual(r.history[0].date, '2026-01-01');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
