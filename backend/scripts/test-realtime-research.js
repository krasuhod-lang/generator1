'use strict';

/* Smoke-тест realtimeResearch: normalizeResearch + hasRealtimeData +
 * renderRealtimeDataSection (§2b REAL-TIME DATA для IAKB/LAKB). */

const assert = require('assert');
const {
  normalizeResearch,
  hasRealtimeData,
  renderRealtimeDataSection,
} = require('../src/services/llm/realtimeResearch');

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log('✓', name); passed++; }
  catch (e) { console.error('✗', name, '\n  ', e.message); failed++; }
}

t('normalizeResearch: маппит контракт perplexityResearcher', () => {
  const out = normalizeResearch({
    current_stats: [{ fact: 'x', value: '1' }],
    expert_quotes: [{ quote: 'q', author: 'A' }],
    latest_trends: ['t1'],
    legal_or_price_updates: ['l1'],
  });
  assert.strictEqual(out.realtime_facts.length, 1);
  assert.strictEqual(out.expert_quotes.length, 1);
  assert.deepStrictEqual(out.latest_trends, ['t1']);
  assert.deepStrictEqual(out.legal_updates, ['l1']);
});

t('normalizeResearch: null / не-объект → null', () => {
  assert.strictEqual(normalizeResearch(null), null);
  assert.strictEqual(normalizeResearch('str'), null);
});

t('normalizeResearch: отсутствующие поля → пустые массивы', () => {
  const out = normalizeResearch({});
  assert.deepStrictEqual(out, {
    realtime_facts: [], expert_quotes: [], latest_trends: [], legal_updates: [],
  });
});

t('hasRealtimeData: true только при непустых данных', () => {
  assert.strictEqual(hasRealtimeData(null), false);
  assert.strictEqual(hasRealtimeData({}), false);
  assert.strictEqual(hasRealtimeData({ realtime_facts: [], expert_quotes: [], latest_trends: [], legal_updates: [] }), false);
  assert.strictEqual(hasRealtimeData({ latest_trends: ['t'] }), true);
});

t('renderRealtimeDataSection: пусто → пустая строка', () => {
  assert.strictEqual(renderRealtimeDataSection(null), '');
  assert.strictEqual(renderRealtimeDataSection({}), '');
});

t('renderRealtimeDataSection: рендерит §2b со всеми блоками', () => {
  const rt = {
    realtime_facts: [{ fact: 'Ставка ЦБ', value: '18%', source: 'ЦБ РФ' }],
    expert_quotes: [{ quote: 'важно', author: 'Иван Петров', role: 'аналитик', source: 'РБК' }],
    latest_trends: ['рост спроса'],
    legal_updates: ['новый закон о рекламе'],
  };
  const md = renderRealtimeDataSection(rt);
  assert.ok(md.includes('§2b. REAL-TIME DATA'));
  assert.ok(md.includes('Ставка ЦБ — 18% (источник: ЦБ РФ)'));
  assert.ok(md.includes('«важно» — Иван Петров, аналитик [РБК]'));
  assert.ok(md.includes('рост спроса'));
  assert.ok(md.includes('новый закон о рекламе'));
});

t('renderRealtimeDataSection: строковые факты и кастомный heading', () => {
  const md = renderRealtimeDataSection({ realtime_facts: ['простой факт'] }, { heading: '## X' });
  assert.ok(md.startsWith('## X'));
  assert.ok(md.includes('простой факт'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
