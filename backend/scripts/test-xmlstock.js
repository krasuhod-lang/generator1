'use strict';

/**
 * Проверка работы XMLStock-клиента (metaTags/xmlstockClient.js) — источника
 * SERP для пайплайна релевантности. Сетевые вызовы мокаются через require.cache.
 *
 * Покрывает:
 *   1. Корректный разбор XML-ответа в {title, snippet, url} (включая снятие
 *      <hlword>-подсветки и сбор passages).
 *   2. Бесперебойность: «мягкая» ошибка <error>Запрос еще не обработан</error>
 *      поллится с паузой и затем отдаёт результат (не падает).
 *   3. Фатальная ошибка (исчерпан лимит) — бросается наружу, без бесконечного
 *      поллинга.
 *   4. Google-выдача (fetchGoogleSerp) использует путь /google/xml/.
 */

const assert = require('assert');

// Ускоряем поллинг/ретраи, чтобы тест шёл быстро.
process.env.XMLSTOCK_TRANSIENT_DELAY_MS = '1';
process.env.XMLSTOCK_TRANSIENT_MAX_DELAY_MS = '2';
process.env.XMLSTOCK_NETWORK_DELAY_MS = '1';

const AXIOS_PATH = require.resolve('axios');
const CLIENT_PATH = require.resolve('../src/services/metaTags/xmlstockClient.js');

function loadClientWithMock(getImpl) {
  const calls = [];
  require.cache[AXIOS_PATH] = {
    id: AXIOS_PATH, filename: AXIOS_PATH, loaded: true,
    exports: {
      get: async (url, cfg) => {
        calls.push(url);
        return getImpl(url, cfg, calls.length);
      },
    },
  };
  delete require.cache[CLIENT_PATH];
  // eslint-disable-next-line global-require
  const mod = require(CLIENT_PATH);
  return { mod, calls };
}

function cleanup() {
  delete require.cache[AXIOS_PATH];
  delete require.cache[CLIENT_PATH];
}

const DOC_XML =
  '<?xml version="1.0"?><yandexsearch><response><results><grouping>' +
  '<group><doc><title>Купить <hlword>шины</hlword></title>' +
  '<url>https://shop.example/p1</url><headline>Дёшево</headline>' +
  '<passages><passage>Доставка по РФ</passage></passages></doc></group>' +
  '<group><doc><title>Второй</title><url>https://shop.example/p2</url>' +
  '</doc></group></grouping></results></response></yandexsearch>';

(async () => {
  // ── 1. Разбор XML ─────────────────────────────────────────────────────
  {
    const { mod, calls } = loadClientWithMock(async () => ({ data: DOC_XML }));
    const docs = await mod.fetchYandexSerp('шины', { pages: 1 });
    assert.strictEqual(docs.length, 2, 'two docs parsed');
    assert.strictEqual(docs[0].title, 'Купить шины', 'hlword stripped from title');
    assert.strictEqual(docs[0].url, 'https://shop.example/p1');
    assert.ok(docs[0].snippet.includes('Доставка'), 'passage collected into snippet');
    assert.ok(calls[0].includes('/yandex/xml/'), 'yandex path used');
    console.log('✓ 1. XML parsing (title/url/snippet, hlword stripped)');
    cleanup();
  }

  // ── 2. Транзиентная ошибка «не обработан» → поллинг → успех ────────────
  {
    let n = 0;
    const { mod, calls } = loadClientWithMock(async () => {
      n += 1;
      if (n < 3) {
        return {
          data: '<?xml version="1.0"?><yandexsearch><response>' +
            '<error>Запрос еще не обработан, попробуйте позже</error>' +
            '</response></yandexsearch>',
        };
      }
      return { data: DOC_XML };
    });
    const docs = await mod.fetchYandexSerp('шины', { pages: 1 });
    assert.strictEqual(docs.length, 2, 'recovers after transient polling');
    assert.ok(calls.length >= 3, `expected polling (>=3 calls), got ${calls.length}`);
    console.log('✓ 2. Transient "не обработан" polled then succeeds');
    cleanup();
  }

  // ── 3. Фатальная ошибка (лимит) → throw, без бесконечного поллинга ─────
  {
    let n = 0;
    const { mod, calls } = loadClientWithMock(async () => {
      n += 1;
      return {
        data: '<?xml version="1.0"?><yandexsearch><response>' +
          '<error>Превышен лимит запросов в сутки</error></response></yandexsearch>',
      };
    });
    let threw = false;
    try {
      await mod.fetchYandexSerp('шины', { pages: 1 });
    } catch (e) {
      threw = true;
      assert.ok(/лимит|XMLStock/i.test(e.message), 'meaningful error message');
    }
    assert.ok(threw, 'fatal error must throw');
    // Фатальная ошибка не транзиентна → не должно быть длинного поллинга
    // (несколько сетевых ретраев допустимы, но не 8 транзиентных попыток).
    assert.ok(n <= 6, `fatal error should not be polled many times, got ${n}`);
    console.log('✓ 3. Fatal quota error throws (no infinite polling)');
    cleanup();
  }

  // ── 4. Google-выдача использует /google/xml/ ──────────────────────────
  {
    const { mod, calls } = loadClientWithMock(async () => ({ data: DOC_XML }));
    const docs = await mod.fetchGoogleSerp('шины', { pages: 1 });
    assert.strictEqual(docs.length, 2, 'google docs parsed');
    assert.ok(calls[0].includes('/google/xml/'), 'google path used');
    console.log('✓ 4. fetchGoogleSerp uses /google/xml/ path');
    cleanup();
  }

  console.log('\n✅ test-xmlstock: all checks passed');
})().catch((e) => {
  console.error('❌ test-xmlstock FAILED:', e);
  process.exit(1);
});
