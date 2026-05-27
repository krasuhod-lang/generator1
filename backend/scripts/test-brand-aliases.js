'use strict';

/**
 * Smoke-тест Sprint A (бренд-привязка):
 *   • stemWord/canonTitleStem: словоформы → одна основа.
 *   • detectDuplicates: stem-exact ловит «прокладка/прокладки».
 *   • filterDuplicates: dropDuplicates режим.
 *   • brandAliases: _charBigrams + _cosineBigrams + recordAlias/resolve flow с mock-db.
 */

const assert = require('assert');
const path   = require('path');

const {
  stemWord,
  canonTitleStem,
  normalizeBrandKey,
} = require(path.join(__dirname, '..', 'src', 'services', 'articleTopics', 'brandKey'));

const {
  detectDuplicates,
  filterDuplicates,
  _stemTokens,
} = require(path.join(__dirname, '..', 'src', 'services', 'articleTopics', 'topicDuplicateDetector'));

const brandAliases = require(path.join(__dirname, '..', 'src', 'services', 'articleTopics', 'brandAliases'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { const p = fn(); if (p && typeof p.then === 'function') return p.then(() => { console.log(`✓ ${name}`); pass += 1; }, (e) => { console.error(`✗ ${name}\n   ${e.message}`); fail += 1; }); console.log(`✓ ${name}`); pass += 1; }
  catch (e) { console.error(`✗ ${name}\n   ${e.message}`); fail += 1; }
  return Promise.resolve();
}

(async () => {
  await test('stemWord: ru noun forms collapse to one stem', () => {
    const s1 = stemWord('прокладки');
    const s2 = stemWord('прокладка');
    const s3 = stemWord('прокладок');
    // Все три формы должны давать одинаковый общий префикс длиной ≥ 7.
    const common = [s1, s2, s3].reduce((a, b) => {
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
      return a.slice(0, i);
    });
    assert.ok(common.length >= 7, `expected long common stem, got "${common}" from [${s1},${s2},${s3}]`);
  });

  await test('stemWord: short words and digits untouched', () => {
    assert.strictEqual(stemWord('crm'), 'crm');
    assert.strictEqual(stemWord('h2o'), 'h2o');
    assert.strictEqual(stemWord('2026'), '2026');
  });

  await test('canonTitleStem: word-form titles align (nom sg / pl)', () => {
    const a = canonTitleStem('Выбор прокладки для радиатора');
    const b = canonTitleStem('Выбор прокладок для радиатора');
    // After stemming, both should resolve to highly overlapping forms.
    // We accept either exact equality OR ≥75% token overlap.
    if (a !== b) {
      const at = new Set(a.split(' '));
      const bt = new Set(b.split(' '));
      let inter = 0;
      for (const t of at) if (bt.has(t)) inter += 1;
      const ratio = inter / Math.max(at.size, bt.size);
      assert.ok(ratio >= 0.75, `stem-canon should align: "${a}" vs "${b}" (overlap=${ratio})`);
    }
  });

  await test('_stemTokens: produces non-empty tokens', () => {
    const t = _stemTokens('Как выбрать прокладки в 2026');
    assert.ok(t.length >= 3, `expected ≥3 tokens, got ${JSON.stringify(t)}`);
  });

  await test('detectDuplicates: EXACT_STEM by word-form', async () => {
    // history содержит «системы»; кандидат «систем» — другая словоформа.
    // Стемминг должен дать одинаковый canon для обеих.
    const history = [
      { id: 1, topic_title_canon: 'интеграции crm системы', topic_h1_canon: null, topic_idea_task_id: 't1', created_at: '2026-01-01' },
    ];
    const candidates = [{ title: 'Интеграция CRM систем' }];
    const r = await detectDuplicates({ candidates, history, flags: { enabled: true, useLlm: false } });
    assert.ok(r.enriched[0].duplicate_of, `expected duplicate_of, got null. stats=${JSON.stringify(r.stats)}`);
    assert.ok(
      ['exact', 'exact_stem', 'fuzzy'].includes(r.enriched[0].duplicate_of.source),
      `source=${r.enriched[0].duplicate_of.source}`
    );
  });

  await test('filterDuplicates: default (dropDuplicates=false) keeps all', () => {
    const enr = [{ duplicate_of: null }, { duplicate_of: { source: 'fuzzy' } }];
    const r = filterDuplicates(enr);
    assert.strictEqual(r.kept.length, 2);
    assert.strictEqual(r.droppedCount, 0);
  });

  await test('filterDuplicates: dropDuplicates=true filters out marked', () => {
    const enr = [
      { topic_title: 'A', duplicate_of: null },
      { topic_title: 'B', duplicate_of: { source: 'exact' } },
      { topic_title: 'C', duplicate_of: { source: 'fuzzy', similarity: 0.7 } },
    ];
    const r = filterDuplicates(enr, { dropDuplicates: true });
    assert.strictEqual(r.kept.length, 1);
    assert.strictEqual(r.droppedCount, 2);
    assert.strictEqual(r.kept[0].topic_title, 'A');
  });

  await test('brandAliases: _charBigrams + cosine for similar keys', () => {
    const a = brandAliases._charBigrams('brand-x');
    const b = brandAliases._charBigrams('brand-x-pro');
    const sim = brandAliases._cosineBigrams(a, b);
    assert.ok(sim >= 0.6, `expected high cosine (>=0.6), got ${sim}`);
  });

  await test('brandAliases: cosine for unrelated keys is low', () => {
    const a = brandAliases._charBigrams('acme');
    const b = brandAliases._charBigrams('quantum-leap');
    const sim = brandAliases._cosineBigrams(a, b);
    assert.ok(sim < 0.3, `expected low cosine, got ${sim}`);
  });

  await test('brandAliases: resolveBrandKey returns base when no db', async () => {
    const r = await brandAliases.resolveBrandKey(null, { userId: 'u1', rawBrand: 'Бренд Х' });
    assert.strictEqual(r, normalizeBrandKey('Бренд Х'));
  });

  await test('brandAliases: resolveBrandKey uses alias from mock-db', async () => {
    const calls = [];
    const mockDb = {
      query: async (sql, params) => {
        calls.push({ sql: sql.replace(/\s+/g, ' ').trim().slice(0, 60), params });
        if (sql.includes('FROM article_topics_brand_aliases')) {
          return { rows: [{ brand_key_canonical: 'acme-inc' }] };
        }
        return { rows: [] };
      },
    };
    const r = await brandAliases.resolveBrandKey(mockDb, { userId: 'u1', rawBrand: 'Acme Industries' });
    assert.strictEqual(r, 'acme-inc');
    assert.ok(calls.length >= 1, 'should query db');
  });

  await test('brandAliases: recordAlias rejects noop (same canonical/alias)', async () => {
    const mockDb = { query: async () => ({ rowCount: 1, rows: [{ id: 1 }] }) };
    const r = await brandAliases.recordAlias(mockDb, { userId: 'u1', canonical: 'acme', alias: 'acme' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'noop');
  });

  await test('brandAliases: recordAlias normalises and persists', async () => {
    let captured;
    const mockDb = { query: async (sql, params) => { captured = params; return { rowCount: 1, rows: [{ id: 7 }] }; } };
    const r = await brandAliases.recordAlias(mockDb, { userId: 'u1', canonical: 'Acme Inc', alias: 'Acme Industries', source: 'manual', confidence: 0.9 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.inserted, true);
    assert.strictEqual(captured[1], 'acme-inc');     // canonical normalised
    assert.strictEqual(captured[2], 'acme-industries');
    assert.strictEqual(captured[4], 0.9);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
