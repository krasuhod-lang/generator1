'use strict';

/**
 * Smoke-тест модуля «Проекты» (Part 2) + SEO-meta (Part 1).
 * Покрывает детерминированные части без сети: шифрование токенов,
 * share-токены, OAuth state (HMAC), resolveRange, SEO-meta хелперы.
 *
 * Запуск: node backend/scripts/test-projects.js
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-projects-smoke';

const assert = require('assert');

let passed = 0;
let failed = 0;
const pending = [];
function test(name, fn) {
  const run = (async () => {
    try {
      await fn();
      passed += 1;
      // eslint-disable-next-line no-console
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.error(`  ✗ ${name}\n    ${err.message}`);
    }
  })();
  pending.push(run);
}

// ── tokenCrypto ──────────────────────────────────────────────────────
const { encryptToken, decryptToken } = require('../src/services/projects/tokenCrypto');

test('encrypt/decrypt roundtrip', () => {
  const secret = 'ya29.a0AfH6SMC-fake-access-token-value';
  const enc = encryptToken(secret);
  assert.notStrictEqual(enc, secret, 'ciphertext must differ from plaintext');
  assert.ok(enc.split('.').length === 3, 'format iv.tag.ct');
  assert.strictEqual(decryptToken(enc), secret);
});

test('encrypt produces different ciphertext each time (random IV)', () => {
  const a = encryptToken('same-token');
  const b = encryptToken('same-token');
  assert.notStrictEqual(a, b, 'IV randomization');
  assert.strictEqual(decryptToken(a), decryptToken(b));
});

test('decrypt rejects tampered ciphertext', () => {
  const enc = encryptToken('secret');
  const parts = enc.split('.');
  // подменяем последний символ ciphertext
  const bad = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -2)}${parts[2].slice(-2) === 'AA' ? 'BB' : 'AA'}`;
  assert.throws(() => decryptToken(bad));
});

test('decrypt rejects malformed payload', () => {
  assert.throws(() => decryptToken('not-a-valid-payload'));
});

// ── shareToken ───────────────────────────────────────────────────────
const { generateShareToken, isValidShareToken } = require('../src/services/projects/shareToken');

test('share token generated and valid', () => {
  const t = generateShareToken();
  assert.ok(isValidShareToken(t), 'generated token must validate');
});

test('share token rejects bad input', () => {
  assert.strictEqual(isValidShareToken(''), false);
  assert.strictEqual(isValidShareToken('short'), false);
  assert.strictEqual(isValidShareToken('has space!'), false);
  assert.strictEqual(isValidShareToken(null), false);
  assert.strictEqual(isValidShareToken('a'.repeat(100)), false);
});

// ── OAuth state (HMAC, CSRF) ─────────────────────────────────────────
const gsc = require('../src/services/projects/gscClient');

test('OAuth state roundtrip verifies', () => {
  const state = gsc.buildState('proj-123', 'user-9');
  const v = gsc.verifyState(state);
  assert.strictEqual(v.projectId, 'proj-123');
  assert.strictEqual(v.userId, 'user-9');
});

test('OAuth state rejects tampering', () => {
  const state = gsc.buildState('proj-123', 'user-9');
  const parts = state.split('.');
  // подменяем подпись
  const tampered = `${parts[0]}.${parts[1].slice(0, -2)}${parts[1].slice(-2) === 'AA' ? 'BB' : 'AA'}`;
  assert.strictEqual(gsc.verifyState(tampered), null);
});

test('OAuth state rejects garbage', () => {
  assert.strictEqual(gsc.verifyState('garbage'), null);
  assert.strictEqual(gsc.verifyState(''), null);
  assert.strictEqual(gsc.verifyState('a.b'), null);
});

// ── resolveRange ─────────────────────────────────────────────────────
const { resolveRange } = require('../src/services/projects/gscService');

test('resolveRange explicit from/to passthrough', () => {
  const r = resolveRange({ from: '2026-01-01', to: '2026-01-31' });
  assert.strictEqual(r.startDate, '2026-01-01');
  assert.strictEqual(r.endDate, '2026-01-31');
});

test('resolveRange days default 28 with 2-day lag', () => {
  const r = resolveRange({ days: 28 });
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.startDate));
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.endDate));
  const span = (new Date(r.endDate) - new Date(r.startDate)) / 86400000;
  assert.strictEqual(span, 27, '28 days inclusive = 27 day span');
});

test('resolveRange handles 7d', () => {
  const r = resolveRange({ days: 7 });
  const span = (new Date(r.endDate) - new Date(r.startDate)) / 86400000;
  assert.strictEqual(span, 6);
});

// ── SEO meta helpers (Part 1) ────────────────────────────────────────
const seo = require('../src/services/infoArticle/seoMeta.service');

test('clampText enforces limit on word boundary', () => {
  const out = seo.clampText('a'.repeat(100), 60);
  assert.ok(out.length <= 60, `got ${out.length}`);
});

test('clampText passes short text', () => {
  assert.strictEqual(seo.clampText('Короткий заголовок', 60), 'Короткий заголовок');
});

test('extractH1 pulls first heading', () => {
  const h = seo.extractH1('<h1>Как выбрать котёл</h1><p>текст</p>');
  assert.strictEqual(h, 'Как выбрать котёл');
});

test('deterministicMeta respects limits', () => {
  const m = seo.deterministicMeta({
    topic: 'Выбор отопительного котла для частного дома',
    brand: 'ТеплоДом',
    articleHtml: '<h1>Как выбрать котёл</h1><p>Подробный гайд по выбору котла отопления для дома.</p>',
    articlePlain: 'Подробный гайд по выбору котла отопления для дома.',
  });
  assert.ok(m.title.length <= seo.TITLE_MAX, `title ${m.title.length} <= ${seo.TITLE_MAX}`);
  assert.ok(m.description.length <= seo.DESC_MAX, `desc ${m.description.length} <= ${seo.DESC_MAX}`);
  assert.ok(m.title.length > 0 && m.description.length > 0);
});

// ── compareSnapshots (PR 1: персистентность) ────────────────────────
const { compareSnapshots } = require('../src/services/projects/periodComparison');

test('compareSnapshots returns unavailable on missing input', () => {
  assert.strictEqual(compareSnapshots(null, {}).available, false);
  assert.strictEqual(compareSnapshots({}, null).available, false);
});

test('compareSnapshots returns unavailable when totals missing', () => {
  const out = compareSnapshots({ top_queries: [] }, { top_queries: [] });
  assert.strictEqual(out.available, false);
  assert.strictEqual(out.reason, 'no_totals');
});

test('compareSnapshots computes totals + queries diff', () => {
  const curr = {
    range: { startDate: '2026-05-01', endDate: '2026-05-28' },
    totals: { clicks: 200, impressions: 4000, ctr: 5, position: 12 },
    top_queries: [
      { key: 'seo audit', clicks: 50, impressions: 1000, ctr: 5, position: 8 },
      { key: 'new query', clicks: 20, impressions: 500,  ctr: 4, position: 9 },
    ],
    top_pages: [],
  };
  const prev = {
    range: { startDate: '2026-04-01', endDate: '2026-04-28' },
    totals: { clicks: 150, impressions: 3000, ctr: 5, position: 13 },
    top_queries: [
      { key: 'seo audit', clicks: 30, impressions: 800, ctr: 3.75, position: 9 },
      { key: 'lost query', clicks: 25, impressions: 600, ctr: 4.16, position: 11 },
    ],
    top_pages: [],
  };
  const out = compareSnapshots(curr, prev, {
    minImpressions: 0, minClicksAbsDelta: 0, topQueriesDelta: 5, topPagesDelta: 5,
  });
  assert.strictEqual(out.available, true);
  assert.strictEqual(out.totals.delta.clicks, 50);
  assert.strictEqual(out.totals.delta.impressions, 1000);
  // Δposition отрицательная = улучшение (с 13 на 12).
  assert.strictEqual(out.totals.delta.position, -1);
  // Запросы: 1 общий, 1 новый, 1 потерянный.
  const newcomerKeys = out.queries.newcomers.map((r) => r.key);
  const lostKeys = out.queries.lost.map((r) => r.key);
  assert.ok(newcomerKeys.includes('new query'));
  assert.ok(lostKeys.includes('lost query'));
  // Risers — самый растущий «seo audit» (+20 кликов).
  assert.strictEqual(out.queries.risers[0].key, 'seo audit');
  assert.strictEqual(out.queries.risers[0].delta.clicks, 20);
  assert.deepStrictEqual(out.periods.curr, curr.range);
  assert.deepStrictEqual(out.periods.prev, prev.range);
});

// ── snapshotsRepo (без БД, лёгкий smoke) ────────────────────────────
const snapshotsRepo = require('../src/services/projects/snapshotsRepo');

test('snapshotsRepo.insertSnapshot rejects empty period', async () => {
  let threw = false;
  try {
    await snapshotsRepo.insertSnapshot({ projectId: 'p', userId: 'u', gscData: {} },
      { query: async () => ({ rows: [] }) });
  } catch (_) { threw = true; }
  assert.ok(threw, 'must throw without periodFrom/periodTo');
});

test('snapshotsRepo.insertSnapshot rejects missing gscData', async () => {
  let threw = false;
  try {
    await snapshotsRepo.insertSnapshot(
      { projectId: 'p', userId: 'u', periodFrom: '2026-01-01', periodTo: '2026-01-28' },
      { query: async () => ({ rows: [] }) },
    );
  } catch (_) { threw = true; }
  assert.ok(threw, 'must throw without gscData');
});

test('snapshotsRepo.insertSnapshot normalizes unknown source to manual', async () => {
  let captured = null;
  const fakeDb = {
    async query(sql, params) {
      captured = { sql, params };
      return { rows: [{ id: 'snap-1', created_at: '2026-06-01T00:00:00Z' }] };
    },
  };
  const out = await snapshotsRepo.insertSnapshot({
    projectId: 'p', userId: 'u',
    rangeKey: '28d', periodFrom: '2026-01-01', periodTo: '2026-01-28',
    source: 'evil-source-tag', gscData: { totals: {} },
  }, fakeDb);
  assert.strictEqual(out.id, 'snap-1');
  // 6-й параметр — source.
  assert.strictEqual(captured.params[5], 'manual');
});

// ── summary ──────────────────────────────────────────────────────────
Promise.all(pending).then(() => {
  // eslint-disable-next-line no-console
  console.log(`\nProjects smoke test: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
});
