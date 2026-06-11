#!/usr/bin/env node
'use strict';

/**
 * Smoke-tests for aegis/trainingHealth — pure-ish (no real DB, no network).
 *
 * Покрывает:
 *   • buildDspySection с разными комбинациями ENV / py reachability /
 *     dataset rows / baseline yaml;
 *   • buildGa4Section с валидным/невалидным SA JSON и enabled/disabled;
 *   • logStartupAdvice печатает WARN при ошибках и OK при готовности;
 *   • ready_for_first_retrain корректен по основным сценариям.
 */

const assert = require('assert');

const trainingHealth = require('../src/services/aegis/trainingHealth');

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => { console.log(`✅ ${name}`); passed++; },
        (e) => { console.error(`❌ ${name}\n   ${e.stack || e.message}`); failed++; },
      ));
      return;
    }
    console.log(`✅ ${name}`); passed++;
  } catch (e) {
    console.error(`❌ ${name}\n   ${e.stack || e.message}`); failed++;
  }
}

// ── Утилиты для подмены окружения ─────────────────────────────────
function envHasFromMap(map) {
  return (name) => Object.prototype.hasOwnProperty.call(map, name) && String(map[name]).length > 0;
}
function fakeBaseline({ size = 617, exists = true } = {}) {
  return () => ({
    exists,
    size_bytes: size,
    mtime: '2026-01-01T00:00:00.000Z',
    looks_like_baseline_stub: size < 2048,
    path: 'brain_state/compiled_writer.yaml',
  });
}
function fakeFlags(over = {}) {
  return {
    enabled: true,
    dspy: { enabled: true, autoRetrainEnabled: true, autoRetrainMinRows: 10, ...((over && over.dspy) || {}) },
    rlGa4: { enabled: false, propertyId: '', serviceAccountJson: '', topCtrQuantile: 0.75, ppoWeight: 3, ...((over && over.rlGa4) || {}) },
    ...over,
  };
}
function fakeDb({ total = 0, real = 0, lastVersion = null, fail = false } = {}) {
  return {
    query: async (sql) => {
      if (fail) throw new Error('boom');
      if (/FROM\s+aegis_dspy_dataset/i.test(sql)) {
        return { rows: [{ total, real_rows: real }] };
      }
      if (/FROM\s+aegis_brain_versions/i.test(sql)) {
        return { rows: lastVersion ? [lastVersion] : [] };
      }
      return { rows: [] };
    },
  };
}
const pyOk = async () => ({ ok: true, body: { compiled: true } });
const pyFail = async () => ({ ok: false, reason: 'network' });

// ── DSPy section ──────────────────────────────────────────────────

test('DSPy: пустой ENV + dspy.enabled=false → error issues, не ready', async () => {
  const r = await trainingHealth.buildDspySection({
    flags: fakeFlags({ dspy: { enabled: false, autoRetrainMinRows: 10 } }),
    envHas: envHasFromMap({}),
    pyStatusFn: pyOk,
    baselineInfoFn: fakeBaseline(),
    db: fakeDb(),
  });
  assert.strictEqual(r.enabled, false);
  assert.strictEqual(r.ready_for_first_retrain, false);
  const codes = r.issues.map((i) => i.code);
  assert.ok(codes.includes('dspy_disabled'), `expected dspy_disabled, got ${codes}`);
  assert.ok(codes.includes('env_missing:AEGIS_DSPY_ENABLED'));
  assert.ok(codes.includes('env_missing:AEGIS_PY_URL'));
  assert.deepStrictEqual(r.missing_required_env.sort(),
    ['AEGIS_DSPY_ENABLED', 'AEGIS_PY_URL'].sort());
  // py_reachable не пингуем, если URL не задан
  assert.strictEqual(r.py_reachable, null);
});

test('DSPy: все ENV выставлены, py reachable, dataset мал → warn, не ready', async () => {
  const r = await trainingHealth.buildDspySection({
    flags: fakeFlags({ dspy: { enabled: true, autoRetrainMinRows: 10 } }),
    envHas: envHasFromMap({ AEGIS_DSPY_ENABLED: 'true', AEGIS_PY_URL: 'http://x' }),
    pyStatusFn: pyOk,
    baselineInfoFn: fakeBaseline({ size: 617 }),
    db: fakeDb({ total: 3 }),
  });
  assert.strictEqual(r.py_reachable, true);
  assert.strictEqual(r.ready_for_first_retrain, false);
  const codes = r.issues.map((i) => i.code);
  assert.ok(codes.includes('dataset_too_small'));
  assert.ok(codes.includes('brain_never_trained'));
  // нет блокирующих error → отсутствие error-issues, но dataset не дотягивает
  const errs = r.issues.filter((i) => i.level === 'error');
  assert.strictEqual(errs.length, 0, `unexpected errors: ${JSON.stringify(errs)}`);
});

test('DSPy: ENV ok + py reachable + dataset enough + есть brain version → ready', async () => {
  const r = await trainingHealth.buildDspySection({
    flags: fakeFlags(),
    envHas: envHasFromMap({ AEGIS_DSPY_ENABLED: 'true', AEGIS_PY_URL: 'http://x' }),
    pyStatusFn: pyOk,
    baselineInfoFn: fakeBaseline({ size: 50000 }),
    db: fakeDb({ total: 50, lastVersion: { id: 1, sha: 'a', deployed_at: '2026-06-01', improvement_pct: 7, dataset_size: 50 } }),
  });
  assert.strictEqual(r.ready_for_first_retrain, true, JSON.stringify(r.issues));
  assert.strictEqual(r.last_brain_version.exists, true);
  assert.strictEqual(r.dataset.total_rows, 50);
});

test('DSPy: py URL задан, но aegis_py недоступен → error py_unreachable, не ready', async () => {
  const r = await trainingHealth.buildDspySection({
    flags: fakeFlags(),
    envHas: envHasFromMap({ AEGIS_DSPY_ENABLED: 'true', AEGIS_PY_URL: 'http://x' }),
    pyStatusFn: pyFail,
    baselineInfoFn: fakeBaseline({ size: 50000 }),
    db: fakeDb({ total: 50 }),
  });
  assert.strictEqual(r.py_reachable, false);
  assert.strictEqual(r.ready_for_first_retrain, false);
  assert.ok(r.issues.some((i) => i.code === 'py_unreachable' && i.level === 'error'));
});

test('DSPy: DB query throws → dataset.available=false, не блокирует отчёт', async () => {
  const r = await trainingHealth.buildDspySection({
    flags: fakeFlags(),
    envHas: envHasFromMap({ AEGIS_DSPY_ENABLED: 'true', AEGIS_PY_URL: 'http://x' }),
    pyStatusFn: pyOk,
    baselineInfoFn: fakeBaseline({ size: 50000 }),
    db: fakeDb({ fail: true }),
  });
  assert.strictEqual(r.dataset.available, false);
  // Без БД мы не можем подтвердить datasetReady — не ready
  assert.strictEqual(r.ready_for_first_retrain, false);
});

test('DSPy: GitHub-секреты всегда упомянуты как info-issue', async () => {
  const r = await trainingHealth.buildDspySection({
    flags: fakeFlags(),
    envHas: envHasFromMap({ AEGIS_DSPY_ENABLED: 'true', AEGIS_PY_URL: 'http://x' }),
    pyStatusFn: pyOk,
    baselineInfoFn: fakeBaseline({ size: 50000 }),
    db: fakeDb({ total: 50, lastVersion: { id: 1, sha: 'a', deployed_at: '2026-06-01', improvement_pct: 7, dataset_size: 50 } }),
  });
  assert.ok(r.issues.some((i) => i.code === 'github_secrets_reminder' && i.level === 'info'));
});

// ── GA4 section ───────────────────────────────────────────────────

test('GA4: disabled (default) → ready=false, info issues, не блокирует DSPy', () => {
  const r = trainingHealth.buildGa4Section({
    flags: fakeFlags({ rlGa4: { enabled: false } }),
    envHas: envHasFromMap({}),
  });
  assert.strictEqual(r.enabled, false);
  assert.strictEqual(r.ready, false);
  assert.ok(r.issues.some((i) => i.code === 'rl_ga4_disabled' && i.level === 'info'));
  // Когда rlGa4 disabled — недостающие env идут как info, не error
  const errs = r.issues.filter((i) => i.level === 'error');
  assert.strictEqual(errs.length, 0);
});

test('GA4: enabled но env пустой → error issues', () => {
  const r = trainingHealth.buildGa4Section({
    flags: fakeFlags({ rlGa4: { enabled: true } }),
    envHas: envHasFromMap({}),
  });
  assert.strictEqual(r.ready, false);
  const errCodes = r.issues.filter((i) => i.level === 'error').map((i) => i.code);
  assert.ok(errCodes.includes('env_missing:AEGIS_GA4_PROPERTY_ID'));
  assert.ok(errCodes.includes('env_missing:AEGIS_GA4_SA_JSON'));
});

test('GA4: невалидный SA JSON → error sa_json_invalid', () => {
  process.env.AEGIS_GA4_SA_JSON = 'not-json';
  try {
    const r = trainingHealth.buildGa4Section({
      flags: fakeFlags({ rlGa4: { enabled: true, propertyId: 'properties/1' } }),
      envHas: envHasFromMap({
        AEGIS_RL_GA4_ENABLED: 'true', AEGIS_GA4_PROPERTY_ID: 'properties/1',
        AEGIS_GA4_SA_JSON: 'not-json', AEGIS_PY_URL: 'http://x',
      }),
    });
    assert.strictEqual(r.sa_json_valid, false);
    assert.strictEqual(r.ready, false);
    assert.ok(r.issues.some((i) => i.code === 'sa_json_invalid' && i.level === 'error'));
  } finally { delete process.env.AEGIS_GA4_SA_JSON; }
});

test('GA4: валидный SA JSON + все ENV → ready=true, client_email вытащен', () => {
  const sa = JSON.stringify({ type: 'service_account', client_email: 'svc@x.iam.gserviceaccount.com', private_key: '---KEY---' });
  process.env.AEGIS_GA4_SA_JSON = sa;
  try {
    const r = trainingHealth.buildGa4Section({
      flags: fakeFlags({ rlGa4: { enabled: true, propertyId: 'properties/1' } }),
      envHas: envHasFromMap({
        AEGIS_RL_GA4_ENABLED: 'true', AEGIS_GA4_PROPERTY_ID: 'properties/1',
        AEGIS_GA4_SA_JSON: sa, AEGIS_PY_URL: 'http://x',
      }),
    });
    assert.strictEqual(r.sa_json_valid, true);
    assert.strictEqual(r.sa_client_email, 'svc@x.iam.gserviceaccount.com');
    assert.strictEqual(r.ready, true, JSON.stringify(r.issues));
  } finally { delete process.env.AEGIS_GA4_SA_JSON; }
});

// ── logStartupAdvice ──────────────────────────────────────────────

test('logStartupAdvice: aegis disabled → молчит', () => {
  const captured = [];
  const log = { log: (m) => captured.push(['log', m]), warn: (m) => captured.push(['warn', m]) };
  trainingHealth.logStartupAdvice({ aegis_enabled: false, dspy: { issues: [] }, rl_ga4: { issues: [] } }, log);
  assert.strictEqual(captured.length, 0);
});

test('logStartupAdvice: есть error issues → WARN с перечнем', () => {
  const captured = [];
  const log = { log: (m) => captured.push(['log', m]), warn: (m) => captured.push(['warn', m]) };
  trainingHealth.logStartupAdvice({
    aegis_enabled: true,
    dspy:   { issues: [{ level: 'error', code: 'dspy_disabled', message: 'X', fix: 'Y' }] },
    rl_ga4: { issues: [] },
  }, log);
  assert.strictEqual(captured.length, 1);
  assert.strictEqual(captured[0][0], 'warn');
  assert.ok(captured[0][1].includes('[dspy_disabled]'));
  assert.ok(captured[0][1].includes('GET /api/aegis/training/health'));
});

test('logStartupAdvice: нет error issues → один INFO log', () => {
  const captured = [];
  const log = { log: (m) => captured.push(['log', m]), warn: (m) => captured.push(['warn', m]) };
  trainingHealth.logStartupAdvice({
    aegis_enabled: true,
    dspy:   { issues: [{ level: 'info', code: 'github_secrets_reminder', message: 'A', fix: 'B' }] },
    rl_ga4: { issues: [] },
  }, log);
  assert.strictEqual(captured.length, 1);
  assert.strictEqual(captured[0][0], 'log');
  assert.ok(captured[0][1].includes('готов'));
});

// ── Финал ─────────────────────────────────────────────────────────

Promise.all(pending).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
