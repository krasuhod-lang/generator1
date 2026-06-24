#!/usr/bin/env node
'use strict';

/**
 * Smoke-тесты для нового слоя «Проект как живой контейнер задач» + защита
 * от каннибализации в article-topics (ТЗ).
 *
 * Покрывает:
 *  - compactProjectSnapshot: компрессия слепка под лимит, рекурсивная
 *    деградация при огромных входах.
 *  - computeContextVersion: стабильность хэша при перестановке полей,
 *    изменение при правке default_year/currency/facts.
 *  - buildProjectContextBlock: сжатие 500+ published_topics под бюджет,
 *    блок правил приоритета конфликтов присутствует, year_policy=omit.
 *  - semanticExclusionFilter: exact / jaccard / cluster_match через
 *    инжектируемый LLM-judge, graceful degradation без embeddings.
 *  - articleTopics controller.parseExcludeTopics: парсинг topic/cluster.
 *
 * Запуск: `node backend/scripts/test-project-context-block.js`
 * Не требует БД/сети — модули чистые / с проброшенными зависимостями.
 */

const assert = require('node:assert/strict');

const { compactProjectSnapshot, MAX_SNAPSHOT_BYTES, HARD_DB_LIMIT } =
  require('../src/services/projects/snapshotCompactor');
const { computeContextVersion } = require('../src/services/projects/contextResolver');
const { buildProjectContextBlock } = require('../src/services/projects/projectContextBlock');
const {
  filterCannibalizingCandidates,
  _jaccard3,
} = require('../src/services/articleTopics/semanticExclusionFilter');

let pass = 0; let fail = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓ ${name}`); pass++; })
    .catch((e) => { console.error(`  ✗ ${name}\n    ${e && e.stack || e}`); fail++; });
}

function makeCtx(overrides = {}) {
  return {
    project: {
      id: 'p1', name: 'Acme', site_url: 'https://acme.ru', region: 'РФ',
      niche: 'CRM', audience: 'B2B', default_year: 2026, default_currency: 'RUB',
      pricing_notes: 'диапазон 1000–5000 ₽',
      content_criteria: { stop_words: ['гарантия'], required_disclaimers: ['Не оферта'], year_policy: 'explicit' },
      ...overrides.project,
    },
    brand: { name: 'Acme', aliases: ['Acme Inc'], tokens: ['acme', 'crm'],
      facts: ['ARR $5M', '30 человек'], tone: 'экспертный', ...overrides.brand },
    market: { competitors: ['rival1.com', 'rival2.com'], commercial_share: 55, top_intent: 'commercial', ...overrides.market },
    signals: { gsc: { top_intent: 'transactional', commercial_share: 60, brand_share: 12 },
      ydx: null,
      cannibalization: [{ query: 'купить crm', pages: ['a', 'b', 'c'], verdict: 'merge_recommended' }],
      striking_distance: [{ query: 'crm для b2b', position: 12 }],
      ...overrides.signals },
    history: { published_topics: [], recent_meta_titles: [], ...overrides.history },
    last_analysis_at: '2026-05-01T00:00:00Z',
    snapshot_id: 'snap1',
  };
}

async function main() {
  console.log('\n── compactProjectSnapshot ──');

  await test('включает project + brand + первичные поля', () => {
    const { snapshot, truncated, sizeBytes } = compactProjectSnapshot(makeCtx());
    assert.equal(snapshot.project.name, 'Acme');
    assert.equal(snapshot.project.default_year, 2026);
    assert.equal(snapshot.brand.name, 'Acme');
    assert.equal(snapshot.signals.cannibalization[0].query, 'купить crm');
    assert.equal(truncated, false);
    assert.ok(sizeBytes < MAX_SNAPSHOT_BYTES);
    assert.ok(snapshot.captured_at && /^\d{4}-/.test(snapshot.captured_at));
  });

  await test('режет history.published_topics поэтапно при переполнении', () => {
    const big = Array.from({ length: 3000 }, (_, i) => ({
      topic_title_canon: 'очень длинный канон-заголовок темы '.repeat(5) + i,
      intent_facet: 'how',
    }));
    const ctx = makeCtx({ history: { published_topics: big } });
    const { snapshot, truncated, sizeBytes } = compactProjectSnapshot(ctx);
    assert.equal(truncated, true);
    assert.ok(sizeBytes <= HARD_DB_LIMIT, `size=${sizeBytes} hard=${HARD_DB_LIMIT}`);
    assert.ok(snapshot._truncated === true || snapshot._truncated_aggressively === true);
  });

  await test('aggressive truncation: жёсткий fallback оставляет project+brand.name', () => {
    // 50 КБ только в одном поле — не дадим уместиться даже в HARD_DB_LIMIT.
    const huge = 'X'.repeat(80_000);
    const ctx = makeCtx({ project: { pricing_notes: huge } });
    // pricing_notes сначала режется до 500, но прогоним крайний случай через
    // огромный список фактов:
    const hugeFacts = Array.from({ length: 2000 }, () => 'X'.repeat(2000));
    const ctx2 = makeCtx({ brand: { facts: hugeFacts } });
    const { snapshot, sizeBytes } = compactProjectSnapshot(ctx2);
    assert.ok(sizeBytes <= HARD_DB_LIMIT);
    assert.ok(snapshot.project && snapshot.project.name === 'Acme');
    void huge; // suppress unused
  });

  await test('null/undefined вход → {snapshot:null}', () => {
    const r = compactProjectSnapshot(null);
    assert.equal(r.snapshot, null);
    assert.equal(r.sizeBytes, 0);
  });

  console.log('\n── computeContextVersion ──');

  await test('стабильна на одинаковых данных', () => {
    const ctx = makeCtx();
    const v1 = computeContextVersion(ctx);
    const v2 = computeContextVersion(makeCtx());
    assert.equal(v1, v2);
    assert.equal(typeof v1, 'string');
    assert.equal(v1.length, 16);
  });

  await test('меняется при смене default_year', () => {
    const a = computeContextVersion(makeCtx());
    const b = computeContextVersion(makeCtx({ project: { default_year: 2027 } }));
    assert.notEqual(a, b);
  });

  await test('меняется при изменении brand.facts', () => {
    const a = computeContextVersion(makeCtx());
    const b = computeContextVersion(makeCtx({ brand: { facts: ['другие факты'] } }));
    assert.notEqual(a, b);
  });

  await test('не дребезжит на изменении snapshot_id/updated_at', () => {
    const a = computeContextVersion(makeCtx());
    const ctxB = makeCtx();
    ctxB.snapshot_id = 'other-snap-id';
    ctxB.project.updated_at = '2099-01-01';
    const b = computeContextVersion(ctxB);
    assert.equal(a, b);
  });

  console.log('\n── buildProjectContextBlock ──');

  await test('содержит блок «ПРАВИЛА РАЗРЕШЕНИЯ КОНФЛИКТОВ»', () => {
    const block = buildProjectContextBlock(makeCtx());
    assert.match(block, /ПРАВИЛА РАЗРЕШЕНИЯ КОНФЛИКТОВ/);
    assert.match(block, /СТРОГО следуй параметрам текущей задачи/);
    assert.match(block, /Актуальный год: 2026/);
    assert.match(block, /Стоп-слова \/ запреты: гарантия/);
  });

  await test('year_policy=omit заменяет строку про год', () => {
    const ctx = makeCtx({ project: { content_criteria: { year_policy: 'omit' } } });
    const block = buildProjectContextBlock(ctx);
    assert.match(block, /не упоминать в тексте/);
  });

  await test('500 published_topics сжимаются под бюджет', () => {
    const topics = Array.from({ length: 500 }, (_, i) => ({
      topic_title_canon: `тема ${i}`,
      intent_facet: i % 3 === 0 ? 'how' : (i % 3 === 1 ? 'review' : 'buy'),
      created_at: new Date(Date.now() - i * 86_400_000).toISOString(),
    }));
    const block = buildProjectContextBlock(makeCtx({ history: { published_topics: topics } }), { maxBlockChars: 6000 });
    assert.ok(block.length <= 6000, `block.length=${block.length}`);
    assert.match(block, /опущено для краткости/);
    // intent_facet round-robin — должны встретиться разные категории.
    assert.match(block, /\(how\)/);
    assert.match(block, /\(review\)/);
    assert.match(block, /\(buy\)/);
  });

  await test('null контекст → пустая строка', () => {
    assert.equal(buildProjectContextBlock(null), '');
    assert.equal(buildProjectContextBlock({}), '');
  });

  console.log('\n── semanticExclusionFilter ──');

  await test('_jaccard3 совпадение слов даёт > 0', () => {
    const a = _jaccard3('как доставить мебель москва', 'как доставить мебель спб');
    assert.ok(a > 0, `a=${a}`);
  });

  await test('exact canon → отбрасывается с reason=exact', async () => {
    const r = await filterCannibalizingCandidates(
      [{ topic_title: 'Доставка мебели' }, { topic_title: 'Топ-10 кофемашин' }],
      { user_topics: [{ raw: 'доставка мебели', canon: 'доставка мебели', kind: 'topic' }] }
    );
    assert.equal(r.summary.total_dropped, 1);
    assert.equal(r.summary.by_reason.exact, 1);
    assert.equal(r.kept.length, 1);
    assert.equal(r.kept[0].topic_title, 'Топ-10 кофемашин');
  });

  await test('graceful: без embeddings/judge — degraded.embeddings=true', async () => {
    const r = await filterCannibalizingCandidates(
      [{ topic_title: 'доставка кресел в офис' }],
      { user_topics: [{ raw: 'доставка мебели', canon: 'доставка мебели', kind: 'topic' }] }
    );
    // Yellow zone, нет embeddings/judge → kept, но degraded.embeddings=true.
    assert.equal(r.degraded.embeddings, true);
  });

  await test('cluster_match через инжектируемый LLM-judge', async () => {
    const candidates = [{ topic_title: 'B2B-стратегии 2026' }, { topic_title: 'Обзор CRM' }];
    const exclusions = {
      user_clusters: [{ raw: 'всё про B2B-продажи', canon: 'всё про b2b продажи', kind: 'cluster' }],
    };
    const llmJudgeFn = async ({ kind, pairs }) => pairs.map((p) => ({
      exclude: kind === 'cluster_membership' && /b2b/i.test(p.candidate),
      reason: 'b2b-cluster',
    }));
    const r = await filterCannibalizingCandidates(candidates, exclusions, { llmJudgeFn });
    assert.equal(r.summary.by_reason.cluster_match, 1);
    assert.equal(r.kept.length, 1);
    assert.equal(r.kept[0].topic_title, 'Обзор CRM');
  });

  await test('embeddingFn падает → degraded.embeddings + fallback на judge', async () => {
    // Кандидат должен попасть в «жёлтую зону» pre-filter (Jaccard ∈ [0.25; 0.6)),
    // чтобы embedding-стадия вызвалась. 2 общих слова из 4-х → Jaccard = 0.5.
    const candidates = [{ topic_title: 'доставка мебели в Москве' }];
    const exclusions = { user_topics: [{ raw: 'доставка мебели', canon: 'доставка мебели', kind: 'topic' }] };
    const embeddingFn = async () => { throw new Error('boom'); };
    const llmJudgeFn = async ({ pairs }) => pairs.map(() => ({ exclude: true, reason: 'fake' }));
    const r = await filterCannibalizingCandidates(candidates, exclusions, { embeddingFn, llmJudgeFn });
    assert.equal(r.degraded.embeddings, true);
    assert.equal(r.summary.total_dropped, 1);
    assert.equal(r.summary.by_reason.llm_judge, 1);
  });

  await test('пустой exclusion-set → kept = candidates', async () => {
    const r = await filterCannibalizingCandidates([{ topic_title: 'a' }, { topic_title: 'b' }], {});
    assert.equal(r.kept.length, 2);
    assert.equal(r.summary.total_dropped, 0);
  });

  console.log(`\n  ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
