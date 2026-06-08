'use strict';

/**
 * Smoke-test для добора SERP со страницы 3.
 *
 * Проверяет:
 *   1. xmlstockClient.fetchYandexSerp поддерживает startPage и корректно
 *      формирует URL вида &page=2.
 *   2. relevance/pipeline.js при serp.length < MIN_SERP_AFTER_DEDUP делает
 *      второй вызов fetchYandexSerp({ startPage: 2 }).
 *
 * Используем монку модулей через require.cache — без реальных HTTP-вызовов.
 */

const assert = require('assert');
const path   = require('path');

// ── 1. Юнит-тест: startPage прокидывается в URL ────────────────────────
{
  const axiosPath = require.resolve('axios');
  const calls = [];
  // Mock axios до загрузки xmlstockClient.
  require.cache[axiosPath] = {
    id:       axiosPath,
    filename: axiosPath,
    loaded:   true,
    exports:  {
      get: async (url) => {
        calls.push(url);
        // Минимально валидный XMLStock-ответ с одним doc.
        const xml = '<?xml version="1.0"?><yandexsearch><response>'
                  + '<results><grouping><group><doc>'
                  + '<title>t</title><url>https://example.com/1</url>'
                  + '<headline>h</headline></doc></group></grouping></results>'
                  + '</response></yandexsearch>';
        return { data: xml };
      },
    },
  };
  // Сброс кэша клиента — чтобы перезагрузился с замоканным axios.
  const clientPath = require.resolve('../src/services/metaTags/xmlstockClient.js');
  delete require.cache[clientPath];
  const { fetchYandexSerp } = require(clientPath);

  (async () => {
    calls.length = 0;
    await fetchYandexSerp('test', { pages: 1, startPage: 2 });
    assert.strictEqual(calls.length, 1, 'one call expected for pages=1');
    assert.ok(calls[0].includes('&page=2'), `expected page=2 in URL, got ${calls[0]}`);

    calls.length = 0;
    await fetchYandexSerp('test', { pages: 2, startPage: 0 });
    assert.strictEqual(calls.length, 2, 'two calls expected for pages=2');
    assert.ok(calls[0].includes('&page=0'), 'first call should be page=0');
    assert.ok(calls[1].includes('&page=1'), 'second call should be page=1');

    console.log('✓ xmlstockClient.startPage works correctly');

    // ── 2. Проверка добора в pipeline через прямой импорт констант ───
    // (полный pipeline требует БД — проверяем только наличие константы)
    const pipelineSource = require('fs').readFileSync(
      path.resolve(__dirname, '../src/services/relevance/pipeline.js'),
      'utf8',
    );
    assert.ok(
      /MIN_SERP_AFTER_DEDUP\s*=\s*18/.test(pipelineSource),
      'MIN_SERP_AFTER_DEDUP=18 expected',
    );
    assert.ok(
      /SERP_TOPUP_PAGES\s*=\s*\[\s*2\s*,\s*3\s*,\s*4\s*\]/.test(pipelineSource),
      'SERP_TOPUP_PAGES=[2,3,4] expected (добор со стр. 3/4/5)',
    );
    assert.ok(
      /startPage:\s*page/.test(pipelineSource),
      'iterative startPage (по SERP_TOPUP_PAGES) expected in pipeline',
    );
    assert.ok(
      /_usefulCount\(\)\s*<\s*MIN_SERP_AFTER_DEDUP/.test(pipelineSource),
      'gate `_usefulCount() < MIN_SERP_AFTER_DEDUP` expected (post-фильтр-агрегаторов учёт)',
    );
    console.log('✓ relevance/pipeline.js wires multi-page topup (стр. 3/4/5)');

    console.log('\n✅ test-relevance-pagination: all checks passed');
  })().catch((e) => {
    console.error('✗', e);
    process.exit(1);
  });
}
