'use strict';

/**
 * test-reports-module-annotation.js — тесты обогащения модулей отчёта
 * полями availability_status, data_source, client_safe_summary
 * (см. ТЗ §14.1 / PR-1 §1.2).
 *
 * Запуск:  node backend/scripts/test-reports-module-annotation.js
 *
 * Тестируем чистую функцию _annotateModule + summarizers из
 * reports/reportModulesService.js без обращения к БД.
 */

const assert = require('assert');
const { _internal } = require('../src/services/reports/reportModulesService');
const {
  _annotateModule,
  _summarizeStrikingDistance,
  _summarizeCtrGap,
  _summarizeContentHealth,
  _summarizeOffPage,
  _summarizeTechAudit,
} = _internal;

let total = 0, failed = 0;
function test(name, fn) {
  total += 1;
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('── _annotateModule ─────────────────────────────');

test('available + items → status=ready', () => {
  const mod = { items: [{}], summary: { total: 1 } };
  _annotateModule(mod, { dataSource: 'gsc', available: true, summarize: () => 'x' });
  assert.strictEqual(mod.availability_status, 'ready');
  assert.strictEqual(mod.availability_reason, null);
  assert.strictEqual(mod.data_source, 'gsc');
  assert.strictEqual(mod.client_safe_summary, 'x');
});

test('not available → status=empty, reason=not_connected', () => {
  const mod = { items: [], summary: {} };
  _annotateModule(mod, { dataSource: 'gsc', available: false, summarize: () => 'x' });
  assert.strictEqual(mod.availability_status, 'empty');
  assert.strictEqual(mod.availability_reason, 'not_connected');
});

test('available but no rows → status=empty, reason=no_rows', () => {
  const mod = { items: [], summary: {} };
  _annotateModule(mod, { dataSource: 'gsc', available: true, summarize: () => 'x' });
  assert.strictEqual(mod.availability_status, 'empty');
  assert.strictEqual(mod.availability_reason, 'no_rows');
});

test('null module → no-op', () => {
  assert.doesNotThrow(() => _annotateModule(null, { dataSource: 'gsc', available: true }));
});

console.log('\n── client_safe_summary ─────────────────────────');

test('Striking Distance empty → нет потенциала', () => {
  const s = _summarizeStrikingDistance({ summary: { total: 0 } });
  assert.match(s, /пока нет запросов/i);
});

test('Striking Distance with opportunity → human sentence', () => {
  const s = _summarizeStrikingDistance({ summary: { total: 12, total_opportunity_clicks: 350 } });
  assert.match(s, /12/);
  assert.match(s, /350/);
  assert.match(s, /клик/i);
});

test('CTR Gap with lost clicks → human sentence', () => {
  const s = _summarizeCtrGap({ summary: { total: 5, lost_clicks: 120 } });
  assert.match(s, /5/);
  assert.match(s, /120/);
});

test('CTR Gap empty → reassuring sentence', () => {
  const s = _summarizeCtrGap({ summary: { total: 0 } });
  assert.match(s, /не обнаружены/i);
});

test('Content Health healthy → all-good message', () => {
  const s = _summarizeContentHealth({ summary: { total: 10, needs_work: 0, critical: 0 } });
  assert.match(s, /10/);
  assert.match(s, /хорошем состоянии/i);
});

test('Content Health with issues → call-out', () => {
  const s = _summarizeContentHealth({ summary: { total: 10, needs_work: 3, critical: 2 } });
  assert.match(s, /5/); // 3+2
  assert.match(s, /доработк/i);
});

test('Off-Page broken links → fix message', () => {
  const s = _summarizeOffPage({ summary: { total: 20, broken: 4, unique_donors: 15 } });
  assert.match(s, /4/);
  assert.match(s, /бит/i);
});

test('Tech Audit broken → urgent message', () => {
  const s = _summarizeTechAudit({ summary: { pages: 10, broken: 3 } });
  assert.match(s, /3/);
  assert.match(s, /ошибк/i);
});

test('Tech Audit high no-alt ratio → SEO call-out', () => {
  const s = _summarizeTechAudit({ summary: { pages: 5, broken: 0, images_no_alt_ratio: 0.6 } });
  assert.match(s, /60%/);
});

test('summaries не содержат тех. жаргона (opportunity_score / ctr_ratio)', () => {
  const summaries = [
    _summarizeStrikingDistance({ summary: { total: 5, total_opportunity_clicks: 100 } }),
    _summarizeCtrGap({ summary: { total: 5, lost_clicks: 100 } }),
    _summarizeContentHealth({ summary: { total: 5, needs_work: 1, critical: 1 } }),
    _summarizeOffPage({ summary: { total: 5, broken: 1, unique_donors: 3 } }),
    _summarizeTechAudit({ summary: { pages: 5, broken: 0 } }),
  ];
  for (const s of summaries) {
    assert.doesNotMatch(s, /opportunity_score|ctr_ratio|benchmark/i, `leaked jargon: "${s}"`);
  }
});

console.log(`\n${total - failed}/${total} passed`);
if (failed > 0) process.exit(1);
