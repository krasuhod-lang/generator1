'use strict';

/**
 * Unit-тесты отказоустойчивого парсера страниц (relevance/pageFetcher.js).
 *
 * Покрывает требования ТЗ «отказоустойчивый HTML-парсер по URL»:
 *   1. Ротация User-Agent — в заголовках случайный, но валидный UA из пула.
 *   2. Retry с экспоненциальным backoff при 503 — парсер не падает сразу,
 *      делает повторы и в итоге отдаёт HTML (retries_used > 0).
 *   3. Жёсткая недоступность (ENOTFOUND / несуществующий домен) — пайплайн
 *      продолжает работу: возвращается стандартизированный объект ошибки
 *      с code='dns', без исключения.
 *   4. Поддержка прокси — при заданном RELEVANCE_PROXY_URL axios-запрос
 *      туннелируется через proxy-agent (httpsAgent установлен, proxy:false).
 *   5. Диагностика/эскалация — categoryOf (категории fail-причин),
 *      _tierOfMethod / per-domain память успешного метода с TTL
 *      (RELEVANCE_DOMAIN_METHOD_TTL_MS), вывод FETCH_HTML_URL из
 *      RELEVANCE_HEADLESS_FETCHER_URL и kill-switch
 *      RELEVANCE_CURL_CFFI_ESCALATION.
 *
 * HTTP мокается через подмену require.cache (без реальной сети).
 */

const assert = require('assert');

const AXIOS_PATH = require.resolve('axios');
const JAR_PATH = require.resolve('axios-cookiejar-support');
const TOUGH_PATH = require.resolve('tough-cookie');
const HPA_PATH = require.resolve('https-proxy-agent');
const FETCHER_PATH = require.resolve('../src/services/relevance/pageFetcher.js');

/**
 * Устанавливает мок-окружение и (пере)загружает pageFetcher.
 * @param {object} cfg
 * @param {function} cfg.handler — async (url, axiosCfg) => response | throws
 * @returns {{mod, calls}}
 */
function loadFetcherWithMock({ handler, proxyClass = true }) {
  const calls = [];
  const instance = {
    get: async (url, axiosCfg) => {
      calls.push({ url, cfg: axiosCfg });
      return handler(url, axiosCfg);
    },
    post: async () => { throw new Error('headless not configured'); },
  };
  const axiosMock = {
    create: () => instance,
    get: instance.get,
    post: instance.post,
  };

  require.cache[AXIOS_PATH] = {
    id: AXIOS_PATH, filename: AXIOS_PATH, loaded: true, exports: axiosMock,
  };
  // cookie-jar wrapper → возвращаем инстанс как есть (изоляция от tough-cookie).
  require.cache[JAR_PATH] = {
    id: JAR_PATH, filename: JAR_PATH, loaded: true,
    exports: { wrapper: (inst) => inst },
  };
  require.cache[TOUGH_PATH] = {
    id: TOUGH_PATH, filename: TOUGH_PATH, loaded: true,
    exports: { CookieJar: class CookieJar {} },
  };
  if (proxyClass) {
    require.cache[HPA_PATH] = {
      id: HPA_PATH, filename: HPA_PATH, loaded: true,
      exports: {
        HttpsProxyAgent: class HttpsProxyAgent {
          constructor(u) { this.proxyUrl = u; this.__isProxyAgent = true; }
        },
      },
    };
  }

  delete require.cache[FETCHER_PATH];
  // eslint-disable-next-line global-require
  const mod = require(FETCHER_PATH);
  return { mod, calls };
}

function cleanup() {
  for (const p of [AXIOS_PATH, JAR_PATH, TOUGH_PATH, HPA_PATH, FETCHER_PATH]) {
    delete require.cache[p];
  }
}

const HTML_OK =
  '<html><head><title>ok</title></head><body>' +
  '<main>'.padEnd(4000, 'x') + '</main></body></html>';

function httpError(status) {
  return Object.assign(new Error(`Request failed ${status}`), {
    response: { status },
  });
}

(async () => {
  // Быстрый backoff в тестах — без реальных длинных пауз.
  process.env.RELEVANCE_RETRY_BASE_DELAY_MS = '0';
  delete process.env.RELEVANCE_PROXY_URL;
  delete process.env.RELEVANCE_PROXY_LIST;

  // ── 1. Ротация User-Agent ────────────────────────────────────────────
  {
    const { mod, calls } = loadFetcherWithMock({
      handler: async () => ({ data: HTML_OK }),
    });
    const res = await mod.fetchOne('https://example.com/a');
    assert.ok(res.html, 'expected html on success');
    assert.strictEqual(res.retries_used, 0, 'no retries on first-try success');
    const ua = calls[0].cfg.headers['User-Agent'];
    assert.ok(
      mod.USER_AGENT_POOL.includes(ua),
      `User-Agent must come from the pool, got: ${ua}`,
    );
    // Обязательные anti-bot заголовки из ТЗ.
    assert.ok(calls[0].cfg.headers.Accept, 'Accept header required');
    assert.ok(calls[0].cfg.headers['Accept-Language'], 'Accept-Language required');
    assert.ok(calls[0].cfg.headers.Referer, 'Referer header required');
    console.log('✓ 1. User-Agent rotation + anti-bot headers');
    cleanup();
  }

  // ── 2. Retry с backoff при 503 → успех ───────────────────────────────
  {
    let attempt = 0;
    const { mod, calls } = loadFetcherWithMock({
      handler: async () => {
        attempt += 1;
        if (attempt === 1) throw httpError(503);
        return { data: HTML_OK };
      },
    });
    const res = await mod.fetchOne('https://example.com/flaky');
    assert.ok(res.html, 'expected html after retry');
    assert.ok(res.retries_used >= 1, `retries_used must be >=1, got ${res.retries_used}`);
    assert.ok(calls.length >= 2, `expected >=2 attempts, got ${calls.length}`);
    console.log('✓ 2. Retry on 503 recovers (retries_used=' + res.retries_used + ')');
    cleanup();
  }

  // ── 3. Несуществующий домен (ENOTFOUND) → стандартизированная ошибка ──
  {
    const { mod } = loadFetcherWithMock({
      handler: async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND nope.invalid'), {
          code: 'ENOTFOUND',
        });
      },
    });
    const res = await mod.fetchOne('https://nope.invalid/x');
    assert.ok(!res.html, 'no html for dead domain');
    assert.strictEqual(res.code, 'dns', `expected code=dns, got ${res.code}`);
    assert.ok(res.error, 'error string present');
    assert.ok(typeof res.retries_used === 'number', 'retries_used present');
    console.log('✓ 3. Dead domain → standardized error {code: dns}, no throw');
    cleanup();
  }

  // ── 4. fetchPages не падает при частичных сбоях ───────────────────────
  {
    const { mod } = loadFetcherWithMock({
      handler: async (url) => {
        if (url.includes('bad')) {
          throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
        }
        return { data: HTML_OK };
      },
    });
    const out = await mod.fetchPages([
      'https://good.com/1', 'https://bad.com/2', 'https://good.com/3',
    ]);
    assert.strictEqual(out.successes.length, 2, 'two successes expected');
    assert.strictEqual(out.failures.length, 1, 'one failure expected');
    assert.ok('retries_used' in out.successes[0], 'success carries retries_used');
    console.log('✓ 4. fetchPages tolerates partial failures');
    cleanup();
  }

  // ── 5. Поддержка прокси (RELEVANCE_PROXY_URL) ────────────────────────
  {
    process.env.RELEVANCE_PROXY_URL = 'http://proxy.local:8080';
    const { mod, calls } = loadFetcherWithMock({
      handler: async () => ({ data: HTML_OK }),
    });
    assert.strictEqual(mod.PROXY_AVAILABLE, true, 'proxy pool should be available');
    const res = await mod.fetchOne('https://example.com/proxied');
    assert.ok(res.html, 'expected html through proxy');
    const cfg = calls[0].cfg;
    assert.ok(cfg.httpsAgent && cfg.httpsAgent.__isProxyAgent, 'httpsAgent must be proxy agent');
    assert.strictEqual(cfg.proxy, false, 'axios built-in proxy disabled when agent used');
    console.log('✓ 5. Proxy support wires https-proxy-agent');
    cleanup();
    delete process.env.RELEVANCE_PROXY_URL;
  }

  // ── 6. proxies_enabled=false отключает прокси даже при заданном пуле ──
  {
    process.env.RELEVANCE_PROXY_URL = 'http://proxy.local:8080';
    const { mod, calls } = loadFetcherWithMock({
      handler: async () => ({ data: HTML_OK }),
    });
    await mod.fetchOne('https://example.com/noproxy', { proxiesEnabled: false });
    assert.ok(!calls[0].cfg.httpsAgent, 'no proxy agent when proxiesEnabled=false');
    console.log('✓ 6. proxies_enabled=false bypasses proxy');
    cleanup();
    delete process.env.RELEVANCE_PROXY_URL;
  }

  // ── 7. categoryOf: верхнеуровневая категория причины fail'а ──────────
  {
    const { mod } = loadFetcherWithMock({ handler: async () => ({ data: HTML_OK }) });
    assert.strictEqual(mod.categoryOf('http_403'), 'waf');
    assert.strictEqual(mod.categoryOf('http_429'), 'waf');
    assert.strictEqual(mod.categoryOf('http_500', 'captcha detected'), 'captcha');
    assert.strictEqual(mod.categoryOf('empty_body', 'подтвердите, что вы не робот'), 'captcha');
    assert.strictEqual(mod.categoryOf('timeout'), 'timeout');
    assert.strictEqual(mod.categoryOf('http_524'), 'timeout');
    assert.strictEqual(mod.categoryOf('tls'), 'ssl');
    assert.strictEqual(mod.categoryOf('dns'), 'dns');
    assert.strictEqual(mod.categoryOf('empty_body'), 'empty');
    assert.strictEqual(mod.categoryOf('http_404'), 'not_found');
    assert.strictEqual(mod.categoryOf('http_503'), 'waf_or_5xx');
    assert.strictEqual(mod.categoryOf('http_418'), 'http_error');
    assert.strictEqual(mod.categoryOf('conn_reset'), 'network');
    assert.strictEqual(mod.categoryOf('headless_fail'), 'headless');
    assert.strictEqual(mod.categoryOf(''), 'unknown');
    console.log('✓ 7. categoryOf maps codes/errors to diagnostic categories');
    cleanup();
  }

  // ── 8. _tierOfMethod: имя метода → уровень эскалации ─────────────────
  {
    const { mod } = loadFetcherWithMock({ handler: async () => ({ data: HTML_OK }) });
    assert.strictEqual(mod._tierOfMethod('axios'), 0);
    assert.strictEqual(mod._tierOfMethod('axios_retry'), 0);
    assert.strictEqual(mod._tierOfMethod('curl_cffi'), 1);
    assert.strictEqual(mod._tierOfMethod('headless'), 2);
    assert.strictEqual(mod._tierOfMethod('headless_spa'), 2);
    assert.strictEqual(mod._tierOfMethod(''), 0);
    assert.strictEqual(mod._tierOfMethod(null), 0);
    console.log('✓ 8. _tierOfMethod maps method names to escalation tiers');
    cleanup();
  }

  // ── 9. Per-domain память: remember → recommend, www-нормализация, TTL ─
  {
    const { mod } = loadFetcherWithMock({ handler: async () => ({ data: HTML_OK }) });
    assert.strictEqual(mod._recommendedTier('https://fresh.example/x'), 0,
      'unknown domain starts at tier 0');
    mod._rememberDomainMethod('https://www.blocked.example/page', 'headless');
    assert.strictEqual(mod._recommendedTier('https://blocked.example/other'), 2,
      'www. prefix must be normalized to the same host');
    mod._rememberDomainMethod('https://soft.example/a', 'curl_cffi');
    assert.strictEqual(mod._recommendedTier('https://soft.example/b'), 1);
    mod._rememberDomainMethod('not a url', 'headless'); // не должен бросать
    assert.strictEqual(mod._recommendedTier('also not a url'), 0);
    console.log('✓ 9. per-domain memory: remember/recommend + www normalization');
    cleanup();
  }

  // ── 10. Per-domain память: протухание по RELEVANCE_DOMAIN_METHOD_TTL_MS ─
  {
    process.env.RELEVANCE_DOMAIN_METHOD_TTL_MS = '1';
    const { mod } = loadFetcherWithMock({ handler: async () => ({ data: HTML_OK }) });
    mod._rememberDomainMethod('https://stale.example/', 'headless');
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(mod._recommendedTier('https://stale.example/'), 0,
      'expired record must fall back to tier 0');
    assert.ok(!mod._domainMethodStats.has('stale.example'),
      'expired record must be evicted from the map');
    console.log('✓ 10. per-domain memory expires by TTL');
    cleanup();
    delete process.env.RELEVANCE_DOMAIN_METHOD_TTL_MS;
  }

  // ── 11. FETCH_HTML_URL выводится из HEADLESS_FETCHER_URL + kill-switch ─
  {
    process.env.RELEVANCE_HEADLESS_FETCHER_URL = 'http://relevance_fetcher:8001/fetch';
    delete process.env.RELEVANCE_CURL_CFFI_ESCALATION;
    let loaded = loadFetcherWithMock({ handler: async () => ({ data: HTML_OK }) });
    assert.strictEqual(loaded.mod.FETCH_HTML_URL,
      'http://relevance_fetcher:8001/fetch_html',
      '/fetch tail must be rewritten to /fetch_html');
    assert.strictEqual(loaded.mod.CURL_CFFI_ENABLED, true,
      'curl_cffi escalation enabled by default when fetch_html URL is derivable');
    cleanup();

    process.env.RELEVANCE_CURL_CFFI_ESCALATION = 'false';
    loaded = loadFetcherWithMock({ handler: async () => ({ data: HTML_OK }) });
    assert.strictEqual(loaded.mod.CURL_CFFI_ENABLED, false,
      'RELEVANCE_CURL_CFFI_ESCALATION=false is a kill-switch');
    cleanup();

    delete process.env.RELEVANCE_CURL_CFFI_ESCALATION;
    delete process.env.RELEVANCE_HEADLESS_FETCHER_URL;
    loaded = loadFetcherWithMock({ handler: async () => ({ data: HTML_OK }) });
    assert.strictEqual(loaded.mod.CURL_CFFI_ENABLED, false,
      'no headless fetcher URL → curl_cffi disabled');
    cleanup();
    console.log('✓ 11. FETCH_HTML_URL derivation + CURL_CFFI_ENABLED kill-switch');
  }

  console.log('\n✅ test-relevance-pagefetcher: all checks passed');
})().catch((e) => {
  console.error('❌ test-relevance-pagefetcher FAILED:', e);
  process.exit(1);
});
