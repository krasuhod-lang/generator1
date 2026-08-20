'use strict';

const assert = require('assert');
const {
  buildGistSignals,
  buildArticleSemantics,
  enrichMetaInputs,
} = require('../src/services/metaTags/metaContext');
const { snippetCtrScore } = require('../src/services/metaTags/ctrScore');
const { analyzeMetaLengths } = require('../src/services/projects/pageMetaAudit');
const { TITLE_MIN, DESC_MIN, TITLE_MAX, DESC_MAX } = require('../src/services/metaTags/lengthConfig');
const { PAIR_ASSEMBLER_SYSTEM, CANDIDATE_GENERATOR_SYSTEM } = require('../src/services/metaTags/gistMetaPrompts');

let passed = 0;
let failed = 0;
function check(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`✓ ${name}`);
  } else {
    failed += 1;
    console.error(`✗ ${name}`);
  }
}

const html = `
  <h1>Как выбрать теплоизоляцию для фасада</h1>
  <p>Материал снижает теплопотери на 35% при правильном монтаже.</p>
  <h2>Ограничения и ошибки монтажа</h2>
  <p>Не подходит для влажного основания. Важно учесть вентиляционный зазор.</p>
  <h2>Сравнение материалов</h2>
  <p>Сравните толщину, плотность и срок службы перед выбором.</p>
`;
const plain = 'Как выбрать теплоизоляцию для фасада. Материал снижает теплопотери на 35% при правильном монтаже. Не подходит для влажного основания. Важно учесть вентиляционный зазор. Сравните толщину, плотность и срок службы перед выбором.';

console.log('GIST v3.3 deterministic context');
{
  const signals = buildGistSignals({
    keyword: 'теплоизоляция фасада',
    articleType: 'info',
    articleHtml: html,
    plain,
  });
  check('intent contract is informational for blog article',
    signals.intent_contract.value === 'Informational/Research');
  check('intent contract contains decision stage and page job',
    signals.intent_contract.decision_stage === 'research_and_understanding'
      && signals.intent_contract.page_job.length > 20);
  check('failure mode heuristic extracted',
    signals.heuristic_nodes.failure_mode.length > 0);
  check('hidden information heuristic extracted',
    signals.heuristic_nodes.hidden_info.length > 0);
  check('limitation heuristic extracted',
    signals.heuristic_nodes.limitation.length > 0);
  check('quantifiable fact extracted',
    signals.heuristic_nodes.quantifiable.length > 0
      && signals.factual_anchors.some((x) => x.includes('35%')));
  check('distinctive H2 sections extracted',
    signals.distinctive_sections.includes('Ограничения и ошибки монтажа'));

  const semantics = buildArticleSemantics({
    keyword: 'теплоизоляция фасада',
    articleHtml: html,
    plain,
    headings: signals.distinctive_sections,
  });
  check('article-derived semantics keeps main keyword',
    semantics.title_mandatory_words[0] === 'теплоизоляция фасада');
  check('article-derived LSI is non-empty and bounded',
    semantics.obligatory_lsi.length > 0 && semantics.obligatory_lsi.length <= 5
      && semantics.differentiator_lsi.length <= 5);

  const enriched = enrichMetaInputs({
    keyword: 'теплоизоляция фасада',
    inputs: {
      articleType: 'info',
      articleHtml: html,
      articlePlain: plain,
      missingNodes: ['Явный пробел из Stage 1'],
    },
    semantics: { differentiator_lsi: ['минеральная вата'] },
  });
  check('explicit missing nodes are preserved',
    enriched.missingNodes.includes('Явный пробел из Stage 1'));
  check('heuristic missing nodes are merged',
    enriched.missingNodes.some((x) => x.includes('Ограничение из статьи')));
  check('intent contract is exposed in enriched inputs',
    enriched.intentContract.value === 'Informational/Research');
}

console.log('\nIntent-aware CTR score');
{
  const score = snippetCtrScore({
    keyword: 'теплоизоляция фасада',
    metas: {
      title: 'Теплоизоляция фасада | Теплопотери ниже на 35%',
      description: 'Разбор материалов, толщины и ошибок монтажа: узнайте, когда утеплитель не подходит для влажного основания. Читайте разбор.',
      h1: 'Как выбрать теплоизоляцию для фасада',
    },
    inputs: {
      articleType: 'info',
      intentContract: { value: 'Informational/Research' },
    },
  });
  check('intent_fit component is present',
    score.breakdown.some((x) => x.name === 'intent_fit'));
  check('informational meta gets positive intent-fit',
    score.breakdown.find((x) => x.name === 'intent_fit').points > 0);
  check('non-numeric named GIST fact is recognized',
    score.breakdown.find((x) => x.name === 'gist_fact').points > 0);
  check('score stays within 0..100', score.score >= 0 && score.score <= 100);
}

console.log('\nShared length contract');
{
  const result = analyzeMetaLengths({
    title: 'а'.repeat(TITLE_MIN),
    description: 'б'.repeat(DESC_MIN),
    h1: 'в'.repeat(30),
  });
  check('page audit accepts shared minimum title/description', result.issues.length === 0);
  check('shared maximums remain finite', TITLE_MAX === 80 && DESC_MAX === 190);
}

console.log('\nPrompt contracts');
check('candidate prompt documents article intent source-of-truth',
  CANDIDATE_GENERATOR_SYSTEM.includes('ARTICLE_INTENT_CONTRACT'));
check('pair prompt contains intent-aware LSI rule',
  PAIR_ASSEMBLER_SYSTEM.includes('ARTICLE_INTENT_CONTRACT')
    && PAIR_ASSEMBLER_SYSTEM.includes('article-derived vocabulary'));

console.log(`\nGIST v3.3 upgrade smoke test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
