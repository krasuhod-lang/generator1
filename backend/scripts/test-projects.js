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
function test(name, fn) {
  try {
    fn();
    passed += 1;
    // eslint-disable-next-line no-console
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    // eslint-disable-next-line no-console
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
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

// ── summary ──────────────────────────────────────────────────────────
// eslint-disable-next-line no-console
console.log(`\nProjects smoke test: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
