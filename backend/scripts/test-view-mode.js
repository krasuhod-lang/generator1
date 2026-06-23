'use strict';

/**
 * test-view-mode.js — юнит-тесты слоя режима просмотра (analyst|client).
 *
 * Запуск:  node backend/scripts/test-view-mode.js
 * Стиль и assert-обёртка совпадают с остальными test-*.js скриптами модуля.
 */

const assert = require('assert');
const {
  VIEW_MODES,
  normalizeMode,
  resolveViewMode,
  sanitizeProject,
  sanitizeAnalysis,
} = require('../src/services/projects/viewMode');

let total = 0, failed = 0;
function test(name, fn) {
  total += 1;
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('── normalizeMode ───────────────────────────────');
test('valid analyst', () => assert.strictEqual(normalizeMode('analyst'), 'analyst'));
test('valid client',  () => assert.strictEqual(normalizeMode('CLIENT'), 'client'));
test('unknown → fallback default',  () => assert.strictEqual(normalizeMode('xxx'), 'analyst'));
test('unknown → explicit fallback', () => assert.strictEqual(normalizeMode(null, 'client'), 'client'));
test('frozen VIEW_MODES enum',      () => {
  assert.strictEqual(VIEW_MODES.ANALYST, 'analyst');
  assert.strictEqual(VIEW_MODES.CLIENT,  'client');
});

console.log('\n── resolveViewMode ─────────────────────────────');
test('default authenticated → analyst', () => {
  assert.strictEqual(resolveViewMode({ headers: {}, query: {} }), 'analyst');
});
test('X-Client-Mode: 1 → client', () => {
  assert.strictEqual(resolveViewMode({ headers: { 'x-client-mode': '1' }, query: {} }), 'client');
});
test('X-Client-Mode: true → client', () => {
  assert.strictEqual(resolveViewMode({ headers: { 'x-client-mode': 'true' }, query: {} }), 'client');
});
test('X-Client-Mode: 0 → analyst', () => {
  assert.strictEqual(resolveViewMode({ headers: { 'x-client-mode': '0' }, query: {} }), 'analyst');
});
test('?mode=client without header → client', () => {
  assert.strictEqual(resolveViewMode({ headers: {}, query: { mode: 'client' } }), 'client');
});
test('?mode=garbage → analyst (fallback)', () => {
  assert.strictEqual(resolveViewMode({ headers: {}, query: { mode: 'xx' } }), 'analyst');
});
test('public share with shareMode=client → client', () => {
  assert.strictEqual(resolveViewMode({ headers: {}, query: {} }, { shareMode: 'client', isPublic: true }), 'client');
});
test('public share with shareMode=analyst → analyst', () => {
  assert.strictEqual(resolveViewMode({ headers: {}, query: {} }, { shareMode: 'analyst', isPublic: true }), 'analyst');
});
test('public share ignores X-Client-Mode (cannot escalate)', () => {
  // shareMode=client, но в заголовке analyst — публичная ссылка остаётся client.
  assert.strictEqual(
    resolveViewMode({ headers: { 'x-client-mode': 'analyst' }, query: {} }, { shareMode: 'client', isPublic: true }),
    'client',
  );
});

console.log('\n── sanitizeProject ─────────────────────────────');
test('analyst → объект не мутируется и возвращается как есть', () => {
  const p = { id: 1, name: 'X', gsc_access_token_enc: 'secret', share_token: 't' };
  const out = sanitizeProject(p, 'analyst');
  assert.strictEqual(out, p);
  assert.strictEqual(out.gsc_access_token_enc, 'secret');
});
test('client → тех. поля удалены, исходник не мутирован', () => {
  const p = {
    id: 1, name: 'X', url: 'https://x',
    gsc_access_token_enc: 'secret',
    gsc_refresh_token_enc: 'r',
    ydx_access_token_enc: 'r',
    share_token: 't',
    share_expires_at: '2099-01-01',
    keys_so_domain: 'x.ru',
  };
  const out = sanitizeProject(p, 'client');
  assert.notStrictEqual(out, p, 'должна быть копия');
  assert.strictEqual(out.gsc_access_token_enc, undefined);
  assert.strictEqual(out.gsc_refresh_token_enc, undefined);
  assert.strictEqual(out.ydx_access_token_enc, undefined);
  assert.strictEqual(out.share_token, undefined);
  assert.strictEqual(out.share_expires_at, undefined);
  assert.strictEqual(out.keys_so_domain, undefined);
  // Видимые клиенту поля сохранены.
  assert.strictEqual(out.id, 1);
  assert.strictEqual(out.name, 'X');
  assert.strictEqual(out.url, 'https://x');
  // Исходник не мутирован.
  assert.strictEqual(p.gsc_access_token_enc, 'secret');
});
test('null/undefined → пробрасываем как есть', () => {
  assert.strictEqual(sanitizeProject(null,      'client'), null);
  assert.strictEqual(sanitizeProject(undefined, 'client'), undefined);
});

console.log('\n── sanitizeAnalysis ───────────────────────────');
test('client → срезает debug/prompt + чистит вложенные snapshot', () => {
  const a = {
    id: 1,
    report_markdown: '# отчёт',
    ranking_factors_debug: { ok: true },
    llm_meta: { tokens: 100 },
    gsc_snapshot: {
      kpi: { clicks: 10 },
      debug: { x: 1 },
      raw_prompt: 'system: ...',
      top_page_insights: { score: 80, profile_debug: { hint: 'x' } },
      action_plan: { recommendations: [], debug: { z: 1 } },
    },
    ydx_snapshot: { kpi: { shows: 5 }, raw: 'xml...' },
  };
  const out = sanitizeAnalysis(a, 'client');
  assert.strictEqual(out.report_markdown, '# отчёт');
  assert.strictEqual(out.ranking_factors_debug, undefined);
  assert.strictEqual(out.llm_meta, undefined);
  assert.deepStrictEqual(out.gsc_snapshot.kpi, { clicks: 10 });
  assert.strictEqual(out.gsc_snapshot.debug, undefined);
  assert.strictEqual(out.gsc_snapshot.raw_prompt, undefined);
  assert.strictEqual(out.gsc_snapshot.top_page_insights.score, 80);
  assert.strictEqual(out.gsc_snapshot.top_page_insights.profile_debug, undefined);
  assert.strictEqual(out.gsc_snapshot.action_plan.debug, undefined);
  assert.strictEqual(out.ydx_snapshot.raw, undefined);
  // Исходник не мутирован.
  assert.deepStrictEqual(a.ranking_factors_debug, { ok: true });
  assert.deepStrictEqual(a.gsc_snapshot.debug, { x: 1 });
});
test('analyst → объект возвращается без изменений', () => {
  const a = { id: 1, ranking_factors_debug: { x: 1 }, gsc_snapshot: { debug: { y: 1 } } };
  const out = sanitizeAnalysis(a, 'analyst');
  assert.strictEqual(out, a);
  assert.deepStrictEqual(out.ranking_factors_debug, { x: 1 });
});

console.log(`\nИтого: ${total - failed}/${total} тестов прошли.`);
if (failed > 0) process.exit(1);
