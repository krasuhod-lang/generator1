'use strict';

const { callLLM }        = require('../llm/callLLM');
const { SYSTEM_PROMPTS } = require('../../prompts/systemPrompts');

/**
 * E-E-A-T scoring rubric — добавляется к каждому вызову Stage 4.
 * Источник: v3.1 index.html (СТРОГО НЕТРОНУТО).
 */
const EEAT_TRUST_ADDENDUM = `

========== E-E-A-T AUDIT SCORING RUBRIC (target: pq_score >= 8.0) ==========

SCORING DIMENSIONS — evaluate EACH and reflect in pq_score (0-10):

1. EXPERIENCE (0-2 pts): Does the content show real practical experience with the product/service?
   - 2pts: specific conditions, terms, numbers from real data
   - 1pt: partially specific, some generics
   - 0pts: fully abstract, no real-world grounding

2. EXPERTISE (0-2 pts): Does the content demonstrate professional knowledge?
   - 2pts: expert opinion present (blockquote), professional terminology used correctly
   - 1pt: shows some domain knowledge but no expert voice
   - 0pts: generic text, no expertise signals

3. AUTHORITATIVENESS (0-2 pts): Is the publisher/brand identity clear and credible?
   - 2pts: brand name mentioned, specific product/service details included, no empty claims
   - 1pt: brand mentioned but weak proof
   - 0pts: no brand identity, no authority signals

4. TRUSTWORTHINESS (0-2 pts): Is the content accurate, transparent, and verifiable?
   - 2pts: all claims backed by data, no hallucinated numbers, safe language where uncertain
   - 1pt: mostly safe but some unverified claims
   - 0pts: invented numbers, false promises, no disclaimers on sensitive topics

5. CONTENT QUALITY (0-2 pts): Does the content satisfy user intent completely?
   - 2pts: structured (H3s), scannable (lists), direct answers, no fluff
   - 1pt: some structure but padded or incomplete
   - 0pts: wall of text, filler, doesn't fully answer the query

TRUST SIGNALS CHECKLIST — mark each found/missing in trust_signals_found:
- brand_name_visible: бренд/компания упомянуты в тексте
- expert_opinion: есть blockquote с мнением эксперта
- specific_data: конкретные цифры/сроки из реальных данных
- process_description: описан процесс/механизм работы
- structured_content: есть H3, списки, таблицы
- no_hallucination: нет выдуманных чисел и обещаний
- helpful_first: текст отвечает на вопрос, не написан «для поисковика»

MINIMUM FOR pq_score >= 8.0:
- Experience >= 1.5
- Expertise >= 1.5 (expert blockquote strongly recommended)
- Authoritativeness >= 1.5
- Trustworthiness >= 2.0 (non-negotiable — factual safety is critical)
- Content Quality >= 1.5
- At least 4 of 7 trust signals found

IF pq_score < 8.0: populate actionable_next_steps with SPECIFIC HTML fixes to reach 8.0.
=======================================================================`;

/**
 * Stage 4: E-E-A-T аудит одного блока.
 * Адаптер: deepseek.
 *
 * @param {object}   task          — строка tasks из БД
 * @param {object}   ctx           — { log, progress, taskId }
 * @param {number}   blockIndex    — индекс блока
 * @param {string}   htmlContent   — HTML блока
 * @param {string[]} lsiMust       — обязательные LSI для этого блока
 * @returns {{ auditResult: object, pqScore: number, lsiCovPct: number }}
 */
async function runStage4(task, ctx, blockIndex, htmlContent, lsiMust) {
  const { log, taskId, onTokens } = ctx;

  const targetService = task.input_target_service;
  const brandFacts    = task.input_brand_facts   || 'Нет данных';
  const nGrams        = task.input_ngrams        || '[]';
  const minChars      = task.input_min_chars     || '1500';

  const stage4Prompt = (SYSTEM_PROMPTS.stage4 + EEAT_TRUST_ADDENDUM)
    .replace('{{HTML_CONTENT}}',      () => htmlContent)
    .replace('{{TARGET_SERVICE}}',    () => targetService)
    .replace('{{ORIGINAL_LSI_MUST}}', () => JSON.stringify(lsiMust))
    .replace(/\{\{BRAND_NAME\}\}/g,   () => (task.input_brand_name || '').trim() || 'Нет данных')
    .replace('{{BRAND_FACTS}}',       () => brandFacts)
    .replace('{{ORIGINAL_NGRAMS}}',   () => nGrams)
    .replace('{{TARGET_CHAR_COUNT}}', () => String(minChars));

  log(`Stage 4 блок ${blockIndex + 1}: E-E-A-T аудит, промпт ${stage4Prompt.length} символов...`, 'info');

  const auditResult = await callLLM(
    'deepseek',
    '',
    stage4Prompt,
    { retries: 3, taskId, stageName: 'stage4', callLabel: `4 E-E-A-T Block ${blockIndex + 1}`, temperature: 0.2, log, onTokens }
  );

  log(`Stage 4 блок ${blockIndex + 1}: ответ получен. Ключи: [${Object.keys(auditResult || {}).join(', ')}]`, 'info');

  const lsiCovPct = auditResult?.mathematical_audit?.lsi_coverage_percent ?? 0;
  const pqScore   = auditResult?.pq_score ?? 0;

  log(
    `Stage 4 блок ${blockIndex + 1}: LSI ${Math.round(lsiCovPct)}%, PQ-score ${pqScore}, ` +
    `spam_risk: ${auditResult?.mathematical_audit?.spam_risk_detected || false}`,
    'info'
  );

  return { auditResult, pqScore, lsiCovPct };
}

/**
 * Быстрый повторный аудит (для Stage 5 итераций — без EEAT rubric).
 */
async function reAuditBlock(task, ctx, blockIndex, htmlContent, lsiMust) {
  const { log, taskId, onTokens } = ctx;

  const reAuditPrompt = SYSTEM_PROMPTS.stage4
    .replace('{{HTML_CONTENT}}',      () => htmlContent)
    .replace('{{TARGET_SERVICE}}',    () => task.input_target_service)
    .replace('{{ORIGINAL_LSI_MUST}}', () => JSON.stringify(lsiMust))
    .replace(/\{\{BRAND_NAME\}\}/g,   () => (task.input_brand_name || '').trim() || 'Нет данных')
    .replace('{{BRAND_FACTS}}',       () => task.input_brand_facts || 'Нет данных')
    .replace('{{ORIGINAL_NGRAMS}}',   () => task.input_ngrams      || '[]')
    .replace('{{TARGET_CHAR_COUNT}}', () => String(task.input_min_chars || '1500'));

  const result = await callLLM(
    'deepseek',
    '',
    reAuditPrompt,
    { retries: 2, taskId, stageName: 'stage4', callLabel: `4 Re-audit Block ${blockIndex + 1}`, temperature: 0.2, log, onTokens }
  );

  return {
    auditResult: result,
    pqScore:     result?.pq_score ?? 0,
    lsiCovPct:   result?.mathematical_audit?.lsi_coverage_percent ?? 0,
  };
}

module.exports = { runStage4, reAuditBlock, EEAT_TRUST_ADDENDUM };
