'use strict';

/**
 * Smoke test для backend/src/services/aegis/qualityLogWriter.js.
 * Запуск: node backend/scripts/test-quality-log.js
 *
 * Подменяем pg-pool на in-memory recorder, чтобы не требовать живой БД.
 */

const Module = require('module');
const path   = require('path');
const assert = require('assert');

// ── 1. Перехватываем require('../../config/db') и заменяем на мок. ─
const dbCalls = [];
const dbMock = {
  query: async (sql, args) => {
    dbCalls.push({ sql: sql.replace(/\s+/g, ' ').trim().slice(0, 80), args });
    return { rows: [], rowCount: 0 };
  },
};
const dbPath = require.resolve(
  path.join(__dirname, '..', 'src', 'config', 'db.js'),
);
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, exports: dbMock,
};

const { recordQualityLog } = require('../src/services/aegis/qualityLogWriter');

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.error(`  ❌ ${name}\n     ${e.message}`); failed++; }
}

(async () => {
  console.log('--- recordQualityLog ---');

  await t('returns invalid_payload without articleRef', async () => {
    const r = await recordQualityLog({ kind: 'info_article' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_payload');
  });

  await t('writes both quality_log and aegis_runs on success', async () => {
    dbCalls.length = 0;
    const r = await recordQualityLog({
      articleRef: 'info_article:test-1',
      kind: 'info_article',
      niche: 'tires',
      qualityScore: { overall: 92, subscores: { eeat: 90, fact_check: 90, plagiarism: 95 } },
      reports: {},
      modelUsed: 'gemini-3.5-flash',
      costUsd: 0.01,
      iterations: 1,
      taskRef: 'task-uuid-1',
      userId: 'user-1',
    });
    assert.equal(r.ok, true);
    assert.equal(r.status, 'success');
    assert.equal(r.passes_gate, true);
    // должны быть оба INSERT'а.
    assert(dbCalls.some((c) => c.sql.includes('INSERT INTO aegis_quality_log')));
    assert(dbCalls.some((c) => c.sql.includes('INSERT INTO aegis_runs')));
  });

  await t('low SPQ -> rejected_by_gate but still writes', async () => {
    dbCalls.length = 0;
    const r = await recordQualityLog({
      articleRef: 'info_article:test-2',
      kind: 'info_article',
      qualityScore: { overall: 40, subscores: { eeat: 40 } },
      reports: {
        fact_check_report: { verdict: 'fail', unsupportedPctTotal: 60 },
      },
      modelUsed: 'm',
      costUsd: 0,
      iterations: 2,
    });
    assert.equal(r.ok, true);
    assert.equal(r.status, 'rejected_by_gate');
    assert.equal(r.passes_gate, false);
    // failure_reasons jsonb должен содержать unsupported_numbers.
    const qlCall = dbCalls.find((c) => c.sql.includes('aegis_quality_log'));
    const failureReasons = JSON.parse(qlCall.args[6]);
    assert(failureReasons.includes('unsupported_numbers'));
    assert(failureReasons.includes('fact_check_failed'));
  });

  await t('mid SPQ (60..80) -> needs_refine', async () => {
    dbCalls.length = 0;
    const r = await recordQualityLog({
      articleRef: 'info_article:test-3',
      kind: 'info_article',
      qualityScore: { overall: 72, subscores: { eeat: 72 } },
      reports: {},
    });
    assert.equal(r.status, 'needs_refine');
  });

  await t('survives DB error gracefully', async () => {
    const orig = dbMock.query;
    dbMock.query = async () => { throw new Error('boom'); };
    const r = await recordQualityLog({
      articleRef: 'info_article:test-4',
      kind: 'info_article',
      qualityScore: { overall: 90, subscores: { eeat: 90, fact_check: 90, plagiarism: 90 } },
      reports: {},
    });
    // Best-effort: ok=true даже если оба INSERT'а упали.
    assert.equal(r.ok, true);
    dbMock.query = orig;
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
