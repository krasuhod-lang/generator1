'use strict';

/* Tests for reports/modules/* — Smart Report Builder TЗ algorithms. */

const assert = require('assert');
const { getCtrBenchmark } = require('../src/services/reports/modules/ctrBenchmarks');
const { buildStrikingDistance, priorityOf } = require('../src/services/reports/modules/strikingDistance');
const { buildCtrGaps, isCtrGap, ctrGapLevel } = require('../src/services/reports/modules/ctrGap');
const {
  contentHealthScore, healthStatus, positionTrend, buildContentHealth,
} = require('../src/services/reports/modules/contentHealth');
const { auditHtml, summarizeTechAudit } = require('../src/services/reports/modules/techAudit');
const { summarizeBacklinks } = require('../src/services/reports/modules/offPage');
const { assembleModules } = require('../src/services/reports/modules');
const { normalizeSettings } = require('../src/services/reports/modules/settings');
const { nextHealth, reactivate } = require('../src/services/reports/modules/integrationHealth');

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log('  ok  -', name); }
  catch (e) { failed += 1; console.log('FAIL  -', name, '\n        ', e.message); }
}

// ── CTR benchmarks (§5.2) ──────────────────────────────────────────────────
test('ctr benchmark: position 1 google/yandex', () => {
  assert.strictEqual(getCtrBenchmark(1, 'google'), 0.285);
  assert.strictEqual(getCtrBenchmark(1, 'yandex'), 0.352);
});
test('ctr benchmark: ranges 4-5, 8-10, 11-15', () => {
  assert.strictEqual(getCtrBenchmark(4, 'google'), 0.070);
  assert.strictEqual(getCtrBenchmark(5, 'google'), 0.070);
  assert.strictEqual(getCtrBenchmark(9, 'google'), 0.032);
  assert.strictEqual(getCtrBenchmark(13, 'google'), 0.022);
});
test('ctr benchmark: beyond table uses tail; pos<=0 clamps to pos1', () => {
  assert.strictEqual(getCtrBenchmark(50, 'google'), 0.012);
  assert.strictEqual(getCtrBenchmark(0, 'yandex'), 0.352);
});

// ── Striking Distance + Opportunity Score (§5.1) ───────────────────────────
test('opportunity score = (impr*0.025 - clicks) * volume/1000', () => {
  // impr=10000, clicks=100 → delta = 250-100 = 150; volume=2000 → score=150*2=300
  const rows = [{ query: 'купить окна', url: 'https://x/p', clicks: 100, impressions: 10000, position: 12 }];
  const out = buildStrikingDistance(rows, { volumeByQuery: { 'купить окна': 2000 } });
  assert.strictEqual(out.items.length, 1);
  const it = out.items[0];
  assert.strictEqual(it.opportunity_delta, 150);
  assert.strictEqual(it.opportunity_score, 300);
  assert.strictEqual(it.priority, 'medium');
});
test('striking distance filters by position band [11,20]', () => {
  const rows = [
    { query: 'a', url: 'u1', clicks: 0, impressions: 1000, position: 5 },   // top, excluded
    { query: 'b', url: 'u2', clicks: 0, impressions: 1000, position: 15 },  // included
    { query: 'c', url: 'u3', clicks: 0, impressions: 1000, position: 25 },  // too low, excluded
  ];
  const out = buildStrikingDistance(rows, {});
  assert.strictEqual(out.items.length, 1);
  assert.strictEqual(out.items[0].query, 'b');
});
test('striking distance: missing volume → multiplier 1 (score == delta)', () => {
  const rows = [{ query: 'novol', url: 'u', clicks: 0, impressions: 1000, position: 14 }];
  const out = buildStrikingDistance(rows, {});
  assert.strictEqual(out.items[0].opportunity_delta, 25); // 1000*0.025
  assert.strictEqual(out.items[0].opportunity_score, 25);
  assert.strictEqual(out.items[0].volume, null);
});
test('priority bands: high>=500, medium 200-499, low<200', () => {
  assert.strictEqual(priorityOf(500), 'high');
  assert.strictEqual(priorityOf(499), 'medium');
  assert.strictEqual(priorityOf(200), 'medium');
  assert.strictEqual(priorityOf(199), 'low');
});
test('striking distance aggregates duplicate query+url with weighted position', () => {
  const rows = [
    { query: 'q', url: 'u', clicks: 10, impressions: 100, position: 11 },
    { query: 'q', url: 'u', clicks: 5, impressions: 100, position: 19 },
  ];
  const out = buildStrikingDistance(rows, {});
  assert.strictEqual(out.items[0].clicks, 15);
  assert.strictEqual(out.items[0].impressions, 200);
  assert.strictEqual(out.items[0].avg_position, 15); // weighted equally
});

// ── CTR Gap (§5.2) ─────────────────────────────────────────────────────────
test('isCtrGap requires impressions>=threshold, pos<=15, ctr<bench*0.7', () => {
  const s = normalizeSettings();
  // pos 3 google bench=0.11; *0.7=0.077. ctr 0.05 < 0.077 → gap
  assert.strictEqual(isCtrGap({ impressions: 600, position: 3, ctr_fraction: 0.05 }, s), true);
  // impressions below threshold
  assert.strictEqual(isCtrGap({ impressions: 100, position: 3, ctr_fraction: 0.05 }, s), false);
  // position beyond 15
  assert.strictEqual(isCtrGap({ impressions: 600, position: 16, ctr_fraction: 0.001 }, s), false);
  // ctr healthy
  assert.strictEqual(isCtrGap({ impressions: 600, position: 3, ctr_fraction: 0.10 }, s), false);
});
test('ctrGapLevel: critical < 0.5x, warning < 0.7x', () => {
  const bench = 0.10;
  assert.strictEqual(ctrGapLevel(0.04, bench), 'critical'); // <0.05
  assert.strictEqual(ctrGapLevel(0.06, bench), 'warning');  // between
  assert.strictEqual(ctrGapLevel(0.08, bench), null);       // healthy
});
test('buildCtrGaps surfaces critical/warning items', () => {
  const rows = [
    { query: 'big', url: 'u1', clicks: 12, impressions: 1000, position: 3 }, // ctr 1.2% vs bench 11% → critical
    { query: 'ok', url: 'u2', clicks: 110, impressions: 1000, position: 3 }, // ctr 11% → healthy
  ];
  const out = buildCtrGaps(rows, {});
  assert.strictEqual(out.items.length, 1);
  assert.strictEqual(out.items[0].level, 'critical');
  assert.ok(out.summary.lost_clicks > 0);
});

// ── Content Health (§5.3) + Position Trend (§5.4) ──────────────────────────
test('content health deductions', () => {
  assert.strictEqual(contentHealthScore({}), 100);
  assert.strictEqual(contentHealthScore({ is_ctr_gap: true }), 80);
  assert.strictEqual(contentHealthScore({
    is_ctr_gap: true, position_delta_30d: 6, impressions_trend: 'declining_2m',
    images_no_alt_ratio: 0.4, webp_ratio: 0.2,
  }), 40);
});
test('health status thresholds', () => {
  assert.strictEqual(healthStatus(90), 'healthy');
  assert.strictEqual(healthStatus(60), 'needs_work');
  assert.strictEqual(healthStatus(40), 'critical');
});
test('position trend: improving positions → growing', () => {
  // positions decreasing over time = ranking improves
  const out = positionTrend([20, 18, 16, 14, 12, 10, 8]);
  assert.strictEqual(out.trend, 'growing');
  assert.ok(out.slope < -0.1);
  assert.strictEqual(out.delta_7d, 8 - 20);
});
test('position trend: worsening positions → declining', () => {
  const out = positionTrend([5, 6, 7, 8, 9, 10, 11]);
  assert.strictEqual(out.trend, 'declining');
});
test('position trend: flat → stable; <2 points safe', () => {
  assert.strictEqual(positionTrend([10, 10, 10]).trend, 'stable');
  assert.strictEqual(positionTrend([10]).trend, 'stable');
  assert.strictEqual(positionTrend([]).trend, 'stable');
});
test('buildContentHealth sorts worst first', () => {
  const out = buildContentHealth([
    { url: 'good', },
    { url: 'bad', is_ctr_gap: true, position_delta_30d: 6, webp_ratio: 0.1 },
  ]);
  assert.strictEqual(out.items[0].url, 'bad');
  assert.strictEqual(out.summary.total, 2);
});

// ── Tech Audit (§3.2) ──────────────────────────────────────────────────────
test('auditHtml counts images/alt/title/webp', () => {
  const html = `<html><body>
    <img src="/a.webp" alt="a" title="t">
    <img src="/b.jpg" alt="b">
    <img src="/c.png">
  </body></html>`;
  const r = auditHtml(html, { url: 'u', httpStatus: 200 });
  assert.strictEqual(r.total_images, 3);
  assert.strictEqual(r.images_no_alt, 1);
  assert.strictEqual(r.images_no_title, 2);
  assert.strictEqual(r.images_non_webp, 2);
  assert.strictEqual(r.webp_ratio, 0.333);
});
test('summarizeTechAudit aggregates pages', () => {
  const r = summarizeTechAudit([
    { url: 'u1', total_images: 10, images_no_alt: 5, images_non_webp: 8, http_status: 200, page_size_kb: 100 },
    { url: 'u2', total_images: 0, images_no_alt: 0, images_non_webp: 0, http_status: 404, page_size_kb: 0 },
  ]);
  assert.strictEqual(r.summary.pages, 2);
  assert.strictEqual(r.summary.broken, 1);
  assert.strictEqual(r.summary.images_no_alt, 5);
});

// ── Off-Page (§3.1) ────────────────────────────────────────────────────────
test('summarizeBacklinks counts index status and donors', () => {
  const r = summarizeBacklinks([
    { url: 'https://a.ru/1', donor_domain: 'a.ru', yandex_indexed: true, google_indexed: true, http_status: 200 },
    { url: 'https://b.ru/2', yandex_indexed: false, google_indexed: true, http_status: 404 },
  ]);
  assert.strictEqual(r.summary.total, 2);
  assert.strictEqual(r.summary.unique_donors, 2);
  assert.strictEqual(r.summary.indexed_yandex, 1);
  assert.strictEqual(r.summary.indexed_google, 2);
  assert.strictEqual(r.summary.broken, 1);
});

// ── Orchestrator ───────────────────────────────────────────────────────────
test('assembleModules builds all modules and executive summary', () => {
  const out = assembleModules({
    queryPageRows: [
      { query: 'q1', url: 'https://x/p1', clicks: 5, impressions: 1000, position: 12 },
      { query: 'q2', url: 'https://x/p2', clicks: 2, impressions: 800, position: 3 },
    ],
    volumeByQuery: { q1: 3000 },
    techAudit: [{ url: 'https://x/p2', total_images: 4, images_no_alt: 3, images_non_webp: 4, images_no_alt_ratio: 0.75, webp_ratio: 0, http_status: 200, page_size_kb: 50 }],
    backlinks: [{ url: 'https://d.ru/x', donor_domain: 'd.ru', yandex_indexed: true, http_status: 200 }],
  });
  assert.ok(out.striking_distance.items.length >= 1);
  assert.ok(out.ctr_gap.items.length >= 1);
  assert.ok(out.content_health.summary.total >= 1);
  assert.ok(out.tech_audit.summary.pages === 1);
  assert.ok(out.off_page.summary.total === 1);
  assert.ok(out.executive.striking_distance);
});
test('assembleModules respects disabled modules via config', () => {
  const out = assembleModules({ queryPageRows: [] }, { config: { tech_audit: false, off_page: false } });
  assert.ok(!out.tech_audit);
  assert.ok(!out.off_page);
  assert.ok(out.striking_distance);
  assert.ok(!out.enabled.includes('tech_audit'));
});

// ── Integration health fail-counter (§ resilience) ──────────────────────────
test('nextHealth: success resets fail counter, keeps active', () => {
  const s = nextHealth({ fail_count: 2, is_active: true }, 'success');
  assert.strictEqual(s.fail_count, 0);
  assert.strictEqual(s.is_active, true);
  assert.strictEqual(s.deactivated, false);
  assert.ok(s.last_synced_at instanceof Date);
});
test('nextHealth: failures increment but stay active below threshold', () => {
  let s = nextHealth({ fail_count: 0, is_active: true }, 'failure', { reason: 'boom' });
  assert.strictEqual(s.fail_count, 1);
  assert.strictEqual(s.is_active, true);
  s = nextHealth(s, 'failure');
  assert.strictEqual(s.fail_count, 2);
  assert.strictEqual(s.is_active, true);
  assert.strictEqual(s.deactivated, false);
});
test('nextHealth: third consecutive failure auto-deactivates', () => {
  const s = nextHealth({ fail_count: 2, is_active: true }, 'failure', { reason: '401' });
  assert.strictEqual(s.fail_count, 3);
  assert.strictEqual(s.is_active, false);
  assert.strictEqual(s.deactivated, true);
  assert.strictEqual(s.last_error, '401');
});
test('nextHealth: custom threshold honoured', () => {
  const s = nextHealth({ fail_count: 1, is_active: true }, 'failure', { threshold: 2 });
  assert.strictEqual(s.is_active, false);
  assert.strictEqual(s.deactivated, true);
});
test('nextHealth: already inactive does not re-flag deactivated', () => {
  const s = nextHealth({ fail_count: 5, is_active: false }, 'failure');
  assert.strictEqual(s.is_active, false);
  assert.strictEqual(s.deactivated, false);
});
test('reactivate resets counter and marks reactivated when was inactive', () => {
  const s = reactivate({ fail_count: 4, is_active: false });
  assert.strictEqual(s.fail_count, 0);
  assert.strictEqual(s.is_active, true);
  assert.strictEqual(s.reactivated, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
