'use strict';

/* Smoke-тест relevanceArtifacts: fromReportRow + renderForPromptBrief + helpers. */

const assert = require('assert');
const {
  fromReportRow,
  renderForPromptBrief,
  buildRelevanceStageBrief,
  relevanceSeedTerms,
  _splitHeadingsByLevel,
  _digestSignals,
} = require('../src/services/relevance/relevanceArtifacts');

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log('✓', name); passed++; }
  catch (e) { console.error('✗', name, '\n  ', e.message); failed++; }
}

t('fromReportRow: null/empty => null', () => {
  assert.strictEqual(fromReportRow(null), null);
});

t('fromReportRow: пустой report → пустые массивы', () => {
  const art = fromReportRow({ id: 'r1', report: {}, our_report: {} });
  assert.ok(art);
  assert.deepStrictEqual(art.important_lsi, []);
  assert.deepStrictEqual(art.h2_drafts, []);
  assert.strictEqual(art.competitor_signals, null);
});

t('fromReportRow: LSI разделяется на important/additional, отсортирован по df_share_pct', () => {
  const art = fromReportRow({
    id: 'r2',
    report: {
      vocabulary: [
        { lemma: 'crm', status: 'important', df_share_pct: 80, median_count: 4 },
        { lemma: 'erp', status: 'important', df_share_pct: 95, median_count: 6 },
        { lemma: 'pmo', status: 'additional', df_share_pct: 30 },
        { lemma: 'kpi', status: 'additional', df_share_pct: 40 },
      ],
    },
  });
  assert.strictEqual(art.important_lsi[0].lemma, 'erp');
  assert.strictEqual(art.important_lsi[1].lemma, 'crm');
  assert.strictEqual(art.additional_lsi[0].lemma, 'kpi');
});

t('_splitHeadingsByLevel: h2/h3/без levels', () => {
  const { h2, h3 } = _splitHeadingsByLevel([
    { sample: 'Что такое CRM', levels: ['h2'] },
    { sample: 'Внедрение CRM', levels: ['h3'] },
    { sample: 'История CRM', levels: [] },
    { sample: 'Сводка', levels: ['h4'] },
  ]);
  assert.ok(h2.includes('Что такое CRM'));
  assert.ok(h2.includes('История CRM'));
  assert.ok(h3.includes('Внедрение CRM'));
  assert.ok(h3.includes('Сводка'));
});

t('_digestSignals: вытаскивает schema/host/title', () => {
  const dg = _digestSignals({
    top_aggregate: {
      schema_profile: { summary: { has_jsonld_in_top_count: 5, has_faq_in_top_count: 3 } },
      host_hygiene:   { hygiene_pct: 90 },
      median_word_count: 1850,
      title_templates: [{ template: '{topic} — guide' }],
    },
  });
  assert.strictEqual(dg.has_jsonld, true);
  assert.strictEqual(dg.has_faq, true);
  assert.strictEqual(dg.host_hygiene_pct, 90);
  assert.strictEqual(dg.median_words, 1850);
  assert.strictEqual(dg.title_template, '{topic} — guide');
});

t('fromReportRow: интеграция headings + competitor_signals', () => {
  const art = fromReportRow({
    id: 'r3',
    report: {
      ngrams: [{ phrase: 'внедрение crm', df: 8, df_share_pct: 80 }],
      headings_intersection: [
        { sample: 'Что такое CRM', levels: ['h2'], df: 9, df_share_pct: 90 },
        { sample: 'Этапы', levels: ['h3'], df: 5, df_share_pct: 50 },
      ],
      competitor_signals: {
        top_aggregate: {
          entity_coverage: { mandatory_entities: [{ text: 'Bitrix24', df_share_pct: 70 }] },
          schema_profile: { summary: { recommendation_markdown: '### Schema', has_jsonld_in_top_count: 7 } },
          host_hygiene: { hygiene_pct: 80 },
        },
      },
    },
    our_report: { url: 'https://ex.com/crm' },
    llm_enrichment: { input_target_audience: 'СМБ', niche_features: 'облако' },
  });
  assert.strictEqual(art.h2_drafts[0], 'Что такое CRM');
  assert.strictEqual(art.h3_drafts[0], 'Этапы');
  assert.strictEqual(art.mandatory_entities[0].text, 'Bitrix24');
  assert.ok(art.schema_recommendation_markdown.includes('Schema'));
  assert.strictEqual(art.voice_of_customer.target_audience, 'СМБ');
  assert.strictEqual(art.voice_of_customer.niche_features, 'облако');
  assert.strictEqual(art.our_url, 'https://ex.com/crm');
  assert.ok(art.competitor_signals_digest.has_jsonld);
});

t('renderForPromptBrief: содержит блоки и маркеры', () => {
  const art = fromReportRow({
    id: 'r4',
    report: {
      vocabulary: [
        { lemma: 'crm', status: 'important', df_share_pct: 80 },
      ],
      ngrams: [{ phrase: 'внедрение crm', df: 8 }],
      headings_intersection: [{ sample: 'Что такое CRM', levels: ['h2'] }],
    },
  });
  const s = renderForPromptBrief(art);
  assert.ok(s.startsWith('[RELEVANCE_ARTIFACT]'));
  assert.ok(s.endsWith('[/RELEVANCE_ARTIFACT]'));
  assert.ok(s.includes('crm'));
  assert.ok(s.includes('внедрение crm'));
  assert.ok(s.includes('Что такое CRM'));
});

t('renderForPromptBrief: null/empty → пустая строка', () => {
  assert.strictEqual(renderForPromptBrief(null), '');
});

t('buildRelevanceStageBrief: содержит все блоки данных релевантности', () => {
  const art = fromReportRow({
    id: 'r5',
    report: {
      vocabulary: [
        { lemma: 'crm', status: 'important', df_share_pct: 80, median_count: 5 },
        { lemma: 'воронка', status: 'additional', df_share_pct: 30 },
      ],
      ngrams: [{ phrase: 'внедрение crm', df: 8, df_share_pct: 70 }],
      headings_intersection: [{ sample: 'Что такое CRM', df: 5, df_share_pct: 50, levels: ['h2'] }],
    },
  });
  const s = buildRelevanceStageBrief(art);
  assert.ok(s.startsWith('[RELEVANCE_STAGE_BRIEF]'));
  assert.ok(s.endsWith('[/RELEVANCE_STAGE_BRIEF]'));
  assert.ok(s.includes('crm'));
  assert.ok(s.includes('медиана 5'));       // важная LSI с частотностью
  assert.ok(s.includes('воронка'));          // дополнительная LSI
  assert.ok(s.includes('внедрение crm'));    // n-грамма
  assert.ok(s.includes('df=8'));             // число сайтов для n-граммы
  assert.ok(s.includes('Что такое CRM'));    // общий заголовок топа
});

t('buildRelevanceStageBrief: null → пустая строка', () => {
  assert.strictEqual(buildRelevanceStageBrief(null), '');
});

t('relevanceSeedTerms: важные LSI + n-граммы, дедуп и порядок', () => {
  const art = {
    important_lsi: [{ lemma: 'crm' }, { lemma: 'воронка' }],
    top_ngrams: [{ phrase: 'внедрение crm' }, { phrase: 'crm' }],
  };
  const terms = relevanceSeedTerms(art);
  assert.deepStrictEqual(terms, ['crm', 'воронка', 'внедрение crm']); // 'crm' не дублируется
  assert.deepStrictEqual(relevanceSeedTerms(null), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
