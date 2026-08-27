'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const parserPath = path.join(__dirname, '..', 'src', 'services', 'articleTopics', 'topicIdeasParser');
const scoringPath = path.join(__dirname, '..', 'src', 'services', 'articleTopics', 'topicDemandScoring');
const { extractTopicIdeasJsonBlock } = require(parserPath);
const { scoreTopicIdeas } = require(scoringPath);

let cases = 0;
let passed = 0;
function check(name, fn) {
  cases += 1;
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

function wrap(payload) {
  return [
    '<!-- TOPIC_IDEAS_JSON_START -->',
    '```json',
    JSON.stringify(payload),
    '```',
    '<!-- TOPIC_IDEAS_JSON_END -->',
  ].join('\n');
}

const baseTopic = {
  title: 'Как выбрать CRM для отдела продаж',
  h1_variant: 'Как выбрать CRM для отдела продаж: сравнение функций и стоимости',
  primary_intent: 'commercial',
  intent_facet: 'comparison',
  expected_format: 'comparison',
  target_audience_segment: 'Руководители продаж',
  commercial_potential: 4,
  difficulty: 3,
  uniqueness_angle: 'Матрица стоимость переключения × зрелость процесса',
  why_now: 'В GSC есть запросы в зоне striking distance',
  geo_potential: 'high',
  ai_answer_trigger: 'Какую CRM выбрать отделу продаж из 10 человек?',
  intent_decision_stage: 'MOFU',
  expected_search_volume: 'high',
  demand_signal_type: 'modeled',
  demand_confidence: 'high',
  forecast_horizon_months: 18,
  traffic_route: 'conversion',
  demand_evidence: ['Search Console, 2026-08'],
  first_party_evidence: 'Собственный тест пяти CRM на отделе из 10 менеджеров',
  evidence_gap: '',
  first_party_evidence_required: false,
  originality_gate: 'pass',
};

const basePayload = {
  topics: [baseTopic],
  audience_profile: { segments: [] },
  brand_facts: [],
  coverage_map: { rows: [], columns: [], cells: [] },
};

check('enum expected_search_volume сохраняется как level', () => {
  const out = extractTopicIdeasJsonBlock(wrap(basePayload));
  assert.ok(out);
  assert.strictEqual(out.topics[0].expected_search_volume, 'high');
  assert.strictEqual(out.topics[0].expected_search_volume_level, 'high');
});

check('старое numeric expected_search_volume не ломается', () => {
  const out = extractTopicIdeasJsonBlock(wrap({
    ...basePayload,
    topics: [{ ...baseTopic, expected_search_volume: 1250 }],
  }));
  assert.strictEqual(out.topics[0].expected_search_volume, 1250);
  assert.strictEqual(out.topics[0].expected_search_volume_level, null);
});

check('high demand confidence понижается для model-only сигнала', () => {
  const out = scoreTopicIdeas([baseTopic], {}).topics[0];
  assert.strictEqual(out.demand_signal_type, 'modeled');
  assert.notStrictEqual(out.demand_confidence, 'high');
});

check('GSC striking-distance signal помечается observed', () => {
  const out = scoreTopicIdeas([baseTopic], {
    signals: { striking_distance: [{ query: 'выбрать CRM для отдела продаж', position: 8 }] },
  }).topics[0];
  assert.strictEqual(out.demand_signal_type, 'observed');
  assert.ok(out.demand_evidence.length >= 1);
  assert.strictEqual(out.demand_evidence[0].evidence_type, 'first_party');
  assert.ok(out.traffic_potential_score > 0);
});

check('structured external evidence не превращается в [object Object]', () => {
  const out = scoreTopicIdeas([{
    ...baseTopic,
    demand_signal_type: 'editorial',
    demand_confidence: 'high',
    demand_evidence: [{ claim: 'AI Mode update', source_url: 'https://example.com', published_at: '2026-08-01', evidence_type: 'editorial' }],
  }], {}).topics[0];
  assert.strictEqual(out.demand_evidence[0].claim, 'AI Mode update');
  assert.strictEqual(out.demand_evidence[0].source_url, 'https://example.com');
  assert.strictEqual(out.demand_confidence, 'medium');
});

check('originality gate требует first-party evidence', () => {
  const out = scoreTopicIdeas([{
    ...baseTopic,
    uniqueness_angle: '',
    content_angle: '',
    first_party_evidence: '',
    originality_gate: null,
  }], {}).topics[0];
  assert.strictEqual(out.originality_gate, 'needs_first_party_evidence');
  assert.strictEqual(out.first_party_evidence_required, true);
  assert.ok(out.evidence_gap);
});

check('traffic route не становится conversion только из-за CTA', () => {
  const out = scoreTopicIdeas([{
    ...baseTopic,
    primary_intent: 'informational',
    intent_facet: 'how-to',
    traffic_route: null,
    cta_suggestion: 'Скачать чек-лист',
  }], {}).topics[0];
  assert.notStrictEqual(out.traffic_route, 'conversion');
  assert.strictEqual(out.traffic_route, 'mixed');
});

check('project history queries содержат все content sources', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'articleTopics', 'projectContentHistory.js'), 'utf8');
  for (const table of ['info_article_tasks', 'link_article_tasks', 'meta_tag_tasks', 'article_topic_tasks', 'tasks_auto_log']) {
    assert.ok(source.includes(table), `missing ${table}`);
  }
});

check('project context accepts current done analysis status', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'projects', 'contextResolver.js'), 'utf8');
  assert.ok(source.includes("status::text = ANY(ARRAY['done', 'completed'])"));
  assert.ok(source.includes('loadProjectContentHistory'));
});

check('pipeline stores post-exclusion count and filter summary', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'articleTopics', 'articleTopicsPipeline.js'), 'utf8');
  assert.ok(source.includes('topic_count_after_exclusions'));
  assert.ok(source.includes('semantic_cannibalization_dropped'));
});

console.log(`\n${passed}/${cases} passed`);
process.exit(passed === cases ? 0 : 1);
