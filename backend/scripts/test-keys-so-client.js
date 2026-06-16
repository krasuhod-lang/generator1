'use strict';

/* Tests for reports/keysSoClient (HTTP mock). */

const assert = require('assert');

process.env.KEYS_SO_API_KEY = 'test-key';
const { getDomainOverview, getDomainHistory, _normalizeDomain, KeysSoError } = require('../src/services/reports/keysSoClient');

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
      return Promise.resolve(handler(url, opts, this.calls.length));
    },
  };
}

(async () => {
  await test('_normalizeDomain strips scheme/path/case', () => {
    assert.strictEqual(_normalizeDomain('HTTPS://Vyruchai.RU/path?x=1'), 'vyruchai.ru');
    assert.strictEqual(_normalizeDomain('example.com'), 'example.com');
  });

  await test('getDomainOverview maps fields', async () => {
    const httpClient = makeClient((url) => {
      assert.match(url, /\/domain\/overview$/);
      return { data: { data: {
        visibility: 0.062, yandex_traffic: 1500, google_traffic: 2400,
        keywords_top1: 12, keywords_top3: 45, keywords_top10: 210, keywords_total: 980,
      } } };
    });
    const r = await getDomainOverview('Example.RU', { httpClient });
    assert.strictEqual(r.domain, 'example.ru');
    assert.strictEqual(r.visibility, 0.062);
    assert.strictEqual(r.keywords_top10, 210);
  });

  await test('getDomainHistory drops rows without date', async () => {
    const httpClient = makeClient(() => ({ data: { data: [
      { date: '2026-01-15', visibility: 0.04, yandex_traffic: 1000 },
      { date: '2026-02-01', visibility: 0.05, yandex_traffic: 1200 },
      { visibility: 0.99 }, // no date — dropped
    ] } }));
    const out = await getDomainHistory('x.ru', 12, { httpClient });
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].date, '2026-01-01'); // normalized to month-first
    assert.strictEqual(out[1].date, '2026-02-01');
  });

  await test('retries once on 5xx then succeeds', async () => {
    let n = 0;
    const httpClient = {
      get() {
        n++;
        if (n === 1) {
          const err = new Error('server error');
          err.response = { status: 503 };
          return Promise.reject(err);
        }
        return Promise.resolve({ data: { data: { visibility: 0.1 } } });
      },
    };
    const r = await getDomainOverview('x.ru', { httpClient });
    assert.strictEqual(n, 2);
    assert.strictEqual(r.visibility, 0.1);
  });

  await test('does not retry on 4xx', async () => {
    let n = 0;
    const httpClient = {
      get() {
        n++;
        const err = new Error('bad request');
        err.response = { status: 400, data: { message: 'invalid domain' } };
        return Promise.reject(err);
      },
    };
    let thrown = null;
    try { await getDomainOverview('x.ru', { httpClient }); }
    catch (e) { thrown = e; }
    assert.ok(thrown instanceof KeysSoError);
    assert.strictEqual(n, 1);
  });

  await test('throws when API key missing', async () => {
    const orig = process.env.KEYS_SO_API_KEY;
    delete process.env.KEYS_SO_API_KEY;
    delete require.cache[require.resolve('../src/services/reports/keysSoClient')];
    const fresh = require('../src/services/reports/keysSoClient');
    let thrown = null;
    try { await fresh.getDomainOverview('x.ru'); }
    catch (e) { thrown = e; }
    assert.ok(thrown);
    assert.match(thrown.message, /KEYS_SO_API_KEY/);
    process.env.KEYS_SO_API_KEY = orig;
    delete require.cache[require.resolve('../src/services/reports/keysSoClient')];
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
