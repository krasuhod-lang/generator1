'use strict';

/**
 * test-reports-view-mode.js — юнит-тесты санитайзера payload отчётов
 * под единый view-mode contract.
 *
 * Запуск: node backend/scripts/test-reports-view-mode.js
 */

const assert = require('assert');
const {
  sanitizeDraft,
  sanitizeData,
  sanitizeSummary,
  _internal,
} = require('../src/services/reports/viewModeSanitizer');

let total = 0, failed = 0;
function test(name, fn) {
  total += 1;
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('── sanitizeDraft ───────────────────────────────');

test('analyst mode → не меняет draft', () => {
  const draft = { id: '1', title: 't', llm_job_id: 'abc', llm_meta: { x: 1 } };
  assert.deepStrictEqual(sanitizeDraft(draft, 'analyst'), draft);
});

test('client mode → убирает llm_* / debug / token_usage', () => {
  const draft = {
    id: '1', title: 't', llm_summary: 'ok',
    llm_job_id: 'abc', llm_error: 'oops', llm_meta: { x: 1 },
    token_usage: 5, debug: { z: 9 }, raw_prompt: 'system',
  };
  const out = sanitizeDraft(draft, 'client');
  assert.strictEqual(out.id, '1');
  assert.strictEqual(out.llm_summary, 'ok'); // оставляем готовый текст
  assert.strictEqual(out.llm_job_id, undefined);
  assert.strictEqual(out.llm_error, undefined);
  assert.strictEqual(out.llm_meta, undefined);
  assert.strictEqual(out.token_usage, undefined);
  assert.strictEqual(out.debug, undefined);
  assert.strictEqual(out.raw_prompt, undefined);
});

test('client mode → не мутирует исходный объект', () => {
  const draft = { llm_job_id: 'abc' };
  sanitizeDraft(draft, 'client');
  assert.strictEqual(draft.llm_job_id, 'abc');
});

test('client mode → чистит tasks_blocks от internal_note', () => {
  const draft = {
    tasks_blocks: [{
      month: '2026-03',
      sections: [{
        title: 'Контент',
        tasks: [{ title: 'task', description_html: '<p>x</p>', internal_note: 'analyst-only', debug: 1 }],
        debug: { z: 1 },
      }],
      debug: { z: 1 },
    }],
  };
  const out = sanitizeDraft(draft, 'client');
  const t = out.tasks_blocks[0].sections[0].tasks[0];
  assert.strictEqual(t.title, 'task');
  assert.strictEqual(t.internal_note, undefined);
  assert.strictEqual(t.debug, undefined);
  assert.strictEqual(out.tasks_blocks[0].sections[0].debug, undefined);
  assert.strictEqual(out.tasks_blocks[0].debug, undefined);
});

console.log('\n── sanitizeData ────────────────────────────────');

test('analyst mode → не меняет data', () => {
  const data = { gsc: { series: [], debug: { z: 1 } } };
  assert.strictEqual(sanitizeData(data, 'analyst'), data);
});

test('client mode → срезает debug/raw в gsc/ywm/keys_so', () => {
  const data = {
    gsc: { series: [1], debug: { x: 1 }, raw_response: 'big' },
    ywm: { series: [2], trace: 'long' },
    keys_so: { series: [3], request_payload: { q: 1 } },
  };
  const out = sanitizeData(data, 'client');
  assert.deepStrictEqual(out.gsc.series, [1]);
  assert.strictEqual(out.gsc.debug, undefined);
  assert.strictEqual(out.gsc.raw_response, undefined);
  assert.strictEqual(out.ywm.trace, undefined);
  assert.strictEqual(out.keys_so.request_payload, undefined);
});

test('client mode → cuts module items to top-10 and strips opportunity_score', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({
    query: `q${i}`, url: '/p', opportunity_score: i * 100, ctr_ratio: 0.5,
    avg_position: 12, clicks: 1, impressions: 100,
  }));
  const data = {
    modules: {
      striking_distance: { items, summary: { total: 30, high: 1, medium: 1, low: 1 } },
    },
  };
  const out = sanitizeData(data, 'client');
  const sd = out.modules.striking_distance;
  assert.strictEqual(sd.items.length, _internal.CLIENT_ITEMS_LIMIT);
  for (const it of sd.items) {
    assert.strictEqual(it.opportunity_score, undefined,
      `opportunity_score should be hidden in client mode (got ${it.opportunity_score})`);
    assert.strictEqual(it.ctr_ratio, undefined);
  }
  assert.strictEqual(sd.summary.total, 30); // summary не трогаем
});

test('client mode → tasks.items оставляет только client-safe поля', () => {
  const data = {
    tasks: {
      items: [{
        title: 't', performed_at: '2026-01-01', task_type: 'content_generation',
        description: '<p>internal</p>', source: 'manual',
        client_summary: 'мы опубликовали статью',
        debug: { x: 1 },
      }],
    },
  };
  const out = sanitizeData(data, 'client');
  const t = out.tasks.items[0];
  assert.strictEqual(t.title, 't');
  assert.strictEqual(t.client_summary, 'мы опубликовали статью');
  assert.strictEqual(t.description, undefined);
  assert.strictEqual(t.debug, undefined);
});

console.log('\n── sanitizeSummary ─────────────────────────────');

test('client mode → срезает llm_meta и token_usage', () => {
  const s = { executive_summary: 'ok', highlights: ['a'], llm_meta: { tokens: 1 }, token_usage: 50 };
  const out = sanitizeSummary(s, 'client');
  assert.strictEqual(out.executive_summary, 'ok');
  assert.deepStrictEqual(out.highlights, ['a']);
  assert.strictEqual(out.llm_meta, undefined);
  assert.strictEqual(out.token_usage, undefined);
});

test('analyst mode → оставляет всё', () => {
  const s = { executive_summary: 'ok', llm_meta: { tokens: 1 } };
  assert.strictEqual(sanitizeSummary(s, 'analyst'), s);
});

console.log(`\n${total - failed}/${total} passed`);
if (failed > 0) process.exit(1);
