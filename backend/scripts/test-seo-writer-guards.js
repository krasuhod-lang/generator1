'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const { buildWriterContext } = require('../src/utils/writerContext');
const { DOCTOR_MAX_WRITER_CONTRACT } = require('../src/utils/doctorMaxWriterContract');

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
      assert(source.includes('retryOnTruncation: false'));
    } else if (!relative.endsWith('orchestrator.js')) {
      assert(source.includes('skipOnBudget'), `${relative} missing guard`);
    }
  }
});

if (process.exitCode) process.exit(process.exitCode);
console.log('✅ test-seo-writer-guards: all checks passed');
