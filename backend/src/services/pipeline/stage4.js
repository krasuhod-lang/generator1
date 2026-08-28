'use strict';

const { callLLM }        = require('../llm/callLLM');
const { SYSTEM_PROMPTS } = require('../../prompts/systemPrompts');
const { calculateCoverage } = require('../../utils/calculateCoverage');

/**
 * E-E-A-T scoring rubric — добавляется к каждому вызову Stage 4.
 * Источник: v3.1 index.html (СТРОГО НЕТРОНУТО).
 */
const EEAT_TRUST_ADDENDUM = `

========== E-E-A-T AUDIT SCORING RUBRIC (target: pq_score >= 7.5) ==========

SCORING DIMENSIONS — evaluate EACH and reflect in pq_score (0-10):

1. EXPERIENCE (0-2 pts): Does the content show real practical experience with the product/service?
   - 2pts: specific conditions, terms, numbers from real data
   - 1pt: partially specific, some generics
   - 0pts: fully abstract, no real-world grounding

2. EXPERTISE (0-2 pts): Does the content demonstrate professional knowledge?
   - 2pts: evidence-backed method/process, correct terminology, concrete constraints; verified expert quote may strengthen it
   - 1pt: shows some domain knowledge but lacks sufficient evidence
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
- expert_opinion: есть только подтверждённая цитата с реальным автором; отсутствие цитаты не является автоматическим провалом
- specific_data: конкретные цифры/сроки из реальных данных
- process_description: описан процесс/механизм работы
- structured_content: есть H3, списки, таблицы
- no_hallucination: нет выдуманных чисел и обещаний
- helpful_first: текст отвечает на вопрос, не написан «для поисковика»

MINIMUM FOR pq_score >= 7.5:
- Experience >= 1.5
- Expertise >= 1.5 (evidence-backed method/process or verified expert quote)
- Authoritativeness >= 1.5
- Trustworthiness >= 2.0 (non-negotiable — factual safety is critical)
- Content Quality >= 1.0
- At least 4 of 7 trust signals found

IF pq_score < 7.5: populate actionable_next_steps with SPECIFIC HTML fixes to reach 7.5.
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

  // Keep the audit prompt bounded: preserve the beginning and ending of the
  // block while leaving room for a complete JSON quality response.
  const boundedHtml = String(htmlContent || '').length > 18000
    ? `${String(htmlContent || '').slice(0, 15000)}\n<!-- [HTML_CONTENT_TRUNCATED_FOR_AUDIT] -->\n${String(htmlContent || '').slice(-3000)}`
    : String(htmlContent || '');
  const stage4Prompt = (SYSTEM_PROMPTS.stage4 + EEAT_TRUST_ADDENDUM)
    .replace('{{HTML_CONTENT}}',      () => boundedHtml)
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
    {
      // A truncated audit otherwise becomes audit_unavailable and forces PQ=0.
      // One bounded truncation retry is cheaper than losing the quality signal
      // and launching uncontrolled downstream refinements.
      retries: 2,
      retryOnTruncation: true,
      taskId,
      stageName: 'stage4',
      model: 'deepseek-v4-pro',
      callLabel: `4 E-E-A-T Block ${blockIndex + 1}`,
      temperature: 0.2,
      maxTokens: 12000,
      maxTruncationTokens: 24000,
      responseFormat: { type: 'json_object' },
      allowPartialJson: true,
      log,
      onTokens,
    }
  );

  log(`Stage 4 блок ${blockIndex + 1}: ответ получен. Ключи: [${Object.keys(auditResult || {}).join(', ')}]`, 'info');

  const rawLsiCov = auditResult?.mathematical_audit?.lsi_coverage_percent;
  const rawPqScore = auditResult?.pq_score;
  const lsiTargets = Array.isArray(lsiMust)
    ? lsiMust.map(term => String(term || '').trim()).filter(Boolean)
    : [];
  const deterministicCoverage = lsiTargets.length > 0
    ? calculateCoverage(htmlContent, lsiTargets)
    : null;
  const hasModelLsi = Number.isFinite(Number(rawLsiCov));
  // LSI is an objective text metric: when targets exist, trust the same
  // deterministic stem-aware calculation used by Stage 6, not a model-reported
  // value that may describe the prompt or forget a FAQ term. With no targets,
  // the correct state is "not applicable", not a fabricated 0% or 100%.
  const lsiCovPct = deterministicCoverage?.percent ?? null;
  const pqScore = Number.isFinite(Number(rawPqScore))
    ? Math.max(0, Math.min(10, Number(rawPqScore)))
    : null;

  if (deterministicCoverage && hasModelLsi && Math.round(Number(rawLsiCov)) !== deterministicCoverage.percent) {
    log(
      `Stage 4 блок ${blockIndex + 1}: audit LSI ${rawLsiCov}% расходится с детерминированными ${deterministicCoverage.percent}% — сохраняем детерминированное значение`,
      'warn'
    );
  } else if (!deterministicCoverage) {
    log(`Stage 4 блок ${blockIndex + 1}: LSI-цели отсутствуют — покрытие не оценивается`, 'warn');
  }

  if (deterministicCoverage && auditResult?.mathematical_audit) {
    auditResult.mathematical_audit = {
      ...auditResult.mathematical_audit,
      lsi_coverage_percent: deterministicCoverage.percent,
      lsi_coverage_source: 'deterministic_html',
      ...(hasModelLsi ? { lsi_coverage_model_reported_percent: Number(rawLsiCov) } : {}),
    };
  }

  log(
    `Stage 4 блок ${blockIndex + 1}: LSI ${lsiCovPct == null ? 'n/a' : `${Math.round(lsiCovPct)}%`}, PQ-score ${pqScore}, ` +
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

  const boundedHtml = String(htmlContent || '').length > 18000
    ? `${String(htmlContent || '').slice(0, 15000)}\n<!-- [HTML_CONTENT_TRUNCATED_FOR_AUDIT] -->\n${String(htmlContent || '').slice(-3000)}`
    : String(htmlContent || '');
  const reAuditPrompt = `${SYSTEM_PROMPTS.stage4}

RE-AUDIT COMPACT MODE:
Это повторная проверка после одной итерации refine. Сохрани точность PQ/LSI/spam, но верни только JSON с полями mathematical_audit, pq_score и actionable_next_steps. Не добавляй eeat_preeval, hcu_verdict, criteria_details или recommended_material. В mathematical_audit оставь chars_count_actual, lsi_coverage_percent, lsi_found, lsi_missing, spam_risk_detected и zipf_compliance_notes. Каждый массив — максимум 12 элементов, каждое actionable поле — максимум 180 символов.
`
    .replace('{{HTML_CONTENT}}',      () => boundedHtml)
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
    {
      retries: 2,
      retryOnTruncation: true,
      taskId,
      stageName: 'stage4',
      model: 'deepseek-v4-pro',
      callLabel: `4 Re-audit Block ${blockIndex + 1}`,
      temperature: 0.2,
      maxTokens: 8000,
      maxTruncationTokens: 12000,
      responseFormat: { type: 'json_object' },
      allowPartialJson: true,
      log,
      onTokens,
    }
  );

  const rawLsiCov = result?.mathematical_audit?.lsi_coverage_percent;
  const lsiTargets = Array.isArray(lsiMust)
    ? lsiMust.map(term => String(term || '').trim()).filter(Boolean)
    : [];
  const deterministicCoverage = lsiTargets.length > 0
    ? calculateCoverage(htmlContent, lsiTargets)
    : null;

  if (deterministicCoverage && result?.mathematical_audit) {
    result.mathematical_audit = {
      ...result.mathematical_audit,
      lsi_coverage_percent: deterministicCoverage.percent,
      lsi_coverage_source: 'deterministic_html',
      ...(Number.isFinite(Number(rawLsiCov))
        ? { lsi_coverage_model_reported_percent: Number(rawLsiCov) }
        : {}),
    };
  }

  return {
    auditResult: result,
    pqScore:     Number.isFinite(Number(result?.pq_score))
      ? Math.max(0, Math.min(10, Number(result.pq_score)))
      : null,
    // Keep the same objective metric after re-audit; rawLsiCov is retained in
    // auditResult for diagnostics but must not overwrite actual HTML coverage.
    lsiCovPct:   deterministicCoverage?.percent ?? null,
  };
}

module.exports = { runStage4, reAuditBlock, EEAT_TRUST_ADDENDUM };
