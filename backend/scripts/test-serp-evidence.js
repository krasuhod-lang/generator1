'use strict';

/**
 * test-serp-evidence.js — юнит-тесты для serpEvidence.service.js (Phase 1, P0-2).
 *
 * Проверяет в изоляции:
 *   • LRU-кэш с TTL: hit/miss, eviction по размеру, expiration по TTL.
 *   • Дедуп SERP по host + URL (моки на fetchYandexSerp и pageFetcher).
 *   • Передачу top_k_paragraphs / max_chars_per_url в Python-клиент.
 *   • renderEvidenceForPrompt: формат, лимит maxUrls/maxSnippetChars,
 *     graceful '' при пустом evidence.
 *   • Graceful degradation: SERP пуст / fetch упал / Python вернул ошибку.
 *
 * Без реальной сети, без БД. Mock'и подменяются через require.cache до
 * первого require сервиса.
 *
 * Запуск:  node backend/scripts/test-serp-evidence.js
 */

const assert = require('assert');
const path   = require('path');
const Module = require('module');

// Изолируем env, влияющие на лимиты сервиса (детерминируем тест).
process.env.INFO_ARTICLE_GROUNDING_TOP_N = '3';
process.env.INFO_ARTICLE_GROUNDING_TOP_K = '2';
process.env.INFO_ARTICLE_GROUNDING_MAX_CHARS_PER_URL = '1000';
// Маленький TTL для теста expiration (1 секунда — но через моки времени
// мы ниже подменяем Date.now, чтобы тест не ждал реально).
process.env.INFO_ARTICLE_GROUNDING_CACHE_TTL_S = '60';
process.env.INFO_ARTICLE_GROUNDING_CACHE_MAX = '3';

// ── Mocks ─────────────────────────────────────────────────────────────
//
// Используем стратегию «inject in require cache before service loads».
// Это надёжнее, чем proxyquire/monkey-patch (никаких внешних зависимостей,
// и мок виден ВСЕМ потребителям).

const xmlstockPath = require.resolve(
  path.join(__dirname, '..', 'src', 'services', 'metaTags', 'xmlstockClient'),
);
const fetcherPath = require.resolve(
  path.join(__dirname, '..', 'src', 'services', 'relevance', 'pageFetcher'),
);
const pythonClientPath = require.resolve(
  path.join(__dirname, '..', 'src', 'services', 'relevance', 'pythonClient'),
);

// State holders (mutable across tests; mock functions delegate to these).
const _state = {
  serpFn:   async () => [],
  fetchFn:  async () => ({ successes: [], failures: [] }),
  pythonFn: async () => ({ evidence: [], stats: {} }),
};

const fakeXmlstock = {
  fetchYandexSerp: async (...args) => _state.serpFn(...args),
  XMLSTOCK_URL: 'fake://test',
};
const fakeFetcher = {
  fetchPages: async (...args) => _state.fetchFn(...args),
};
const fakeEvidenceClient = {
  evidence: async (...args) => _state.pythonFn(...args),
  // unused but required for shape compat
  analyze: async () => ({}),
  cocoons: async () => ({}),
  compare: async () => ({}),
  health: async () => ({ ok: true }),
  RELEVANCE_BASE_URL: 'fake://test',
  ANALYZE_TIMEOUT_MS: 1000,
};

require.cache[xmlstockPath]      = { id: xmlstockPath,      filename: xmlstockPath,      loaded: true, exports: fakeXmlstock };
require.cache[fetcherPath]       = { id: fetcherPath,       filename: fetcherPath,       loaded: true, exports: fakeFetcher };
require.cache[pythonClientPath]  = { id: pythonClientPath,  filename: pythonClientPath,  loaded: true, exports: fakeEvidenceClient };

// Now require the service (with mocks already in place).
const serpEvidence = require(
  path.join(__dirname, '..', 'src', 'services', 'infoArticle', 'serpEvidence.service'),
);
const {
  buildSerpEvidence,
  renderEvidenceForPrompt,
  _cacheClear,
  _cacheStats,
  _cacheKey,
  TOP_N,
  TOP_K,
  MAX_CHARS_PER_URL,
  CACHE_MAX_ENTRIES,
  CACHE_TTL_MS,
} = serpEvidence;

// ── Test helpers ──────────────────────────────────────────────────────

let _caseCount = 0;
let _passCount = 0;
function check(name, fn) {
  _caseCount += 1;
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => { _passCount += 1; console.log(`  ✓ ${name}`); },
        (e) => { console.log(`  ❌ ${name}\n     ${e && e.message ? e.message : e}`); },
      );
    }
    _passCount += 1;
    console.log(`  ✓ ${name}`);
    return undefined;
  } catch (e) {
    console.log(`  ❌ ${name}\n     ${e && e.message ? e.message : e}`);
    return undefined;
  }
}

function setSerp(items)   { _state.serpFn = async () => items; }
function setFetch(result) { _state.fetchFn = async () => result; }
function setPython(fn)    { _state.pythonFn = fn; }
function rejectSerp(err)  { _state.serpFn = async () => { throw err; }; }
function rejectPython(err){ _state.pythonFn = async () => { throw err; }; }

// ── Tests ─────────────────────────────────────────────────────────────

(async function main() {
  console.log('\n=== Test 1: env-clamps applied ===');
  check('TOP_N respects env',     () => assert.strictEqual(TOP_N, 3));
  check('TOP_K respects env',     () => assert.strictEqual(TOP_K, 2));
  check('MAX_CHARS respects env', () => assert.strictEqual(MAX_CHARS_PER_URL, 1000));
  check('CACHE_MAX respects env', () => assert.strictEqual(CACHE_MAX_ENTRIES, 3));
  check('CACHE_TTL_MS respects env (60s)', () => assert.strictEqual(CACHE_TTL_MS, 60_000));

  console.log('\n=== Test 2: empty query → empty result, no SERP call ===');
  _cacheClear();
  let serpCalled = 0;
  _state.serpFn = async () => { serpCalled += 1; return []; };
  await check('empty query returns warnings=[empty_query]', async () => {
    const r = await buildSerpEvidence({ query: '' });
    assert.deepStrictEqual(r.evidence, []);
    assert.ok(r.warnings.includes('empty_query'));
    assert.strictEqual(serpCalled, 0, 'SERP must not be called');
  });

  console.log('\n=== Test 3: SERP failure → graceful empty ===');
  _cacheClear();
  rejectSerp(new Error('xmlstock down'));
  await check('serp_failed warning emitted', async () => {
    const r = await buildSerpEvidence({ query: 'test query' });
    assert.deepStrictEqual(r.evidence, []);
    assert.ok(r.warnings.some((w) => w.startsWith('serp_failed:')), `got ${JSON.stringify(r.warnings)}`);
  });

  console.log('\n=== Test 4: SERP empty → empty result ===');
  _cacheClear();
  setSerp([]);
  await check('serp_empty warning emitted', async () => {
    const r = await buildSerpEvidence({ query: 'test query' });
    assert.deepStrictEqual(r.evidence, []);
    assert.ok(r.warnings.includes('serp_empty'));
  });

  console.log('\n=== Test 5: SERP host-dedup respects topN=3 ===');
  _cacheClear();
  setSerp([
    { url: 'https://example.com/a' },
    { url: 'https://example.com/b' },                // same host → skipped
    { url: 'https://www.example.com/c' },            // www-equiv same host → skipped
    { url: 'https://b.ru/x' },
    { url: 'https://b.ru/y' },                        // dup host → skipped
    { url: 'https://c.ru/z' },
    { url: 'https://d.ru/q' },                        // exceeds topN=3 → not requested
  ]);
  let pyPayload = null;
  setFetch({
    successes: [
      { url: 'https://example.com/a', html: '<p>a</p>' },
      { url: 'https://b.ru/x',         html: '<p>b</p>' },
      { url: 'https://c.ru/z',         html: '<p>c</p>' },
    ],
    failures: [],
  });
  setPython(async (payload) => {
    pyPayload = payload;
    return {
      evidence: payload.documents.map((d, i) => ({
        url: d.url, h1: '', text_chars: 100, parsed_method: 'mock',
        empty_reason: null,
        snippets: [{ text: `snippet-${i}`, score: 1.0 - i * 0.1, position: 0 }],
      })),
      stats: {},
    };
  });
  await check('topN=3 unique-host URLs sent to fetchPages', async () => {
    const r = await buildSerpEvidence({ query: 'test query' });
    assert.strictEqual(r.evidence.length, 3);
    assert.strictEqual(r.stats.fetched_count, 3);
    assert.strictEqual(r.stats.snippet_count, 3);
    assert.strictEqual(r.stats.cache_hit, false);
    assert.strictEqual(r.stats.source, 'serp');
    // serp_position подмешана
    assert.deepStrictEqual(
      r.evidence.map((e) => e.serp_position).sort(),
      [1, 2, 3],
    );
  });
  check('options forwarded to /evidence (top_k=2, max_chars=1000)', () => {
    assert.ok(pyPayload, 'python should be called');
    assert.strictEqual(pyPayload.options.top_k_paragraphs, 2);
    assert.strictEqual(pyPayload.options.max_chars_per_url, 1000);
    assert.strictEqual(pyPayload.documents.length, 3);
  });

  console.log('\n=== Test 6: cache hit on second call ===');
  // (Cache populated by Test 5 above.)
  let pyHits = 0;
  setPython(async (p) => { pyHits += 1; return { evidence: [], stats: {} }; });
  await check('second call → cache_hit=true, no python call', async () => {
    const r = await buildSerpEvidence({ query: 'test query' });
    assert.strictEqual(r.stats.cache_hit, true);
    assert.strictEqual(r.stats.source, 'cache');
    assert.strictEqual(pyHits, 0, 'python must not be called on cache hit');
    assert.strictEqual(r.evidence.length, 3, 'cached evidence preserved');
  });
  await check('force=true bypasses cache', async () => {
    setSerp([{ url: 'https://e.ru/p' }]);
    setFetch({ successes: [{ url: 'https://e.ru/p', html: '<p>e</p>' }], failures: [] });
    setPython(async () => ({ evidence: [{ url: 'https://e.ru/p', snippets: [], h1: '', text_chars: 0, parsed_method: 'mock', empty_reason: null }], stats: {} }));
    const r = await buildSerpEvidence({ query: 'test query', force: true });
    assert.strictEqual(r.stats.cache_hit, false);
  });

  console.log('\n=== Test 7: LRU eviction at CACHE_MAX_ENTRIES=3 ===');
  _cacheClear();
  setSerp([{ url: 'https://x.ru/1' }]);
  setFetch({ successes: [{ url: 'https://x.ru/1', html: '<p>x</p>' }], failures: [] });
  setPython(async () => ({ evidence: [{ url: 'https://x.ru/1', snippets: [], h1: '', text_chars: 0, parsed_method: 'mock', empty_reason: null }], stats: {} }));
  await buildSerpEvidence({ query: 'q1' });
  await buildSerpEvidence({ query: 'q2' });
  await buildSerpEvidence({ query: 'q3' });
  check('cache filled to size=3', () => assert.strictEqual(_cacheStats().size, 3));
  await buildSerpEvidence({ query: 'q4' });   // should evict 'q1' (oldest)
  check('cache still at max after 4th insert', () => assert.strictEqual(_cacheStats().size, 3));
  // q2/q3/q4 should hit; q1 should miss (=> python called again)
  let pyCalls = 0;
  setPython(async () => { pyCalls += 1; return { evidence: [], stats: {} }; });
  await buildSerpEvidence({ query: 'q2' });
  await buildSerpEvidence({ query: 'q3' });
  await buildSerpEvidence({ query: 'q4' });
  check('q2/q3/q4 all hit cache (no python calls)', () => assert.strictEqual(pyCalls, 0));
  await buildSerpEvidence({ query: 'q1' });   // miss → python called once
  check('q1 evicted → python called', () => assert.strictEqual(pyCalls, 1));

  console.log('\n=== Test 8: cache TTL expiration ===');
  _cacheClear();
  // We monkey-patch Date.now to fast-forward beyond TTL without sleeping.
  const realNow = Date.now;
  setSerp([{ url: 'https://t.ru/1' }]);
  setFetch({ successes: [{ url: 'https://t.ru/1', html: '<p>t</p>' }], failures: [] });
  let pyHitsTtl = 0;
  setPython(async () => { pyHitsTtl += 1; return { evidence: [], stats: {} }; });
  await buildSerpEvidence({ query: 'expiry' });
  await check('immediate re-call → cache hit', async () => {
    const r = await buildSerpEvidence({ query: 'expiry' });
    assert.strictEqual(r.stats.cache_hit, true);
    assert.strictEqual(pyHitsTtl, 1);
  });
  // Fast-forward Date.now beyond TTL
  Date.now = () => realNow() + CACHE_TTL_MS + 1000;
  try {
    await check('after TTL → cache miss, python re-called', async () => {
      const r = await buildSerpEvidence({ query: 'expiry' });
      assert.strictEqual(r.stats.cache_hit, false);
      assert.strictEqual(pyHitsTtl, 2);
    });
  } finally {
    Date.now = realNow;
  }

  console.log('\n=== Test 9: cacheKey is stable & query-normalized ===');
  const k1 = _cacheKey({ query: 'Тест Запрос', region: '213', topN: 5, topK: 5, maxChars: 1500 });
  const k2 = _cacheKey({ query: '  тест запрос  ', region: '213', topN: 5, topK: 5, maxChars: 1500 });
  const k3 = _cacheKey({ query: 'тест запрос', region: '177', topN: 5, topK: 5, maxChars: 1500 });
  check('case+whitespace normalised → same key', () => assert.strictEqual(k1, k2));
  check('different region → different key', () => assert.notStrictEqual(k1, k3));

  console.log('\n=== Test 10: fetch all-failed → graceful ===');
  _cacheClear();
  setSerp([{ url: 'https://f.ru/1' }, { url: 'https://g.ru/1' }]);
  setFetch({ successes: [], failures: [{ url: 'https://f.ru/1', code: 'http_403' }, { url: 'https://g.ru/1', code: 'timeout' }] });
  await check('fetch_all_failed → empty evidence + warning', async () => {
    const r = await buildSerpEvidence({ query: 'all-fail' });
    assert.deepStrictEqual(r.evidence, []);
    assert.ok(r.warnings.includes('fetch_all_failed'));
    assert.ok(r.warnings.some((w) => w.startsWith('fetch_failed:')));
  });

  console.log('\n=== Test 11: python /evidence error → graceful ===');
  _cacheClear();
  setSerp([{ url: 'https://p.ru/1' }]);
  setFetch({ successes: [{ url: 'https://p.ru/1', html: '<p>p</p>' }], failures: [] });
  rejectPython(new Error('relevance-service /evidence 500: oom'));
  await check('python error → empty evidence + warning', async () => {
    const r = await buildSerpEvidence({ query: 'py-err' });
    assert.deepStrictEqual(r.evidence, []);
    assert.ok(r.warnings.some((w) => w.startsWith('evidence_service_failed:')), `got ${JSON.stringify(r.warnings)}`);
  });

  console.log('\n=== Test 12: renderEvidenceForPrompt ===');
  check('empty evidence → "" ', () => {
    assert.strictEqual(renderEvidenceForPrompt(null), '');
    assert.strictEqual(renderEvidenceForPrompt({ evidence: [] }), '');
    assert.strictEqual(renderEvidenceForPrompt({ evidence: [{ url: 'a', snippets: [] }] }), '');
  });
  check('non-empty evidence → contains URL, snippet, header', () => {
    const out = renderEvidenceForPrompt({
      evidence: [
        { url: 'https://a.ru/x', h1: 'Header A', serp_position: 1,
          snippets: [{ text: 'Текст сниппета один.', score: 1.2, position: 0 }] },
        { url: 'https://b.ru/y', h1: '', serp_position: 2,
          snippets: [{ text: 'Snippet two.', score: 0.5, position: 0 }] },
      ],
    });
    assert.ok(out.includes('SERP_EVIDENCE'), 'has header');
    assert.ok(out.includes('https://a.ru/x'),  'has url1');
    assert.ok(out.includes('Header A'),        'has h1');
    assert.ok(out.includes('Текст сниппета'),  'has snippet1');
    assert.ok(out.includes('https://b.ru/y'),  'has url2');
    assert.ok(out.includes('Snippet two'),     'has snippet2');
    assert.ok(out.includes('[#1]') && out.includes('[#2]'), 'has serp positions');
  });
  check('maxUrls limit honored', () => {
    const ev = { evidence: [] };
    for (let i = 0; i < 10; i += 1) {
      ev.evidence.push({
        url: `https://x.ru/${i}`, h1: '', serp_position: i + 1,
        snippets: [{ text: `s${i}`, score: 1, position: 0 }],
      });
    }
    const out = renderEvidenceForPrompt(ev, { maxUrls: 3 });
    assert.ok(out.includes('https://x.ru/0'));
    assert.ok(out.includes('https://x.ru/2'));
    assert.ok(!out.includes('https://x.ru/3'), 'cut at maxUrls=3');
  });
  check('maxSnippetChars trims long snippets', () => {
    const long = 'A'.repeat(5000);
    const out = renderEvidenceForPrompt(
      { evidence: [{ url: 'https://a.ru/x', h1: '', serp_position: 1, snippets: [{ text: long, score: 1, position: 0 }] }] },
      { maxSnippetChars: 100 },
    );
    // Total output should be reasonably small (header + ~100ch line).
    assert.ok(out.length < 800, `expected truncation, got len=${out.length}`);
  });
  check('skips items with empty snippets in render (counter resets)', () => {
    const out = renderEvidenceForPrompt({
      evidence: [
        { url: 'https://nope.ru/x', h1: '', serp_position: 1, snippets: [] },
        { url: 'https://yes.ru/x',  h1: '', serp_position: 2, snippets: [{ text: 'ok', score: 1, position: 0 }] },
      ],
    });
    assert.ok(out.includes('https://yes.ru/x'));
    assert.ok(!out.includes('https://nope.ru/x'));
    assert.ok(out.includes('(1)'), 'numbering starts from 1 even if first item skipped');
  });

  console.log('\n' + '─'.repeat(60));
  if (_passCount === _caseCount) {
    console.log(`✅ All ${_caseCount} serpEvidence tests passed`);
    process.exit(0);
  } else {
    console.log(`❌ ${_caseCount - _passCount}/${_caseCount} serpEvidence tests failed`);
    process.exit(1);
  }
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
