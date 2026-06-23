'use strict';

/**
 * test-freshness-service.js — тесты freshnessService._computeStatus (чистая
 * логика без БД). Запись/чтение из data_source_health покрываются интеграционно.
 *
 * Запуск: node backend/scripts/test-freshness-service.js
 */

const { _computeStatus } = require('../src/services/projects/freshnessService');

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  if (actual === expected) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}: expected ${expected}, got ${actual}`); }
}

const now = new Date('2025-06-15T12:00:00Z');

console.log('=== _computeStatus ===');

// 1. Свежий sync, период полный → ok.
eq(_computeStatus({
  last_successful_sync_at: new Date('2025-06-15T11:00:00Z'),
  expected_max_date: '2025-06-13',
  source_max_date: '2025-06-13',
  is_partial_period: false,
  status: 'ok',
}, now), 'ok', 'fresh + covered → ok');

// 2. Свежий sync, но partial period → partial.
eq(_computeStatus({
  last_successful_sync_at: new Date('2025-06-15T11:00:00Z'),
  expected_max_date: '2025-06-13',
  source_max_date: '2025-06-13',
  is_partial_period: true,
  status: 'ok',
}, now), 'partial', 'fresh + partial period → partial');

// 3. Sync 2 дня назад (>36h) → stale.
eq(_computeStatus({
  last_successful_sync_at: new Date('2025-06-13T00:00:00Z'),
  expected_max_date: '2025-06-13',
  source_max_date: '2025-06-13',
  is_partial_period: false,
  status: 'ok',
}, now), 'stale', '2.5 days old → stale');

// 4. Sync 5 дней назад (>96h) → error.
eq(_computeStatus({
  last_successful_sync_at: new Date('2025-06-10T00:00:00Z'),
  expected_max_date: '2025-06-13',
  source_max_date: '2025-06-13',
  is_partial_period: false,
  status: 'ok',
}, now), 'error', '5 days old → error');

// 5. Свежий sync, но source отстаёт на 5 дней от expected (gapDays=2) → gap.
eq(_computeStatus({
  last_successful_sync_at: new Date('2025-06-15T11:00:00Z'),
  expected_max_date: '2025-06-13',
  source_max_date: '2025-06-08',
  is_partial_period: false,
  status: 'ok',
}, now), 'gap', 'source behind expected by 5 days → gap');

// 6. Свежий sync, source отстаёт всего на 1 день (gapDays=2) → ok.
eq(_computeStatus({
  last_successful_sync_at: new Date('2025-06-15T11:00:00Z'),
  expected_max_date: '2025-06-13',
  source_max_date: '2025-06-12',
  is_partial_period: false,
  status: 'ok',
}, now), 'ok', 'small gap within tolerance → ok');

// 7. Нет lastSync → error.
eq(_computeStatus({
  last_successful_sync_at: null,
  status: 'error',
}, now), 'error', 'no sync history → error');

// 8. null record → error.
eq(_computeStatus(null, now), 'error', 'null record → error');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
