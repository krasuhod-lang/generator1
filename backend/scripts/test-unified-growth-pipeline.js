'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { normalizeOpportunities } = require('../src/services/projects/growthOpportunities');
const { sanitizeData } = require('../src/services/reports/viewModeSanitizer');

function run() {
  const modules = {
    striking_distance: {
      items: [{ query: 'industrial filter', url: 'https://example.test/filter', position: 12, impressions: 1200, opportunity_clicks: 80 }],
      summary: { total: 1 },
    },
    ctr_gap: {
      items: [{ url: 'https://example.test/page', ctr: 1.2, impressions: 5000, lost_clicks: 50, opportunity_score: 99 }],
      summary: { total: 1 },
    },
    content_health: {
      items: [{ url: 'https://example.test/article', issue: 'Нет доказательного блока', critical: true }],
      summary: { total: 1, critical: 1 },
    },
  };

  const opportunities = normalizeOpportunities(modules, { source: 'test' });
  assert.strictEqual(opportunities.length, 3);
  assert.deepStrictEqual(
    opportunities.map((item) => item.category).sort(),
    ['content', 'ctr_gap', 'striking_distance'],
  );
  assert.ok(opportunities[0].opportunityKey);
  assert.ok(opportunities[0].recommendation);
  assert.ok(opportunities[0].successMetric);
  assert.ok(opportunities.every((item) => item.evidence.length === 1));

  const client = sanitizeData({
    growth: {
      count: 1,
      opportunities: [{
        id: '1',
        title: 'CTR gap',
        priority: 'high',
        priority_score: 98,
        recommendation: 'Rewrite snippet',
        success_metric: 'CTR',
        measurement: { observed_ctr: 1.2 },
        next_check_at: '2026-09-01',
        linked_task_ids: ['task-1'],
        evidence: [{ source: 'gsc', url: 'https://example.test', fact: '500 impressions' }],
        debug: 'must be hidden',
      }],
    },
  }, 'client');
  assert.strictEqual(client.growth.opportunities.length, 1);
  assert.strictEqual(client.growth.opportunities[0].priority_score, undefined);
  assert.strictEqual(client.growth.opportunities[0].debug, undefined);
  assert.strictEqual(client.growth.opportunities[0].recommendation, 'Rewrite snippet');
  assert.strictEqual(client.growth.opportunities[0].evidence[0].source, 'gsc');
  assert.deepStrictEqual(client.growth.opportunities[0].measurement, { observed_ctr: 1.2 });
  assert.strictEqual(client.growth.opportunities[0].next_check_at, '2026-09-01');
  assert.deepStrictEqual(client.growth.opportunities[0].linked_task_ids, ['task-1']);

  const migration = fs.readFileSync(path.join(__dirname, '../../migrations/133_unified_growth_pipeline.sql'), 'utf8');
  assert.match(migration, /project_growth_opportunities/);
  assert.match(migration, /analysis_id/);
  assert.match(migration, /snapshot_id/);
  assert.match(migration, /opportunity_id/);

  const workerSource = fs.readFileSync(path.join(__dirname, '../src/queue/projectReportWorker.js'), 'utf8');
  assert.match(workerSource, /startProjectReportWorkers/);
  assert.match(workerSource, /stopProjectReportWorkers/);
  assert.match(workerSource, /claimProjectAnalysis/);
  assert.match(workerSource, /runReportSummaryJob/);

  const renderer = fs.readFileSync(path.join(__dirname, '../../frontend/src/components/reports/ReportRenderer.vue'), 'utf8');
  assert.match(renderer, /id="report-growth"/);
  assert.match(renderer, /growthOpportunities/);

  console.log('Unified growth pipeline smoke: 11/11 PASS');
}

run();
