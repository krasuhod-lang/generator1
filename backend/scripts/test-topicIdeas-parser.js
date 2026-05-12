'use strict';

/**
 * test-topicIdeas-parser.js — юнит-тесты для topicIdeasParser.js.
 *
 * Покрывает:
 *   • Извлечение TOPIC_IDEAS_JSON-блока по sentinel-комментариям;
 *   • Graceful возврат null на отсутствующий sentinel / битый JSON /
 *     пустые topics / битые типы / неизвестные enum'ы;
 *   • Корректное усечение длинных строк до LIM-лимитов;
 *   • Валидацию enum'ов primary_intent / expected_format / confidence;
 *   • Нормализацию topic_count_returned (наследование длины topics).
 *
 * Запуск:  node backend/scripts/test-topicIdeas-parser.js
 */

const assert = require('assert');
const path   = require('path');

const { extractTopicIdeasJsonBlock, _internals } =
  require(path.join(__dirname, '..', 'src', 'services', 'articleTopics', 'topicIdeasParser'));

let _cases = 0, _pass = 0;
function check(name, fn) {
  _cases += 1;
  try { fn(); _pass += 1; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); }
}

const VALID_TOPIC = {
  title: 'Как выбрать ВНЖ Португалии',
  h1_variant: 'Как выбрать программу ВНЖ Португалии в 2026 году: гид для IT-предпринимателей',
  slug_hint: 'kak-vybrat-vnzh-portugalii',
  primary_intent: 'informational',
  intent_facet: 'how-to',
  target_audience_segment: 'IT-предприниматели 30+',
  expected_format: 'guide',
  pain_or_question: 'Не понимаю, какая виза подходит при доходе от самозанятости',
  key_entities: ['D7', 'D8', 'Golden Visa'],
  lsi_seed: ['резидентство', 'NHR', 'налоги'],
  commercial_potential: 4,
  difficulty: 3,
  uniqueness_angle: 'Сравнение по доходу 4-6k€/мес самозанятости',
  why_now: 'D7 visa rule update 2025-Q4',
};

function buildValidJson(overrides = {}) {
  return JSON.stringify(Object.assign({
    market_overview: [
      { fact: 'Португалия выдала 12k D7 виз в 2024', source: 'SEF report 2024', confidence: 'high' },
    ],
    entities: {
      products: ['D7', 'D8'],
      companies: ['SEF', 'AIMA'],
      technologies: [],
      methodologies: [],
      problems: ['proof of income'],
      regulations: ['Lei 23/2007'],
    },
    intents: {
      informational: ['how-to', 'definition'],
      commercial:    ['comparison'],
      transactional: ['buying'],
      navigational:  [],
    },
    audience_profile: {
      segments: [{ name: 'IT-предприниматели 30+', description: 'Удалёнщики и фрилансеры' }],
      jtbd: ['когда я ищу резидентство, я хочу понять, что подходит'],
      pains: ['нет понимания налогов'],
      voice_of_customer: ['а NHR ещё работает?'],
    },
    brand_facts: [{ fact: 'Бренд Х помогает с D7', confidence: 'medium' }],
    topics: [VALID_TOPIC],
    coverage_map: {
      rows: ['IT-предприниматели 30+'],
      columns: ['how-to'],
      cells: [[[1]]],
    },
    topic_count_requested: 1,
    topic_count_returned:  1,
    serp_evidence_used:    false,
  }, overrides));
}

function wrap(jsonText) {
  return [
    '## 6. Темы статей\n\n### Тема 1. Foo\n- ...\n',
    '<!-- TOPIC_IDEAS_JSON_START -->',
    '```json',
    jsonText,
    '```',
    '<!-- TOPIC_IDEAS_JSON_END -->',
  ].join('\n');
}

console.log('▶ extractTopicIdeasJsonBlock — happy path');
check('Валидный полный JSON парсится', () => {
  const out = extractTopicIdeasJsonBlock(wrap(buildValidJson()));
  assert.ok(out, 'should not be null');
  assert.strictEqual(out.topics.length, 1);
  assert.strictEqual(out.topics[0].primary_intent, 'informational');
  assert.strictEqual(out.topics[0].expected_format, 'guide');
  assert.strictEqual(out.topic_count_requested, 1);
  assert.strictEqual(out.audience_profile.segments[0].name, 'IT-предприниматели 30+');
  assert.strictEqual(out.brand_facts[0].confidence, 'medium');
  assert.deepStrictEqual(out.coverage_map.cells, [[[1]]]);
});

check('serp_evidence_used = true прокидывается', () => {
  const out = extractTopicIdeasJsonBlock(wrap(buildValidJson({ serp_evidence_used: true })));
  assert.strictEqual(out.serp_evidence_used, true);
});

console.log('▶ Graceful degradation');
check('Нет sentinel-блока → null', () => {
  assert.strictEqual(extractTopicIdeasJsonBlock('## просто markdown без json'), null);
});

check('Битый JSON → null', () => {
  assert.strictEqual(extractTopicIdeasJsonBlock(wrap('{ "topics": [ broken')), null);
});

check('Пустой topics → null (полный провал контракта)', () => {
  assert.strictEqual(extractTopicIdeasJsonBlock(wrap(buildValidJson({ topics: [] }))), null);
});

check('Topics с пустым title отсеиваются (если все — null)', () => {
  const json = buildValidJson({ topics: [{ title: '' }] });
  assert.strictEqual(extractTopicIdeasJsonBlock(wrap(json)), null);
});

check('Пустая строка markdown → null', () => {
  assert.strictEqual(extractTopicIdeasJsonBlock(''), null);
});

check('null/undefined аргумент → null', () => {
  assert.strictEqual(extractTopicIdeasJsonBlock(null), null);
  assert.strictEqual(extractTopicIdeasJsonBlock(undefined), null);
});

console.log('▶ Усечение и enum-валидация');
check('Длинная строка title режется до LIM.shortStr', () => {
  const longTitle = 'a'.repeat(_internals.LIM.shortStr + 200);
  const out = extractTopicIdeasJsonBlock(wrap(buildValidJson({
    topics: [Object.assign({}, VALID_TOPIC, { title: longTitle })],
  })));
  assert.strictEqual(out.topics[0].title.length, _internals.LIM.shortStr);
});

check('Невалидный primary_intent → null (но тема не отбрасывается)', () => {
  const out = extractTopicIdeasJsonBlock(wrap(buildValidJson({
    topics: [Object.assign({}, VALID_TOPIC, { primary_intent: 'мусорное_значение' })],
  })));
  assert.strictEqual(out.topics[0].primary_intent, null);
  assert.strictEqual(out.topics[0].title, VALID_TOPIC.title);
});

check('Невалидный expected_format → null', () => {
  const out = extractTopicIdeasJsonBlock(wrap(buildValidJson({
    topics: [Object.assign({}, VALID_TOPIC, { expected_format: 'unknown' })],
  })));
  assert.strictEqual(out.topics[0].expected_format, null);
});

check('Невалидный confidence → low (default)', () => {
  const out = extractTopicIdeasJsonBlock(wrap(buildValidJson({
    brand_facts: [{ fact: 'x', confidence: 'unknown_value' }],
  })));
  assert.strictEqual(out.brand_facts[0].confidence, 'low');
});

check('commercial_potential вне 1..5 → null', () => {
  const out = extractTopicIdeasJsonBlock(wrap(buildValidJson({
    topics: [Object.assign({}, VALID_TOPIC, { commercial_potential: 99, difficulty: -1 })],
  })));
  assert.strictEqual(out.topics[0].commercial_potential, null);
  assert.strictEqual(out.topics[0].difficulty, null);
});

check('topic_count_returned наследуется из длины topics, если не задан', () => {
  const json = JSON.parse(buildValidJson());
  delete json.topic_count_returned;
  const out = extractTopicIdeasJsonBlock(wrap(JSON.stringify(json)));
  assert.strictEqual(out.topic_count_returned, 1);
});

check('Массивы capped по длине (LIM.arrayCap)', () => {
  const huge = new Array(50).fill('product-xyz');
  const out = extractTopicIdeasJsonBlock(wrap(buildValidJson({
    entities: { products: huge, companies: [], technologies: [],
                methodologies: [], problems: [], regulations: [] },
  })));
  assert.strictEqual(out.entities.products.length, _internals.LIM.arrayCap);
});

check('coverage_map.cells: невалидные числа отфильтровываются', () => {
  const out = extractTopicIdeasJsonBlock(wrap(buildValidJson({
    coverage_map: {
      rows: ['seg1'], columns: ['col1'],
      cells: [[[1, 2, 'not-a-number', 9999, -5, 1]]], // дубль 1, мусор, вне 1..999
    },
  })));
  assert.deepStrictEqual(out.coverage_map.cells, [[[1, 2]]]);
});

check('Скобки JSON без ```json``` обёртки тоже работают (best-effort)', () => {
  const md = [
    '<!-- TOPIC_IDEAS_JSON_START -->',
    buildValidJson(),
    '<!-- TOPIC_IDEAS_JSON_END -->',
  ].join('\n');
  const out = extractTopicIdeasJsonBlock(md);
  assert.ok(out);
  assert.strictEqual(out.topics.length, 1);
});

console.log(`\n${_pass}/${_cases} passed`);
process.exit(_pass === _cases ? 0 : 1);
