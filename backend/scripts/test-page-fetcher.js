'use strict';

/**
 * Smoke-test для backend/src/services/relevance/pageFetcher.js.
 *
 * Проверяет escalation-логику без реальной сети:
 *   1. Cloudflare-челлендж в HTML → форс headless даже при 200 OK.
 *   2. HTTP 403 → форс headless без ожидания SPA-порога.
 *   3. Все axios-попытки failed + headless вернул HTML → success с method=headless_*.
 *   4. RELEVANCE_INTERNAL_TOKEN — прокидывается в X-Internal-Token при POST.
 *
 * Моки: подменяем axios через require.cache. Каждый кейс — изолированный модуль.
 */

const assert = require('assert');
const path   = require('path');

const PAGE_FETCHER_PATH = path.resolve(__dirname, '../src/services/relevance/pageFetcher.js');
const AXIOS_PATH        = require.resolve('axios');

function _resetCache() {
  delete require.cache[PAGE_FETCHER_PATH];
  delete require.cache[AXIOS_PATH];
  // axios-cookiejar-support / tough-cookie могут быть подгружены — не
  // трогаем их require.cache: реальные пакеты безопасны.
}

function _installAxiosMock({ onGet, onPost }) {
  const make = () => {
    const inst = {
      get:          onGet  || (async () => ({ data: '' })),
      post:         onPost || (async () => ({ data: {} })),
      interceptors: {
        request:  { handlers: [], use: () => 0, eject: () => {} },
        response: { handlers: [], use: () => 0, eject: () => {} },
      },
      defaults: { headers: { common: {} } },
    };
    inst.create = () => make();
    return inst;
  };
  const mockAxios = make();
  require.cache[AXIOS_PATH] = {
    id: AXIOS_PATH, filename: AXIOS_PATH, loaded: true, exports: mockAxios,
  };
  return mockAxios;
}

(async () => {
  // ── Кейс 1: Cloudflare-челлендж в HTML → headless вызывается ─────────
  {
    process.env.RELEVANCE_HEADLESS_FETCHER_URL = 'http://relevance_fetcher:8001/fetch';
    process.env.RELEVANCE_INTERNAL_TOKEN = 'TEST_TOKEN_42';
    _resetCache();

    let postCalls = 0;
    let lastPostHeaders = null;
    _installAxiosMock({
      onGet: async () => ({
        // Длинный HTML, но содержит cf-marker — должен сработать форс headless.
        data: '<html><head><title>Just a moment...</title></head><body>'
            + '<script src="cdn-cgi/challenge-platform/x.js"></script>'
            + 'x'.repeat(20000) + '</body></html>',
      }),
      onPost: async (url, body, opts) => {
        postCalls += 1;
        lastPostHeaders = opts && opts.headers || null;
        return { data: { html: '<html><body>real content via headless</body></html>' } };
      },
    });

    const { fetchOne } = require(PAGE_FETCHER_PATH);
    const r = await fetchOne('https://example.com/cf');
    assert.ok(r.html, 'expected html');
    assert.ok(/headless/.test(r.method), `expected headless method, got ${r.method}`);
    assert.ok(/real content via headless/.test(r.html), 'expected headless body');
    assert.strictEqual(postCalls, 1, 'headless POST called once');
    assert.ok(lastPostHeaders && lastPostHeaders['X-Internal-Token'] === 'TEST_TOKEN_42',
      'X-Internal-Token must be passed through');
    console.log('✓ Cloudflare-marker → headless forced + token forwarded');
  }

  // ── Кейс 2: HTTP 403 → headless форс без axios-retry ─────────────────
  {
    process.env.RELEVANCE_HEADLESS_FETCHER_URL = 'http://relevance_fetcher:8001/fetch';
    delete process.env.RELEVANCE_INTERNAL_TOKEN;
    _resetCache();

    let getCalls = 0;
    _installAxiosMock({
      onGet: async () => {
        getCalls += 1;
        const err = new Error('403');
        err.response = { status: 403 };
        err.code = 'ERR_BAD_REQUEST';
        throw err;
      },
      onPost: async () => ({ data: { html: '<html>headless rescue</html>' } }),
    });

    const { fetchOne } = require(PAGE_FETCHER_PATH);
    const r = await fetchOne('https://waf.example.com/');
    assert.ok(r.html, 'expected html (headless rescue)');
    assert.ok(/headless/.test(r.method), `method should be headless, got ${r.method}`);
    // axios попытка №1 + retry №2 (UA googlebot) — но цена 1 уже отдала 403,
    // и до того как уйти на UA-retry мы должны попробовать headless.
    assert.ok(getCalls >= 1, 'axios должен быть вызван хотя бы раз');
    console.log('✓ HTTP 403 → headless escalation works');
  }

  // ── Кейс 3: headless выключен + всё падает → graceful failure ────────
  {
    delete process.env.RELEVANCE_HEADLESS_FETCHER_URL;
    delete process.env.RELEVANCE_INTERNAL_TOKEN;
    _resetCache();

    _installAxiosMock({
      onGet: async () => {
        const err = new Error('boom');
        err.code = 'ECONNRESET';
        throw err;
      },
    });

    const { fetchOne } = require(PAGE_FETCHER_PATH);
    const r = await fetchOne('https://dead.example.com/');
    assert.ok(!r.html, 'no html expected');
    assert.ok(r.error, 'error string expected');
    assert.ok(r.code, 'category code expected');
    console.log('✓ no headless + axios fail → graceful {error, code}');
  }

  console.log('\n✅ test-page-fetcher: all checks passed');
})().catch((e) => {
  console.error('✗', e);
  process.exit(1);
});
