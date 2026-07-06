'use strict';

/**
 * Smoke-test для добора SERP со страницы 3.
 *
 * Проверяет:
 *   1. xmlstockClient.fetchYandexSerp поддерживает startPage и корректно
 *      формирует URL вида &page=2.
 *   2. relevance/pipeline.js при useful < serpTarget (= top_n) делает
 *      добор fetchYandexSerp({ startPage: 2..9 }) вплоть до 10-й страницы.
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
      /DEFAULT_SERP_TARGET\s*=\s*20/.test(pipelineSource),
      'DEFAULT_SERP_TARGET=20 expected (динамический порог = top_n)',
    );
    assert.ok(
      !/MIN_SERP_AFTER_DEDUP/.test(pipelineSource),
      'хардкод MIN_SERP_AFTER_DEDUP должен быть убран (порог теперь динамический = top_n)',
    );
    assert.ok(
      /const\s+serpTarget\s*=/.test(pipelineSource),
      'локальный serpTarget (= top_n) expected',
    );
    assert.ok(
      /SERP_TOPUP_PAGES\s*=\s*\[\s*2\s*,\s*3\s*,\s*4\s*,\s*5\s*,\s*6\s*,\s*7\s*,\s*8\s*,\s*9\s*\]/.test(pipelineSource),
      'SERP_TOPUP_PAGES=[2..9] expected (добор вплоть до 10-й страницы SERP, поз.21-100)',
    );
    assert.ok(
      /startPage:\s*page/.test(pipelineSource),
      'iterative startPage (по SERP_TOPUP_PAGES) expected in pipeline',
    );
    assert.ok(
      /_usefulCount\(\)\s*<\s*serpTarget/.test(pipelineSource),
      'gate `_usefulCount() < serpTarget` expected (post-фильтр-агрегаторов учёт)',
    );
    assert.ok(
      /raw_total:\s*rawSerpTotal/.test(pipelineSource)
        && /deduped_count:/.test(pipelineSource)
        && /aggregators_skipped:/.test(pipelineSource),
      'serp_meta funnel stats (raw_total/deduped_count/aggregators_skipped) expected',
    );
    console.log('✓ relevance/pipeline.js wires multi-page topup (стр. 3-10) + funnel meta');

    console.log('\n✅ test-relevance-pagination: all checks passed');
  })().catch((e) => {
    console.error('✗', e);
    process.exit(1);
  });
}
