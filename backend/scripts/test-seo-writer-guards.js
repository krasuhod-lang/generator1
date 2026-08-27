'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const { buildWriterContext } = require('../src/utils/writerContext');
const { DOCTOR_MAX_WRITER_CONTRACT } = require('../src/utils/doctorMaxWriterContract');
const {
  buildAuditedContentBrief,
  analyzeDraftSignals,
} = require('../src/utils/contentIntelligenceBrief');
const { buildInfoArticleKnowledgeBase } = require('../src/services/infoArticle/infoArticleKnowledgeBase');
const { buildLinkArticleKnowledgeBase } = require('../src/services/linkArticle/linkArticleKnowledgeBase');

function check(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

const oversized = {
  primary_intent: 'informational',
  entities: Array.from({ length: 120 }, (_, i) => ({ name: `entity-${i}`, description: 'x'.repeat(900) })),
  lsi_clusters: Array.from({ length: 90 }, (_, i) => ({ cluster: i, terms: Array.from({ length: 30 }, (_, j) => `term-${i}-${j}`) })),
  knowledge_graph: {
    nodes: Array.from({ length: 120 }, (_, i) => ({ id: `n${i}`, label: `Node ${i}` })),
    edges: Array.from({ length: 260 }, (_, i) => ({ source: `n${i % 120}`, target: `n${(i + 1) % 120}`, relation: 'related' })),
  },
  competitor_gaps: ['gap A', 'gap B'],
};
const taxonomy = Array.from({ length: 40 }, (_, i) => ({
  h2: `Section ${i}`,
  type: i === 0 ? 'offer' : 'generic',
  primary_intent: 'answer',
  lsi_must: [`lsi-${i}`, `lsi-${i}-second`],
  ngrams_must: [`ngram-${i}`],
  entities: [`entity-${i}`],
}));

const context = buildWriterContext(oversized, {
  page_blueprint: {
    h1: 'Test page',
    taxonomy,
    section_order: taxonomy.map((x) => x.h2),
    raw: 'z'.repeat(100000),
  },
  routing_audit: { total_lsi_received: 80, total_lsi_routed: 80 },
  taxonomy,
}, taxonomy);

check('writer context returns valid JSON', () => {
  assert.doesNotThrow(() => JSON.parse(context.stage1Json));
  assert.doesNotThrow(() => JSON.parse(context.stage2Json));
});
check('writer context stays bounded', () => {
  assert(context.stage1Json.length <= 9000, `stage1 ${context.stage1Json.length}`);
  assert(context.stage2Json.length <= 9000, `stage2 ${context.stage2Json.length}`);
  assert(context.totalChars <= 18000);
});
check('writer context keeps high-value intent and final routed section', () => {
  const s1 = JSON.parse(context.stage1Json);
  const s2 = JSON.parse(context.stage2Json);
  assert.strictEqual(s1.primary_intent, 'informational');
  assert(Array.isArray(s1.entities));
  assert(Array.isArray(s2.taxonomy));
  assert.strictEqual(s2.taxonomy[0].h2, 'Section 0');
  assert(s2.taxonomy[0].lsi_must.includes('lsi-0'));
});
check('Doctor Max contract is additive and evidence-safe', () => {
  assert(DOCTOR_MAX_WRITER_CONTRACT.includes('ARTICLE KNOWLEDGE BASE'));
  assert(DOCTOR_MAX_WRITER_CONTRACT.includes('LSI'));
  assert(DOCTOR_MAX_WRITER_CONTRACT.includes('не добавляй число'));
  assert(DOCTOR_MAX_WRITER_CONTRACT.toLowerCase().includes('не создавай искусственные'));
});

const infoBrief = buildAuditedContentBrief({
  branch: 'info',
  task: { topic: 'Проверка темы', region: 'ru', brand_facts: 'Подтверждённый факт' },
  strategy: { article_type_hint: 'how-to', demand_signals: ['signal one'] },
  intents: { entities: [{ entity: 'Entity A' }], semantic_anchors: ['как выбрать'], user_questions: [{ question: 'Что проверить?' }] },
  whitespace: { information_delta: ['ограничение и исключение'], article_hierarchy_hints: { must_cover_subtopics: ['критерии выбора'], preferred_formats: ['table'] } },
  outline: { sections: [{ h2: 'Критерии выбора' }] },
  lsi: { important: ['term one'], banned: ['term banned'] },
  audienceResearch: { pains: ['не хватает доказательств'], questions: ['как сравнить'] },
});
const linkBrief = buildAuditedContentBrief({
  branch: 'link',
  task: { topic: 'Ссылочная тема', region: 'ru' },
  intents: { entities: [{ entity: 'Entity B' }] },
  whitespace: { article_hierarchy_hints: { must_cover_subtopics: ['сравнение'] } },
  structure: { sections: [{ h2: 'Сравнение' }] },
  gistDelta: { information_delta: ['доказательный пробел'] },
  competitiveBrief: { competitive_failures: ['нет критериев'], purchase_arguments: ['проверенный аргумент'] },
});
check('audited handoff is bounded and branch-aware', () => {
  assert(infoBrief.length <= 8200);
  assert(linkBrief.length <= 8200);
  assert(infoBrief.includes('блоговая статья'));
  assert(linkBrief.includes('Одна анкорная ссылка'));
  assert(infoBrief.includes('term one'));
  assert(linkBrief.includes('проверенный аргумент'));
});
check('draft signals detect repetition without claiming authorship', () => {
  const paragraph = 'Это конкретный абзац с полезным объяснением критериев выбора и ограничений для читателя, который должен принять решение.';
  const signals = analyzeDraftSignals(`<p>${paragraph}</p><p>${paragraph}</p><p>В современном мире это вводный текст.</p><p>В современном мире это ещё один вводный текст.</p>`, 'критерии выбора');
  assert.strictEqual(signals.duplicate_paragraphs, 1);
  assert.strictEqual(signals.banned_intros.length, 1);
  assert.strictEqual(signals.banned_intros[0].count, 2);
  assert(!Object.prototype.hasOwnProperty.call(signals, 'ai_probability'));
});
check('IAKB and LAKB accept the audited handoff as one section', () => {
  const task = { topic: 'Тест', brand_facts: 'Факт', anchor_text: 'перейти', anchor_url: 'https://example.com' };
  const iakb = buildInfoArticleKnowledgeBase({ task, auditedContentBrief: infoBrief });
  const lakb = buildLinkArticleKnowledgeBase({ task, auditedContentBrief: linkBrief });
  assert(iakb.includes('§0.9 Audited content logic handoff'));
  assert(lakb.includes('§0.9 Audited content logic handoff'));
  assert(iakb.length <= 28 * 1024);
  assert(lakb.length <= 24 * 1024);
});

const files = [
  'src/services/pipeline/stage3.js',
  'src/services/pipeline/stage5.js',
  'src/services/pipeline/stage6.js',
  'src/services/pipeline/stage4.js',
  'src/services/llm/callLLM.js',
  'src/services/pipeline/orchestrator.js',
];
check('production paths contain budget guard wiring', () => {
  for (const relative of files) {
    const source = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
    if (relative.endsWith('stage4.js')) {
      assert(source.includes('responseFormat: { type: \'json_object\' }'));
      assert(source.includes('retryOnTruncation: true'));
      assert(source.includes('HTML_CONTENT_TRUNCATED_FOR_AUDIT'));
    } else if (!relative.endsWith('orchestrator.js')) {
      assert(source.includes('skipOnBudget'), `${relative} missing guard`);
    }
  }
});

if (process.exitCode) process.exit(process.exitCode);
console.log('✅ test-seo-writer-guards: all checks passed');
