'use strict';

const assert = require('assert');

const reliability = require('../src/services/tasks/reliability');
const { normalizeUrls } = require('../src/services/parser/parserTaskService');
const {
  generationQueue,
  parserQueue,
  siteCrawlerQueue,
  auditQueue,
  projectAnalysisQueue,
  reportSummaryQueue,
} = require('../src/queue/queue');

class FakeDb {
  constructor() {
    this.calls = [];
  }

  async query(sql, params = []) {
    this.calls.push({ sql, params });
    if (sql.includes('UPDATE parser_task_items') && sql.includes("SET status='running'")) {
      return { rowCount: 1, rows: [{ id: 'item-1', task_id: 'task-1', normalized_url: 'https://example.com', attempts: 1 }] };
    }
    if (sql.includes('UPDATE parser_task_items') && sql.includes("SET status='retry_wait'")) {
      return { rowCount: 1, rows: [{ task_id: 'task-1', attempts: 1 }] };
    }
    if (sql.includes('UPDATE parser_task_items') && sql.includes("SET status=$3")) {
      return { rowCount: 1, rows: [{ task_id: 'task-1' }] };
    }
    if (sql.includes('UPDATE parser_task_items') && sql.includes("SET heartbeat_at") && sql.includes("lease_token=$2")) {
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('UPDATE parser_task_items') && sql.includes("lease_until < NOW()")) {
      return { rowCount: 1, rows: [{ id: 'item-1', task_id: 'task-1', status: 'queued' }] };
    }
    if (sql.includes('UPDATE tasks')) return { rowCount: 1, rows: [{ id: 'task-1' }] };
    if (sql.includes('UPDATE parser_tasks')) return { rowCount: 1, rows: [{ id: 'task-1' }] };
    if (sql.includes('UPDATE site_crawl_tasks')) return { rowCount: 1, rows: [{ id: 1 }] };
    return { rowCount: 0, rows: [] };
  }
}

async function main() {
  const normalized = normalizeUrls([
    'example.com',
    'https://example.com/',
    'not a url',
    'https://example.org/path',
  ]);
  assert.strictEqual(normalized.length, 2, 'URL normalization must deduplicate and reject invalid input');
  assert.strictEqual(normalized[0].normalizedUrl, 'https://example.com/');

  const db = new FakeDb();
  const claimed = await reliability.claimParserItem('item-1', 'test-worker', db);
  assert.ok(claimed && claimed.token, 'item must be claimed with a lease token');
  assert.ok(db.calls[0].sql.includes('lease_token'));

  assert.strictEqual(
    await reliability.heartbeatParserItem('item-1', claimed.token, { last_url: 'https://example.com' }, db),
    true,
  );
  const retry = await reliability.retryParserItem('item-1', claimed.token, new Error('temporary'), 1000, db);
  assert.strictEqual(retry.task_id, 'task-1');

  const reclaimed = await reliability.claimParserItem('item-1', 'new-worker', db);
  assert.ok(reclaimed, 'a retry item must be claimable by a new worker');
  const finished = await reliability.finishParserItem('item-1', reclaimed.token, { status: 'ok' }, 'completed', null, db);
  assert.strictEqual(finished.task_id, 'task-1');

  const recovered = await reliability.recoverExpiredWork(db);
  assert.deepStrictEqual(recovered, {
    tasks: 1,
    parserTasks: 1,
    parserItems: 1,
    crawls: 1,
    projectAnalyses: 0,
    reportSummaries: 0,
  });
  assert.ok(db.calls.some((call) => call.sql.includes("last_error_code='worker_restarted'")));

  await Promise.all([
    generationQueue.close(), parserQueue.close(), siteCrawlerQueue.close(), auditQueue.close(),
    projectAnalysisQueue.close(), reportSummaryQueue.close(),
  ]);
  console.log('durable task reliability tests passed');
}

main().catch(async (error) => {
  console.error(error.stack || error.message);
  await Promise.allSettled([
    generationQueue.close(), parserQueue.close(), siteCrawlerQueue.close(), auditQueue.close(),
    projectAnalysisQueue.close(), reportSummaryQueue.close(),
  ]);
  process.exitCode = 1;
});
