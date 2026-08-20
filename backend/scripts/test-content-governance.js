'use strict';

const assert = require('assert');
const {
  buildGovernanceReport,
  renderGovernanceBlock,
} = require('../src/services/contentGovernance');
const { qualityGate } = require('../src/services/qualityCore');
const { buildArticleKnowledgeBase } = require('../src/utils/articleKnowledgeBase');
const { buildInfoArticleKnowledgeBase } = require('../src/services/infoArticle/infoArticleKnowledgeBase');
const { buildLinkArticleKnowledgeBase } = require('../src/services/linkArticle/linkArticleKnowledgeBase');

function testConfirmedOnly() {
  const report = buildGovernanceReport({
    contentType: 'seo',
    task: { input_target_service: 'тендерное сопровождение' },
    projectContext: {
      project: { name: 'Acme', niche: 'B2B услуги' },
      brand: {
        facts: [
          { text: 'Работаем с 2012 года', status: 'confirmed', source: 'https://example.test/about' },
          { text: 'Лидер рынка', status: 'draft' },
        ],
        approved_claims: [
          { text: 'Есть сопровождение закупок', status: 'confirmed' },
        ],
      },
      signals: {},
    },
    semanticContext: {
      entities: ['закупки'],
      intents: ['commercial'],
      questions: ['как выбрать подрядчика'],
      lsi: ['тендер'],
    },
  });
  assert.strictEqual(report.confirmed_facts, 1);
  assert.strictEqual(report.confirmed_claims, 1);
  assert.strictEqual(report.ignored_facts, 1);
  assert.strictEqual(report.ignored_claims, 0);
  const block = renderGovernanceBlock({ report, contentType: 'seo' });
  assert.ok(block.includes('Работаем с 2012 года'));
  assert.ok(!block.includes('Лидер рынка'));
}

function testConflictBlocksPublication() {
  const report = buildGovernanceReport({
    contentType: 'info',
    task: { topic: 'кредитование бизнеса', input_author_name: 'Редакция' },
    projectContext: {
      project: { conflicts: ['разные юридические адреса в источниках'] },
      brand: {},
    },
  });
  assert.strictEqual(report.status, 'blocked');
  assert.strictEqual(report.can_generate, false);
  const result = qualityGate.finalize('info', {
    html: '<p>Полезный текст</p>',
    governanceReport: report,
  });
  assert.ok(result.blockers.some((gate) => gate.name === 'content_governance'));
}

function testSensitiveReview() {
  const report = buildGovernanceReport({
    contentType: 'info',
    task: { topic: 'медицинская клиника' },
    projectContext: { project: {}, brand: {} },
  });
  assert.strictEqual(report.sensitive_topic, true);
  assert.ok(report.blockers.some((item) => item.code === 'missing_author_for_sensitive_topic'));
}

function testKnowledgeBaseHandoff() {
  const governanceBlock = '## CONTENT GOVERNANCE — BRANDCORE + TGA\\nТолько confirmed claims.';
  const task = { input_brand_name: 'Acme', input_target_service: 'услуга', input_region: 'Москва' };
  const akb = buildArticleKnowledgeBase({ task, governanceBlock });
  const iakb = buildInfoArticleKnowledgeBase({ task, governanceBlock });
  const lakb = buildLinkArticleKnowledgeBase({ task, governanceBlock });
  assert.ok(akb.includes('CONTENT GOVERNANCE'));
  assert.ok(iakb.includes('CONTENT GOVERNANCE'));
  assert.ok(lakb.includes('CONTENT GOVERNANCE'));
}

function testContentTypeRules() {
  for (const type of ['seo', 'link', 'info', 'meta']) {
    const report = buildGovernanceReport({ contentType: type, task: { topic: 'услуга' } });
    const block = renderGovernanceBlock({ report, contentType: type });
    assert.ok(block.includes('CONTENT GOVERNANCE'));
    assert.ok(block.includes('Правила конкретного типа материала'));
  }
}

testConfirmedOnly();
testConflictBlocksPublication();
testSensitiveReview();
testKnowledgeBaseHandoff();
testContentTypeRules();
console.log('content governance tests: 5/5 passed');
