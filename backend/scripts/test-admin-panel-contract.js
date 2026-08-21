'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const controller = read('backend/src/controllers/admin.controller.js');
const aegisCard = read('frontend/src/components/AdminAegisCostsCard.vue');
const userPage = read('frontend/src/views/admin/AdminUserDetailPage.vue');
const detailPage = read('frontend/src/views/admin/AdminTaskDetailPage.vue');
const dashboard = read('frontend/src/views/admin/AdminDashboardPage.vue');

for (const source of ['serp_b2b', 'category_lead', 'parser', 'site_crawl']) {
  assert(controller.includes(`${source}: Object.freeze({`), `missing admin source ${source}`);
}
assert(controller.includes("t.id::text                          AS id"), 'cross-task IDs must support UUID and BIGINT');
assert(controller.includes("const validIntegerId = /^\\d+$/.test(id);"), 'cross-task detail must accept numeric IDs');
assert(controller.includes('COALESCE(cache_hit_tokens, cached_tokens)'), 'legacy/new cache hit fallback missing');
assert(controller.includes('COALESCE(cache_miss_tokens, GREATEST'), 'cache miss fallback missing');
assert(controller.includes('t.cache_hit_tokens == null ? cachedTokens'), 'zero-safe cache hit normalization missing');
assert(!controller.includes('Number(t.cache_hit_tokens || cachedTokens)'), 'truthy fallback can hide real zero cache hits');

for (const field of ['by_model', 'input_cost_usd', 'output_cost_usd', 'cache_hit_tokens', 'cache_miss_tokens']) {
  assert(aegisCard.includes(field), `Aegis card missing ${field}`);
}
assert(aegisCard.includes('row.cache_hit_tokens ?? row.cached_tokens'), 'Aegis card cache percentage fallback missing');

for (const source of ['serp_b2b', 'category_lead', 'parser', 'site_crawl']) {
  assert(userPage.includes(`${source}:`), `user detail missing module ${source}`);
  assert(detailPage.includes(`source === '${source}'`), `task detail missing subtitle ${source}`);
}
assert(dashboard.includes('dashboardError'), 'dashboard error state missing');
assert(dashboard.includes('Math.abs(n) < 0.01 ? 6 : 4'), 'dashboard micro-cost formatting missing');
assert(userPage.includes('Math.abs(n) < 0.01 ? 6 : 4'), 'user detail micro-cost formatting missing');

console.log('admin panel contract regression: 26/26 checks passed');
