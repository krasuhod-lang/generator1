const assert = require('assert');
const {
  PLAN_CATALOG,
  normalizeRole,
  sanitizeTaskForClient,
  sanitizeMetricsForClient,
  sanitizeBlockForClient,
  clientVisibilityError,
} = require('../src/services/access/entitlementPolicy');

const task = sanitizeTaskForClient({
  id: 'task-1',
  status: 'completed',
  full_html: '<article>готово</article>',
  total_cost_usd: 1.23,
  gemini_tokens_in: 100,
  tokens_out: 200,
  model_used: 'secret-model',
  error_message: 'internal stack details',
  worker_id: 'worker-1',
  queue_reason: 'user_limit',
});
assert.equal(task.full_html, '<article>готово</article>');
assert.equal(task.total_cost_usd, undefined);
assert.equal(task.gemini_tokens_in, undefined);
assert.equal(task.tokens_out, undefined);
assert.equal(task.model_used, undefined);
assert.equal(task.error_message, undefined);
assert.equal(task.worker_id, undefined);
assert.equal(task.queue_reason, undefined);
assert.equal(task.status_message, 'Результат готов.');

const metrics = sanitizeMetricsForClient({
  eeat_score: 8.4,
  lsi_coverage: 92,
  total_cost_usd: 9.99,
  gemini_tokens_out: 1234,
});
assert.deepEqual(metrics, { eeat_score: 8.4, lsi_coverage: 92 });

const block = sanitizeBlockForClient({
  html_content: '<p>result</p>',
  pq_score: 8.5,
  audit_log_json: { internal: true },
  cost_usd: 2,
  tokens_out: 99,
});
assert.equal(block.html_content, '<p>result</p>');
assert.equal(block.pq_score, 8.5);
assert.equal(block.audit_log_json, undefined);
assert.equal(block.cost_usd, undefined);
assert.equal(block.tokens_out, undefined);

assert.equal(normalizeRole('user'), 'client');
assert.equal(normalizeRole('employee'), 'employee');
assert.equal(PLAN_CATALOG.minimal.priceRub, 4990);
assert.equal(PLAN_CATALOG.medium.limits.meta_categories, 140);
assert.equal(PLAN_CATALOG.pro.limits.link_articles, 30);
assert.equal(clientVisibilityError().status, 403);

console.log('clientVisibility.test.js: all assertions passed');
