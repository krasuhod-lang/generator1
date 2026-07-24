'use strict';

/* Smoke-тест topicIdeasResearch: normalizeTopicResearch + hasTopicResearch +
 * renderTopicResearchBlock (real-time ресёрч интентов для подбора тем). */

const assert = require('assert');
const {
  normalizeTopicResearch,
  hasTopicResearch,
  renderTopicResearchBlock,
} = require('../src/services/articleTopics/topicIdeasResearch');

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log('✓', name); passed++; }
  catch (e) { console.error('✗', name, '\n  ', e.message); failed++; }
}

t('normalizeTopicResearch: маппит контракт perplexityTopicResearcher', () => {
  const out = normalizeTopicResearch({
    user_intents: [{ query: 'как выбрать ВНЖ', intent: 'informational', facet: 'how-to', stage: 'TOFU' }],
    adjacent_topics: [{ topic: 'налоги для релокантов', why: 'ищут следом', semantic_cluster: 'релокация' }],
    paa_questions: ['сколько стоит ВНЖ?'],
    ai_overview_questions: ['что даёт ВНЖ?'],
    semantic_entities: ['ВНЖ', 'ПМЖ'],
    current_stats: [{ fact: 'заявок', value: '+30%' }],
    latest_trends: ['рост релокации'],
  });
  assert.strictEqual(out.user_intents.length, 1);
  assert.strictEqual(out.adjacent_topics.length, 1);
  assert.deepStrictEqual(out.paa_questions, ['сколько стоит ВНЖ?']);
  assert.deepStrictEqual(out.ai_overview_questions, ['что даёт ВНЖ?']);
  assert.deepStrictEqual(out.semantic_entities, ['ВНЖ', 'ПМЖ']);
});

t('normalizeTopicResearch: null / не-объект → null', () => {
  assert.strictEqual(normalizeTopicResearch(null), null);
  assert.strictEqual(normalizeTopicResearch('str'), null);
});

t('normalizeTopicResearch: отсутствующие поля → пустые массивы', () => {
  const out = normalizeTopicResearch({});
  assert.deepStrictEqual(out, {
    user_intents: [], adjacent_topics: [], paa_questions: [],
    ai_overview_questions: [], semantic_entities: [], current_stats: [], latest_trends: [],
  });
});

t('hasTopicResearch: true только при непустых данных', () => {
  assert.strictEqual(hasTopicResearch(null), false);
  assert.strictEqual(hasTopicResearch({}), false);
  assert.strictEqual(hasTopicResearch(normalizeTopicResearch({})), false);
  assert.strictEqual(hasTopicResearch({ paa_questions: ['q'] }), true);
});

t('renderTopicResearchBlock: пусто → fallback-строка', () => {
  const md = renderTopicResearchBlock(null);
  assert.ok(md.includes('real-time ресёрч недоступен'));
  assert.strictEqual(renderTopicResearchBlock({}, { fallback: 'X' }), 'X');
});

t('renderTopicResearchBlock: рендерит все секции', () => {
  const r = normalizeTopicResearch({
    user_intents: [{ query: 'как выбрать ВНЖ', intent: 'informational', facet: 'how-to', stage: 'TOFU' }],
    adjacent_topics: [{ topic: 'налоги для релокантов', why: 'ищут следом', semantic_cluster: 'релокация' }],
    paa_questions: ['сколько стоит ВНЖ?'],
    ai_overview_questions: ['что даёт ВНЖ?'],
    semantic_entities: ['ВНЖ', 'ПМЖ'],
    current_stats: [{ fact: 'заявок', value: '+30%', source: 'МВД' }],
    latest_trends: ['рост релокации'],
  });
  const md = renderTopicResearchBlock(r);
  assert.ok(md.includes('REAL-TIME РЕСЁРЧ ИНТЕНТОВ'));
  assert.ok(md.includes('«как выбрать ВНЖ» — informational / how-to / TOFU'));
  assert.ok(md.includes('налоги для релокантов'));
  assert.ok(md.includes('сколько стоит ВНЖ?'));
  assert.ok(md.includes('AI Overviews'));
  assert.ok(md.includes('что даёт ВНЖ?'));
  assert.ok(md.includes('ВНЖ, ПМЖ'));
  assert.ok(md.includes('заявок — +30% (источник: МВД)'));
  assert.ok(md.includes('рост релокации'));
});

t('renderTopicResearchBlock: строковые интенты/темы тоже поддержаны', () => {
  const md = renderTopicResearchBlock({ user_intents: ['простой запрос'], adjacent_topics: ['смежная тема'] });
  assert.ok(md.includes('простой запрос'));
  assert.ok(md.includes('смежная тема'));
});

(async () => {
  // Дожидаемся async-теста fail-open.
  const { runTopicIdeasResearch } = require('../src/services/articleTopics/topicIdeasResearch');
  const saved = process.env.PERPLEXITY_API_KEY;
  delete process.env.PERPLEXITY_API_KEY;
  try {
    assert.strictEqual(await runTopicIdeasResearch({ niche: 'ВНЖ' }), null);
    console.log('✓ runTopicIdeasResearch: async fail-open verified'); passed++;
  } catch (e) { console.error('✗ async fail-open', e.message); failed++; }
  finally { if (saved !== undefined) process.env.PERPLEXITY_API_KEY = saved; }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
