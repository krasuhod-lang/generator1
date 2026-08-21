'use strict';

const assert = require('assert');
const {
  CONTRACT_VERSION,
  METRICS,
  buildEeatContract,
  validateEeatContract,
} = require('../src/services/eeatAudit/contentContract');

let passed = 0;
function check(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log(`✓ ${name}`);
}

const base = {
  task: {
    input_brand_name: 'Acme',
    input_target_service: 'тендерное сопровождение',
    input_brand_facts: 'Компания работает с B2B-клиентами и описывает процесс проверки документов.',
    input_author_name: 'Анна Петрова',
    input_author_role: 'руководитель практики',
    input_region: 'Москва',
    input_tfidf_json: JSON.stringify([
      { term: 'тендерное сопровождение', rangeMin: 2, rangeMax: 5 },
      { term: 'проверка документов', rangeMin: 1, rangeMax: 3 },
    ]),
  },
  strategy: { niche_summary: 'B2B услуги для закупок' },
  stage0Result: {
    realtime_facts: [{ fact: 'Проверка документов снижает риск пропуска обязательного требования.', source: 'https://example.com/source' }],
    competitor_facts: [{ fact: 'В топе объясняют порядок подготовки заявки.', source: 'https://example.com/serp' }],
  },
  stage1Result: {
    entities: [
      { entity: 'тендерная документация', type: 'process', importance: 'high' },
      { entity: 'проверка документов', type: 'process', importance: 'high' },
      { entity: 'электронная закупка', type: 'context', importance: 'medium' },
    ],
    knowledge_graph: { nodes: [{ label: '44-ФЗ', type: 'regulation', salience: 0.9 }] },
  },
  stage2Result: {
    important_lsi: ['тендерная документация', 'проверка документов', 'электронная закупка'],
  },
  outline: {
    sections: [
      { h2: 'Как проходит проверка документов' },
      { h2: 'Что сравнить перед подачей заявки' },
    ],
  },
  lsi: {
    important_lsi: [
      { lemma: 'тендерная документация', tf_idf_score: 0.7, bm25_score: 1.2 },
      { lemma: 'проверка документов', tf_idf_score: 0.5, bm25_score: 0.8 },
      { lemma: 'электронная закупка', tf_idf_score: 0.4, bm25_score: 0.6 },
    ],
  },
  realtimeResearch: {
    realtime_facts: [{ fact: 'Проверка документов снижает риск пропуска требования.', source: 'https://example.com/source' }],
  },
};

for (const branch of ['seo', 'info', 'link']) {
  const contract = buildEeatContract({ ...base, branch });
  check(`${branch}: contract version`, contract.version === CONTRACT_VERSION);
  check(`${branch}: target is at least 7.5`, contract.target_score >= 7.5);
  check(`${branch}: evidence collected`, contract.evidence.length >= 2);
  check(`${branch}: entities collected`, contract.entities.length >= 3);
  check(`${branch}: LSI collected`, contract.semantic.lsi_required.length >= 3);
  check(`${branch}: writer brief grounded`, contract.writer_brief.includes('VERIFIED_EVIDENCE'));
  check(`${branch}: markdown rendered`, contract.markdown.includes('E-E-A-T 12'));
}

check('12 metrics are defined', METRICS.length === 12);

const seoContract = buildEeatContract({ ...base, branch: 'seo' });
const goodHtml = `
  <article>
    <p>Автор: Анна Петрова, руководитель практики. Обновлено: 2026.</p>
    <p>Проверка тендерной документации помогает определить обязательные требования и порядок действий.</p>
    <h2>Как проходит проверка документов</h2>
    <p>Сначала сопоставьте требования, затем проверьте документы и сроки подачи заявки.</p>
    <table><tr><th>Критерий</th><th>Что проверить</th></tr><tr><td>Документы</td><td>Полноту</td></tr></table>
    <h2>Что сравнить перед подачей заявки</h2>
    <p>Сравните варианты по критериям, ограничениям и условиям применимости.</p>
    <h2>Часто задаваемые вопросы</h2>
    <p>Вопрос: что проверить сначала? Ответ: обязательные поля и сроки.</p>
    <p>Источник: https://example.com/source. Данные актуальны на 2026 год.</p>
    <p>LSI: тендерная документация, проверка документов, электронная закупка.</p>
  </article>`;
const goodAudit = validateEeatContract(goodHtml, seoContract);
check('valid article reaches pass', goodAudit.verdict === 'pass');
check('valid article is publish-ready', goodAudit.publish_ready === true);
check('valid article has all 12 components', Object.keys(goodAudit.components).length === 12);
check('valid article reports LSI coverage', goodAudit.checks.lsi.present >= 3);

const weakAudit = validateEeatContract('<article><p>Автор: Редакция.</p><p>По данным исследования результат составляет 50%.</p></article>', seoContract);
check('weak evidence article is not publish-ready', weakAudit.publish_ready === false);
check('weak evidence is reported', weakAudit.unsupported_claims.length > 0 || weakAudit.blockers.length > 0);
check('missing table is reported', weakAudit.blockers.includes('missing_required_table'));

const highRiskContract = buildEeatContract({
  ...base,
  branch: 'info',
  task: { ...base.task, input_niche_features: 'финансовые услуги и кредитование' },
});
const highRiskAudit = validateEeatContract(goodHtml, highRiskContract);
check('high-risk contract requires review', highRiskContract.human_review_required === true);
check('high-risk article without reviewer goes to human review', highRiskAudit.verdict === 'human_review');

console.log(`\n✅ test-eeat12-contract: ${passed} checks passed`);
