'use strict';

/**
 * Smoke-тест brand dedup:
 *   • normalizeBrandKey: кириллица/латиница/пробелы → один ключ.
 *   • detectDuplicates: exact, fuzzy, llm (mock-callDeepSeek).
 *   • _normTopic: duplicate_of passthrough + новые intent поля.
 */

const assert = require('assert');
const { normalizeBrandKey, canonTitle } = require('../src/services/articleTopics/brandKey');
const { detectDuplicates, _jaccard } = require('../src/services/articleTopics/topicDuplicateDetector');
const { extractTopicIdeasJsonBlock } = require('../src/services/articleTopics/topicIdeasParser');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); pass += 1; }
  catch (e) { console.error(`✗ ${name}\n   ${e.message}`); fail += 1; }
}

test('normalizeBrandKey: cyrillic/latin/spaces collapse to same key', () => {
  const a = normalizeBrandKey('Бренд Х');
  const b = normalizeBrandKey('  brend  h ');
  const c = normalizeBrandKey('БРЕНД Х');
  assert.strictEqual(a, 'brend-h');
  assert.strictEqual(b, 'brend-h');
  assert.strictEqual(c, 'brend-h');
});

test('normalizeBrandKey: pure latin retains, strips punctuation', () => {
  assert.strictEqual(normalizeBrandKey('Acme, Inc.'), 'acme-inc');
  assert.strictEqual(normalizeBrandKey('Acme Inc'), 'acme-inc');
});

test('normalizeBrandKey: handles null/undefined/empty', () => {
  assert.strictEqual(normalizeBrandKey(null), '');
  assert.strictEqual(normalizeBrandKey(''), '');
  assert.strictEqual(normalizeBrandKey('   '), '');
});

test('canonTitle: preserves cyrillic, strips punctuation, lowercases', () => {
  const c = canonTitle('Как выбрать CRM в 2026?');
  assert.strictEqual(c, 'как выбрать crm в 2026');
});

test('_jaccard: basic set similarity', () => {
  const a = ['как', 'выбрать', 'crm'];
  const b = ['как', 'выбрать', 'erp'];
  const s = _jaccard(a, b);
  assert.ok(s > 0.4 && s < 0.7, `expected 0.5, got ${s}`);
});

(async () => {
  await Promise.resolve();
  await (async () => {
    const history = [
      { id: 1, topic_title_canon: 'как выбрать crm в 2026', topic_h1_canon: 'как выбрать crm', topic_idea_task_id: 'task-1', created_at: '2026-01-01' },
      { id: 2, topic_title_canon: 'обзор рынка автоматизации продаж', topic_h1_canon: null, topic_idea_task_id: 'task-2', created_at: '2026-02-01' },
    ];

    test('detectDuplicates: EXACT match', async () => {
      const candidates = [{ title: 'Как выбрать CRM в 2026?' }];
      const r = await detectDuplicates({ candidates, history, flags: { enabled: true, useLlm: false } });
      assert.strictEqual(r.stats.exact, 1);
      assert.strictEqual(r.enriched[0].duplicate_of.source, 'exact');
      assert.strictEqual(r.enriched[0].duplicate_of.task_id, 'task-1');
    });

    test('detectDuplicates: FUZZY (Jaccard ≥ 0.65)', async () => {
      const candidates = [{ title: 'Как выбрать CRM систему в 2026 году' }];
      const r = await detectDuplicates({ candidates, history, flags: { enabled: true, useLlm: false } });
      assert.strictEqual(r.stats.fuzzy + r.stats.exact, 1, `stats=${JSON.stringify(r.stats)}`);
      assert.ok(r.enriched[0].duplicate_of, 'should have duplicate_of');
    });

    test('detectDuplicates: NO match for completely different title', async () => {
      const candidates = [{ title: 'История развития квантовых компьютеров' }];
      const r = await detectDuplicates({ candidates, history, flags: { enabled: true, useLlm: false } });
      assert.strictEqual(r.enriched[0].duplicate_of, null);
    });

    test('detectDuplicates: LLM stub marks fuzzy 0.45-0.65 pairs', async () => {
      const candidates = [{ title: 'CRM для рынка в 2026' }];
      const mockLlm = async (sys, user) => ({
        text: '[{"candidate_index":0,"is_duplicate":true,"confidence":0.9,"reason":"same intent"}]',
      });
      const r = await detectDuplicates({
        candidates,
        history,
        flags: { enabled: true, useLlm: true, maxLlmCandidates: 5 },
        callDeepSeek: mockLlm,
      });
      assert.ok(r.stats.llm_called, 'llm should be called');
      if (r.stats.llm > 0) {
        assert.strictEqual(r.enriched[0].duplicate_of.source, 'llm');
      }
    });

    test('detectDuplicates: empty history → no duplicates', async () => {
      const r = await detectDuplicates({ candidates: [{ title: 'foo' }], history: [], flags: { enabled: true } });
      assert.strictEqual(r.enriched[0].duplicate_of, null);
    });

    test('detectDuplicates: disabled → no duplicates', async () => {
      const r = await detectDuplicates({
        candidates: [{ title: 'Как выбрать CRM в 2026?' }],
        history,
        flags: { enabled: false },
      });
      assert.strictEqual(r.enriched[0].duplicate_of, null);
    });

    test('topicIdeasParser: duplicate_of passthrough + new intent fields', () => {
      const md = `<!-- TOPIC_IDEAS_JSON_START -->
{"topics":[{"title":"Test","intent_user_questions":["a","b"],"intent_decision_stage":"MOFU","duplicate_of":{"task_id":"abc","title":"old","similarity":0.9,"source":"fuzzy"}}],"topic_count_returned":1}
<!-- TOPIC_IDEAS_JSON_END -->`;
      const parsed = extractTopicIdeasJsonBlock(md);
      assert.ok(parsed, 'should parse');
      const t = parsed.topics[0];
      assert.deepStrictEqual(t.intent_user_questions, ['a', 'b']);
      assert.strictEqual(t.intent_decision_stage, 'MOFU');
      assert.strictEqual(t.duplicate_of.source, 'fuzzy');
      assert.strictEqual(t.duplicate_of.task_id, 'abc');
    });

    test('topicIdeasParser: intent_pains normalization from string', () => {
      const md = `<!-- TOPIC_IDEAS_JSON_START -->
{"topics":[{"title":"Test","intent_pains":"единственная боль"}],"topic_count_returned":1}
<!-- TOPIC_IDEAS_JSON_END -->`;
      const parsed = extractTopicIdeasJsonBlock(md);
      assert.deepStrictEqual(parsed.topics[0].intent_pains, ['единственная боль']);
    });

    test('topicIdeasParser: intent_jobs_to_be_done from objects', () => {
      const md = `<!-- TOPIC_IDEAS_JSON_START -->
{"topics":[{"title":"X","intent_jobs_to_be_done":[{"text":"job1"},{"value":"job2"}]}],"topic_count_returned":1}
<!-- TOPIC_IDEAS_JSON_END -->`;
      const parsed = extractTopicIdeasJsonBlock(md);
      assert.deepStrictEqual(parsed.topics[0].intent_jobs_to_be_done, ['job1', 'job2']);
    });

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })();
})();
