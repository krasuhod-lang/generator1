'use strict';

/**
 * Smoke-тесты parser-bot без БД и сети.
 * Запуск: node backend/scripts/test-parser-bot-worker.js
 */

const assert = require('assert');
const { normalizeScanUrls, itemStatusFromResult, retryLimit } = require('../src/services/parserBot/queue');
const { boolOption, buildAuditPayload, buildWorkerErrorResult } = require('../src/services/parserBot/worker');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✘ ${name}\n    ${err.stack || err.message}`);
  }
}

console.log('parser-bot worker');

test('normalizeScanUrls adds scheme and deduplicates normalized URLs', () => {
  const out = normalizeScanUrls([
    'example.com/',
    'https://example.com',
    'https://example.com/?utm_source=x',
    'mailto:test@example.com',
    '',
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].normalized_url, 'https://example.com/');
});

test('boolOption supports new and legacy option names', () => {
  assert.strictEqual(boolOption({ extract_clients: true }, ['extract_clients', 'clients']), true);
  assert.strictEqual(boolOption({ clients: true }, ['extract_clients', 'clients']), true);
  assert.strictEqual(boolOption({}, ['extract_clients', 'clients']), false);
});

test('buildAuditPayload maps parser-bot options to audit endpoint contract', () => {
  const payload = buildAuditPayload({
    normalized_url: 'https://example.com/',
    input_url: 'example.com',
    id: 'item-1',
    task_id: 'run-1',
    task: { id: 'run-1', options: { extract_contacts: true, about: true, services: false, clients: true } },
  });
  assert.deepStrictEqual(payload.urls, ['https://example.com/']);
  assert.strictEqual(payload.extract_contacts, true);
  assert.strictEqual(payload.extract_about, true);
  assert.strictEqual(payload.extract_services, false);
  assert.strictEqual(payload.extract_clients, true);
  assert.strictEqual(payload.task_id, 'run-1');
  assert.strictEqual(payload.item_id, 'item-1');
  assert.strictEqual(payload.use_result_cache, false);
});

test('buildWorkerErrorResult returns non-empty client sentinel fields', () => {
  const result = buildWorkerErrorResult({
    normalized_url: 'https://example.com/',
    task: { options: { clients: true, contacts: true } },
  }, 'fetch_error', 'timeout');
  assert.strictEqual(result.status, 'fetch_error');
  assert.strictEqual(result.execution.result_source, 'fresh');
  assert.strictEqual(result.field_status.client_segments, 'fetch_error');
  assert.ok(result.client_segments[0].includes('Не определено'));
  assert.ok(result.works_with);
});

test('terminal AI error preserves collected site data as partial', () => {
  const result = buildWorkerErrorResult({
    normalized_url: 'https://example.com/',
    id: 'item-1',
    task_id: 'run-1',
    task: { options: { clients: true, about: true, services: true } },
  }, 'llm_error', 'raw JSON repair failed', 'dspy_extraction_failed', {
    url: 'https://example.com/',
    title: 'Компания',
    about: 'Описание компании',
    services: ['SEO'],
    stats: { pages_scanned: 3 },
    crawl_status: 'partial',
    ai_status: 'failed',
    data_status: 'partial',
    subpage_errors: [{ url: 'https://example.com/private', reason: 'forbidden_403' }],
    field_status: { about: 'found', services: 'found' },
    warnings: [],
  });
  assert.strictEqual(result.status, 'partial');
  assert.strictEqual(result.title, 'Компания');
  assert.strictEqual(result.about, 'Описание компании');
  assert.deepStrictEqual(result.services, ['SEO']);
  assert.strictEqual(result.stats.pages_scanned, 3);
  assert.strictEqual(result.error_code, 'dspy_extraction_failed');
  assert.strictEqual(result.crawl_status, 'partial');
  assert.strictEqual(result.ai_status, 'failed');
  assert.strictEqual(result.data_status, 'partial');
  assert.strictEqual(result.subpage_errors[0].reason, 'forbidden_403');
});

test('itemStatusFromResult maps site statuses to durable item statuses', () => {
  assert.strictEqual(itemStatusFromResult({ status: 'ok' }), 'done');
  assert.strictEqual(itemStatusFromResult({ status: 'not_found' }), 'done');
  assert.strictEqual(itemStatusFromResult({ status: 'partial' }), 'partial');
  assert.strictEqual(itemStatusFromResult({ status: 'llm_error' }), 'error');
  assert.strictEqual(itemStatusFromResult({ status: 'fetch_error' }), 'error');
  assert.strictEqual(itemStatusFromResult({ status: 'blocked' }), 'error');
});

test('retryLimit is clamped to safe range', () => {
  assert.strictEqual(retryLimit({ retry_limit: 999 }), 5);
  assert.strictEqual(retryLimit({ retry_limit: -1 }), 0);
  assert.strictEqual(retryLimit({}), 2);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
