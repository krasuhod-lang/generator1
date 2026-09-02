#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  buildContentHandoffManifest,
  buildBlockHandoffPrompt,
  renderManifestMarkdown,
} = require('../src/utils/contentHandoffManifest');

const task = {
  id: 'task-1',
  input_target_service: 'Диагностика отопительного оборудования',
  input_region: 'Москва',
  input_raw_lsi: 'теплообменник\nсервисный центр\nпроверка давления',
  input_ngrams: 'диагностика котла,проверка давления',
  input_genre: 'практическая экспертная инструкция',
  input_tone: 'дружески-экспертный',
  input_complexity: 'средняя',
  input_professional_level: 'практик отрасли',
  input_target_audience: 'Владельцы частных домов и управляющие объектами',
  current_law_required: true,
  tz_json: JSON.stringify({
    h1_required: 'Диагностика отопительного оборудования в Москве',
    h2_required: ['Когда нужна диагностика', 'Стоимость работ'],
    lsi_required: ['теплообменник'],
    lsi_forbidden: ['гарантированный результат'],
    min_words: 700,
  }),
};

const stage0Result = {
  core_entities: [{ entity: 'датчик давления', type: 'component', source: 'serp.example' }],
  realtime_facts: [
    { fact: 'Производитель рекомендует ежегодное техническое обслуживание.', source: 'manufacturer.example' },
  ],
  competitor_facts: [
    { fact: 'Конкуренты раскрывают состав диагностики.', source: 'serp.example' },
  ],
  latest_trends: [{ trend: 'Переход на профилактическое обслуживание', source_url: 'research.example', published_at: '2026-01-01' }],
  legal_updates: [{ topic: 'Регламент обслуживания', change: 'Требования зависят от производителя', source_url: 'regulator.example' }],
  research_sources: [{ url: 'https://research.example/report', title: 'Research report', source_type: 'research' }],
  information_delta: [{ claim: 'В конкурентных материалах не раскрыта проверка давления', source: 'gist.example' }],
  gist_top10_claims: [{ claim: 'Проверка давления выделена как отдельный вопрос', source: 'gist.example' }],
  claims_to_prove: [{ claim: 'Работы выполняются по регламенту', source: 'brand.example' }],
  search_intents: [{ intent: 'сравнить состав диагностики', stage: 'consideration' }],
};

const stage1Result = {
  entities: [{ label: 'теплообменник', type: 'component', salience: 0.9 }],
  commercial_intents: [{ intent: 'заказать диагностику', query_example: 'диагностика котла Москва' }],
  lsi_clusters: [{ cluster_name: 'diagnostics', keywords: ['сервисный центр', 'проверка давления', 'продувка теплообменника'] }],
  knowledge_graph: { nodes: [{ id: 'e1', label: 'теплообменник', type: 'component' }], edges: [] },
};

const stage2Result = {
  taxonomy: [
    {
      h2: 'Когда нужна диагностика',
      type: 'process',
      primary_intent: 'понять признаки неисправности',
      lsi_must: ['теплообменник'],
      ngrams_must: ['диагностика котла'],
      entities: ['теплообменник'],
    },
    { h2: 'Стоимость работ', type: 'pricing', lsi_must: ['сервисный центр'] },
  ],
  stage2Raw: {
    search_intents: [{ intent: 'заказать услугу' }],
    buyer_journey: { stages: [{ stage: 'decision', signal: 'готов заказать', query_example: 'диагностика котла Москва' }] },
    lsi: { important: ['манометр', 'проверка герметичности'] },
    ngrams: ['обслуживание котла в Москве'],
  },
};

const relevanceReport = {
  entity_coverage: { mandatory_entities: [{ label: 'сервисный центр', type: 'service' }] },
};

const manifest = buildContentHandoffManifest({
  task,
  stage0Result,
  stage1Result,
  stage2Result,
  relevanceReport,
  targetPageAnalysis: { facts: [{ fact: 'Услуга доступна в Москве', source: 'site.example' }] },
  strategyContext: { demand_map: { demand_by_journey: [{ stage: 'consideration' }] } },
});

assert.strictEqual(manifest.schema_version, 'content-handoff-v1');
assert.strictEqual(manifest.validation.status, 'ready');
assert.ok(manifest.validation.counts.facts >= 5, 'facts/trends/legal evidence must survive normalization');
assert.ok(manifest.validation.counts.claims >= 2, 'GIST/information delta claims must survive normalization');
assert.ok(manifest.sources.some((item) => item.source.includes('research.example')), 'research sources must survive normalization');
assert.ok(manifest.validation.counts.entities >= 2, 'entities from stage1 and relevance must survive');
assert.ok(manifest.semantic.lsi_required.includes('теплообменник'));
assert.ok(manifest.semantic.lsi_required.includes('сервисный центр'));
assert.ok(manifest.semantic.lsi_required.includes('продувка теплообменника'), 'object-shaped LSI clusters must be flattened');
assert.ok(manifest.semantic.lsi_required.includes('манометр'), 'nested Stage 2 LSI must survive');
assert.ok(manifest.semantic.ngrams_required.includes('обслуживание котла в Москве'), 'nested Stage 2 n-grams must survive');
assert.ok(manifest.semantic.ngrams_required.includes('диагностика котла'));
assert.strictEqual(manifest.blocks.length, 2);
assert.ok(manifest.blocks[0].lsi_must.includes('теплообменник'));
assert.strictEqual(manifest.requirements.writing_profile.genre, 'практическая экспертная инструкция');
assert.strictEqual(manifest.requirements.writing_profile.tone, 'дружески-экспертный');
assert.ok(manifest.requirements.writing_profile.audience.includes('Владельцы частных домов'));
assert.strictEqual(manifest.requirements.freshness.required, true);
assert.strictEqual(manifest.requirements.freshness.jurisdiction, 'Москва');

const blockPrompt = buildBlockHandoffPrompt(manifest, { index: 0, h2: 'Когда нужна диагностика' });
assert.match(blockPrompt, /CONTENT HANDOFF MANIFEST/);
assert.match(blockPrompt, /теплообменник/);
assert.match(blockPrompt, /never invent/i);
assert.match(blockPrompt, /freshness/);
assert.match(blockPrompt, /практическая экспертная инструкция/);

const markdown = renderManifestMarkdown(manifest);
assert.match(markdown, /facts=/);
assert.match(markdown, /Проверенные факты/);
assert.match(markdown, /Block map/);

const unavailable = buildContentHandoffManifest({ task: { input_target_service: 'Тема' } });
assert.strictEqual(unavailable.validation.status, 'partial');
assert.ok(unavailable.validation.warnings.includes('no_verified_facts'));
assert.strictEqual(unavailable.requirements.freshness.required, false);
assert.deepStrictEqual(unavailable.facts, []);

console.log('content handoff manifest contract: OK');
