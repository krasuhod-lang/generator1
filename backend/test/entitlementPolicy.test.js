'use strict';

const assert = require('assert');
const {
  ROLES, PLAN_KEYS, PLAN_CATALOG,
  normalizeRole, normalizePlanKey, sanitizeOverrides, effectiveLimits,
  admitUsage, admitTaskUsage, withTaskUsageReservation,
} = require('../src/services/access/entitlementPolicy');

assert.strictEqual(normalizeRole('user'), ROLES.CLIENT);
assert.strictEqual(normalizeRole('customer'), ROLES.CLIENT);
assert.strictEqual(normalizeRole('employee'), ROLES.EMPLOYEE);
assert.strictEqual(normalizeRole('admin'), ROLES.ADMIN);
assert.strictEqual(normalizeRole('unexpected'), ROLES.CLIENT);
assert.strictEqual(normalizePlanKey('pro', ROLES.EMPLOYEE), PLAN_KEYS.INTERNAL);
assert.strictEqual(normalizePlanKey('not-a-plan', ROLES.CLIENT), PLAN_KEYS.TRIAL);
assert.strictEqual(PLAN_CATALOG.minimal.limits.seo_articles, 5);
assert.strictEqual(PLAN_CATALOG.medium.limits.meta_categories, 140);
assert.strictEqual(PLAN_CATALOG.pro.limits.link_articles, 30);
assert.strictEqual(PLAN_CATALOG.trial.limits.article_generations, 5);
assert.deepStrictEqual(sanitizeOverrides({ seo_articles: '7', max_concurrent: 100 }), { seo_articles: 7, max_concurrent: 50 });
assert.throws(() => sanitizeOverrides({ can_admin: true }), (error) => error.code === 'invalid_access_override');
assert.strictEqual(effectiveLimits({ account_role: 'admin', plan_key: 'internal', status: 'active' }).max_concurrent, 50);
assert.strictEqual(effectiveLimits({ account_role: 'employee', plan_key: 'internal', status: 'active', overrides: { seo_articles: 2 } }).seo_articles, 2);
assert.strictEqual(effectiveLimits({ account_role: 'client', plan_key: 'trial', status: 'active' }).article_generations, 5);

const state = { reservations: [], nextId: 1 };
const profile = { id: 'u1', account_role: 'client', plan_key: 'minimal', status: 'active', period_start: new Date('2026-08-01T00:00:00Z'), period_end: new Date('2026-09-01T00:00:00Z'), overrides: {}, legacy_role: 'user' };
let activeProfile = profile;
const fakeClient = {
  async query(sql, params = []) {
    const text = String(sql);
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK' || text.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (text.includes('SELECT id, units, state FROM access_usage_reservations')) {
      const row = state.reservations.find((item) => item.user_id === params[0] && item.period_key === params[1] && item.resource_key === params[2] && item.source === params[3] && item.task_id === params[4] && item.item_index === params[5]);
      return { rows: row ? [row] : [] };
    }
    if (text.includes('SELECT COALESCE(SUM(units),0)')) {
      const used = state.reservations.filter((item) => item.user_id === params[0] && item.period_key === params[1] && item.resource_key === params[2] && item.state !== 'released' && !(item.source === params[3] && item.task_id === params[4] && item.item_index === params[5])).reduce((sum, item) => sum + item.units, 0);
      return { rows: [{ used }] };
    }
    if (text.includes('INSERT INTO access_usage_reservations')) {
      const row = { id: `r${state.nextId++}`, user_id: params[0], period_key: params[1], resource_key: params[2], source: params[3], task_id: params[4], item_index: params[5], units: params[6], state: 'reserved' };
      state.reservations.push(row);
      return { rows: [row] };
    }
    if (text.includes("UPDATE access_usage_reservations SET state='consumed'")) {
      const row = state.reservations.find((item) => item.id === params[0]);
      if (row) row.state = 'consumed';
      return { rowCount: row ? 1 : 0, rows: [] };
    }
    if (text.includes("UPDATE access_usage_reservations SET state='released'")) {
      const row = state.reservations.find((item) => item.id === params[0]);
      if (row) row.state = 'released';
      return { rowCount: row ? 1 : 0, rows: [] };
    }
    throw new Error(`Unhandled fake SQL: ${text}`);
  },
  release() {},
};
const fakeDb = {
  async query(sql, params) {
    if (String(sql).includes('FROM users u')) return { rows: [activeProfile] };
    if (String(sql).includes('UPDATE access_usage_reservations')) return fakeClient.query(sql, params);
    throw new Error(`Unhandled fake pool SQL: ${sql}`);
  },
  async getClient() { return fakeClient; },
};

(async () => {
  const first = await admitUsage({ userId: 'u1', resourceKey: 'seo_articles', units: 1, source: 'seo_start', taskId: 'task-1', db: fakeDb });
  assert.strictEqual(first.admitted, true);
  assert.strictEqual(state.reservations.length, 1);
  const second = await admitUsage({ userId: 'u1', resourceKey: 'seo_articles', units: 1, source: 'seo_start', taskId: 'task-1', db: fakeDb });
  assert.strictEqual(second.idempotent, true);
  assert.strictEqual(state.reservations.length, 1);
  await withTaskUsageReservation({ userId: 'u1', taskType: 'info_article', taskId: 'task-2', db: fakeDb, fn: async () => ({ ok: true }) });
  assert.strictEqual(state.reservations.find((item) => item.task_id === 'task-2').state, 'consumed');
  await assert.rejects(() => admitUsage({ userId: 'u1', resourceKey: 'seo_articles', units: 5, source: 'seo_start', taskId: 'task-3', db: fakeDb }), (error) => error.code === 'entitlement_limit' && error.status === 402);
  const meta = await admitTaskUsage({ userId: 'u1', taskType: 'meta_tags', units: 3, source: 'meta_tags_create', taskId: 'meta-1', db: fakeDb });
  assert.strictEqual(meta.admitted, true);
  assert.strictEqual(state.reservations.find((item) => item.task_id === 'meta-1').units, 3);
  activeProfile = { ...profile, plan_key: 'trial', period_end: null };
  const trialSeo = await admitTaskUsage({ userId: 'u1', taskType: 'seo', taskId: 'trial-seo', db: fakeDb });
  const trialBlog = await admitTaskUsage({ userId: 'u1', taskType: 'info_article', taskId: 'trial-blog', db: fakeDb });
  assert.strictEqual(trialSeo.admitted, true);
  assert.strictEqual(trialBlog.admitted, true);
  assert.strictEqual(state.reservations.find((item) => item.task_id === 'trial-seo').resource_key, 'article_generations');
  assert.strictEqual(state.reservations.find((item) => item.task_id === 'trial-blog').resource_key, 'article_generations');
  console.log('entitlementPolicy.test.js: OK');
})().catch((error) => { console.error(error); process.exitCode = 1; });
