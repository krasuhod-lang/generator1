#!/usr/bin/env node
'use strict';

/**
 * Smoke-тест для backend/src/utils/moduleContext.js
 *
 * Запуск:  node backend/scripts/test-module-context.js
 *
 * Не требует новых dev-dependencies (тестовой инфраструктуры в репо нет).
 * Использует только встроенные node:assert и process.exit.
 */

const assert = require('node:assert/strict');
const {
  deriveModuleContext,
  formatModuleContextForAKB,
} = require('../src/utils/moduleContext');

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    fail++;
  }
}

console.log('moduleContext smoke tests\n');

// ── 1. Полный сценарий ──────────────────────────────────────────────
const fullInput = {
  task: {
    input_target_service: 'ремонт квартир под ключ',
    input_brand_name:     'СтройМастер',
    input_region:         'Москва',
    input_brand_facts:    'Работаем с 2010 года. Гарантия 5 лет. Сделали 1200 квартир.',
    input_business_type:  'строительные услуги',
    input_project_limits: 'не упоминать конкурентов; соблюдать СНиП и ГОСТ',
  },
  stage0Result: {
    competitor_facts: [
      { fact: 'Конкурент А ремонтирует за 45 дней', source_url: 'https://x.test', category: 'speed' },
      { fact: 'Средняя цена 12000 руб/м²', source_url: 'https://y.test', category: 'price' },
      { fact: 'Без чисел вообще', source_url: 'https://z.test', category: 'noise' }, // должен быть отфильтрован
    ],
    core_entities: [
      { entity: 'СНиП', type: 'standard', trust_signal: true },
      { entity: 'дизайн-проект', type: 'service' },
    ],
    audience_pains: [
      { pain: 'боюсь, что подрядчик исчезнет с предоплатой', priority: 'high', solution_signal: 'договор + поэтапная оплата' },
    ],
    trust_triggers: [
      { trigger: 'фиксированная смета', type: 'guarantee', strength: 'strong' },
      { trigger: '5 лет гарантии', type: 'guarantee', strength: 'strong' },
    ],
    faq_bank: [
      { question: 'Сколько стоит ремонт двушки?', answer: 'От 800 тыс.' },
    ],
  },
  stage1Result: {
    knowledge_graph: {
      nodes: [
        { id: 'kv', label: 'квартира',     type: 'object',  salience: 0.95 },
        { id: 'rm', label: 'ремонт',       type: 'service', salience: 0.9  },
        { id: 'dp', label: 'дизайн-проект', type: 'service', salience: 0.7  },
        { id: 'lo', label: 'низкая релевантность', type: 'misc', salience: 0.2 }, // должен отсеяться
      ],
      edges: [],
    },
    entity_graph: [{ entity: 'смета', type: 'document', weight: 0.6 }],
    terminology_map: {
      'дизайн-проект': 'комплект чертежей и спецификаций',
      'опт': 'или', // ambiguous (definition содержит «или» + короткое)
      'квм':  'м²',  // короткое определение
    },
    language_map: {
      'санитарно-технические работы': 'сантехника',
      'отделочные работы':           'отделка',
    },
    lsi_clusters: [
      { cluster_name: 'материалы', keywords: ['ламинат','плитка','обои'], intent: 'informational' },
    ],
    user_questions: [
      { question: 'Можно ли жить во время ремонта?', answer_hint: 'Зависит от этапа', priority: 'high' },
    ],
    pain_points: [
      { pain: 'смета вырастает по ходу работ', solution_angle: 'фиксированная смета' },
    ],
  },
  stage2Result: {
    enrichedStage1: {
      content_formats: {
        recommended_formats:    [{ format: 'how-to-guide' }, { format: 'price-table' }],
        format_priority_order:  ['how-to-guide', 'comparison'],
        ai_search_opportunities: ['featured snippet: сколько стоит ремонт'],
      },
    },
  },
  targetPageAnalysis: { detected_business_type: 'строительные услуги' },
};

test('returns object with all 7 module keys', () => {
  const ctx = deriveModuleContext(fullInput);
  assert.equal(typeof ctx, 'object');
  assert.equal(ctx.schema_version, 1);
  for (const key of [
    'mandatory_entities', 'avoid_ambiguous_terms', 'audience_language_clusters',
    'format_wedge', 'trust_complexity', 'claims_to_prove', 'jtbd_to_close',
  ]) {
    assert.ok(key in ctx, `missing key: ${key}`);
  }
});

test('mandatory_entities: filters low-salience and dedupes', () => {
  const ctx = deriveModuleContext(fullInput);
  const labels = ctx.mandatory_entities.map(e => e.entity);
  assert.ok(labels.includes('квартира'));
  assert.ok(labels.includes('ремонт'));
  assert.ok(labels.includes('СНиП'));
  assert.ok(!labels.includes('низкая релевантность'), 'salience<0.4 must be filtered');
  // дубликат «дизайн-проект» (KG + entity_graph не имеют — но проверим уникальность иначе)
  const set = new Set(labels.map(s => s.toLowerCase()));
  assert.equal(set.size, labels.length, 'entities must be unique');
});

test('avoid_ambiguous_terms: includes generic + ambiguous from terminology_map', () => {
  const ctx = deriveModuleContext(fullInput);
  const terms = ctx.avoid_ambiguous_terms.map(t => t.term.toLowerCase());
  assert.ok(terms.includes('качество'),  'generic seed list missing');
  assert.ok(terms.includes('опт'),       'ambiguous (contains «или») not detected');
  assert.ok(terms.includes('квм'),       'short-definition not detected');
});

test('audience_language_clusters: combines language_map + lsi_clusters', () => {
  const ctx = deriveModuleContext(fullInput);
  const formal = ctx.audience_language_clusters.find(c => c.formal === 'отделочные работы');
  assert.ok(formal, 'language_map entry missing');
  assert.equal(formal.colloquial, 'отделка');
  const cluster = ctx.audience_language_clusters.find(c => c.cluster === 'материалы');
  assert.ok(cluster, 'lsi cluster missing');
  assert.deepEqual(cluster.keywords.slice(0, 3), ['ламинат', 'плитка', 'обои']);
});

test('format_wedge: picks priority_order[0] as primary', () => {
  const ctx = deriveModuleContext(fullInput);
  assert.equal(ctx.format_wedge.primary, 'how-to-guide');
  assert.deepEqual(ctx.format_wedge.priority_order, ['how-to-guide', 'comparison']);
});

test('trust_complexity: regulatory project_limits bumps level', () => {
  const ctx = deriveModuleContext(fullInput);
  // 2 trust_triggers (<5 → starts low) + project_limits с «гарант», «снип» → bump до medium
  // и niche «строительные услуги» (НЕ YMYL) → остаётся medium
  assert.ok(['medium', 'high'].includes(ctx.trust_complexity.level));
  assert.ok(ctx.trust_complexity.reasons.length > 0);
});

test('trust_complexity: YMYL niche → high', () => {
  const ymyl = deriveModuleContext({
    ...fullInput,
    task: { ...fullInput.task, input_target_service: 'стоматологическая клиника' },
  });
  assert.equal(ymyl.trust_complexity.level, 'high');
});

test('claims_to_prove: only numeric competitor_facts + brand_facts with digits', () => {
  const ctx = deriveModuleContext(fullInput);
  const claims = ctx.claims_to_prove.map(c => c.claim);
  assert.ok(claims.some(c => c.includes('45 дней')));
  assert.ok(claims.some(c => c.includes('12000')));
  assert.ok(!claims.some(c => c === 'Без чисел вообще'),
    'non-numeric competitor fact must be filtered');
  assert.ok(claims.some(c => /Гарантия 5 лет|1200 квартир/.test(c)),
    'brand_facts with digits should be extracted');
});

test('jtbd_to_close: combines stage1 user_questions + pain_points + stage0 pains + faq', () => {
  const ctx = deriveModuleContext(fullInput);
  const jtbds = ctx.jtbd_to_close.map(j => j.jtbd);
  assert.ok(jtbds.includes('Можно ли жить во время ремонта?'));
  assert.ok(jtbds.includes('смета вырастает по ходу работ'));
  assert.ok(jtbds.some(j => j.includes('подрядчик исчезнет')));
  assert.ok(jtbds.includes('Сколько стоит ремонт двушки?'));
  // dedupe — не должно быть одинаковых строк
  const set = new Set(jtbds);
  assert.equal(set.size, jtbds.length);
});

test('graceful: empty input returns valid empty contract', () => {
  const ctx = deriveModuleContext({});
  assert.equal(ctx.mandatory_entities.length, 0);
  assert.equal(ctx.avoid_ambiguous_terms.length > 0, true,
    'avoid_ambiguous_terms always has generic seed');
  assert.equal(ctx.audience_language_clusters.length, 0);
  assert.equal(ctx.claims_to_prove.length, 0);
  assert.equal(ctx.jtbd_to_close.length, 0);
  assert.equal(typeof ctx.trust_complexity.level, 'string');
  assert.ok(ctx.format_wedge.primary, 'fallback format wedge must be set');
});

test('formatModuleContextForAKB: produces non-empty markdown under 4 KB', () => {
  const ctx = deriveModuleContext(fullInput);
  const md = formatModuleContextForAKB(ctx);
  assert.ok(typeof md === 'string' && md.length > 0);
  assert.ok(md.length < 4096, `AKB section too large: ${md.length} bytes`);
  assert.ok(/Обязательные сущности/.test(md));
  assert.ok(/Format wedge/i.test(md));
});

test('formatModuleContextForAKB: handles null gracefully', () => {
  assert.equal(typeof formatModuleContextForAKB(null), 'string');
  assert.equal(typeof formatModuleContextForAKB(undefined), 'string');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
