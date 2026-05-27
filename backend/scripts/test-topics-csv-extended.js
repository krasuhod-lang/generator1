'use strict';

/**
 * Smoke-тест для расширенного topicsToCsv:
 *   • все новые колонки присутствуют в header;
 *   • массивы → ' | '-join;
 *   • спецсимволы (`,`, `;`, `\n`, `"`) экранируются;
 *   • NULL/undefined → пустая строка (не "null"/"undefined");
 *   • duplicate_of_task / duplicate_of_title извлекаются из вложенного объекта.
 *
 * Импорт идёт напрямую из ESM frontend-файла через динамический import().
 */

const path = require('path');
const url  = require('url');
const assert = require('assert');

const CSV_FILE = path.resolve(
  __dirname, '..', '..', 'frontend', 'src', 'utils', 'articleTopicsParser.js'
);

(async () => {
  let pass = 0, fail = 0;
  const test = (name, fn) => {
    try { fn(); console.log(`✓ ${name}`); pass += 1; }
    catch (e) { console.error(`✗ ${name}\n   ${e.message}`); fail += 1; }
  };

  const mod = await import(url.pathToFileURL(CSV_FILE).href);
  const { topicsToCsv } = mod;

  test('header contains all 21 columns', () => {
    const csv = topicsToCsv([{ title: 'X' }]);
    const header = csv.split('\n')[0];
    const expected = [
      'title', 'h1_variant', 'primary_intent', 'intent_facet',
      'expected_format', 'target_audience_segment',
      'commercial_potential', 'difficulty', 'why_now',
      'intent_user_questions', 'intent_pains', 'intent_jobs_to_be_done',
      'intent_decision_stage', 'intent_serp_features',
      'expected_search_volume', 'lsi_seed',
      'target_audience_segment_detail', 'content_angle', 'cta_suggestion',
      'duplicate_of_task', 'duplicate_of_title',
    ];
    for (const col of expected) {
      assert.ok(header.includes(col), `header missing ${col}: ${header}`);
    }
  });

  test('arrays joined with " | "', () => {
    const csv = topicsToCsv([{
      title: 'X',
      intent_user_questions: ['a', 'b', 'c'],
      lsi_seed: ['k1', 'k2'],
    }]);
    const dataLine = csv.split('\n')[1];
    assert.ok(dataLine.includes('a | b | c'), `expected a | b | c, got: ${dataLine}`);
    assert.ok(dataLine.includes('k1 | k2'), `expected k1 | k2, got: ${dataLine}`);
  });

  test('special chars escaped (comma, semicolon, newline, quote)', () => {
    const csv = topicsToCsv([{
      title: 'Has, comma',
      h1_variant: 'has;semicolon',
      why_now: 'has\nnewline',
      content_angle: 'has "quote"',
    }]);
    const lines = csv.split('\n');
    assert.ok(lines[1].includes('"Has, comma"'));
    assert.ok(lines[1].includes('"has;semicolon"'));
    assert.ok(csv.includes('"has\nnewline"'));
    assert.ok(csv.includes('"has ""quote"""'));
  });

  test('null/undefined → empty string', () => {
    const csv = topicsToCsv([{
      title: null,
      h1_variant: undefined,
      commercial_potential: 0,
    }]);
    const dataLine = csv.split('\n')[1];
    assert.ok(dataLine.startsWith(',,'), `expected leading empty fields, got: ${dataLine}`);
    assert.ok(!/null|undefined/.test(dataLine));
    assert.ok(dataLine.split(',')[6] === '0', '0 must be preserved');
  });

  test('duplicate_of expanded to task_short_id + title', () => {
    const csv = topicsToCsv([{
      title: 'X',
      duplicate_of: {
        task_id: 'abc-def-1234',
        task_short_id: 'abc-def-',
        title: 'Old topic',
        similarity: 0.9,
        source: 'fuzzy',
      },
    }]);
    const dataLine = csv.split('\n')[1];
    assert.ok(dataLine.includes('abc-def-'), `task_short_id missing: ${dataLine}`);
    assert.ok(dataLine.includes('Old topic'), `title missing: ${dataLine}`);
  });

  test('duplicate_of_task falls back to task_id if short_id absent', () => {
    const csv = topicsToCsv([{
      title: 'X',
      duplicate_of: { task_id: 'fallback-id', title: 't' },
    }]);
    assert.ok(csv.includes('fallback-id'));
  });

  test('missing duplicate_of leaves columns empty', () => {
    const csv = topicsToCsv([{ title: 'X' }]);
    const cells = csv.split('\n')[1].split(',');
    // last two cells = duplicate_of_task, duplicate_of_title
    assert.strictEqual(cells[cells.length - 1], '');
    assert.strictEqual(cells[cells.length - 2], '');
  });

  test('empty input → header-only', () => {
    const csv = topicsToCsv([]);
    assert.strictEqual(csv.split('\n').length, 1);
  });

  test('array of objects → text/value/label extracted', () => {
    const csv = topicsToCsv([{
      title: 'X',
      intent_pains: [{ text: 'pain1' }, { value: 'pain2' }, 'pain3'],
    }]);
    const line = csv.split('\n')[1];
    assert.ok(line.includes('pain1 | pain2 | pain3'), `got: ${line}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
