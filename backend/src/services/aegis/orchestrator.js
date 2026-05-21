'use strict';

/**
 * aegis/orchestrator — мини-LangGraph рефайн-цикла в чистом Node.
 *
 * Реализует Этапы 3-6 Super-Core SEO:
 *
 *   [Writer: Gemini] → [Critics: DeepSeek (factcheck/plagiarism/readability/
 *                       intent/lsi-overdose)] → score → if Spq<gate →
 *                       [Refiner: DeepSeek] → loop (max iters) → final.
 *
 * Не дублирует уже существующие critic-сервисы (factCheck.service.js,
 * plagiarism.service.js, readability.service.js, intentVerify.service.js,
 * lsiPipeline.measureLsiCoverageSemantic, runEeatAuditCore) — ВЫЗЫВАЕТ их
 * напрямую. Roли:
 *   - writeFn(userMsg, ctx) → { html, usage } — генератор (передаётся
 *     извне; в pipeline.js это callLLM(...) с writer-промптом).
 *   - refineFn(userMsg, audit, ctx) → { html, usage } — корректировщик
 *     (по умолчанию = writeFn с расширенным промптом).
 *
 * Гейт качества: Spq ≥ 80 (= 8.0/10), как просил владелец продукта.
 *
 * Графейс-деградирует: если ни один critic не дал отчёт — гейт пропускает
 * с verdict='review' (а не fail), чтобы не блокировать систему при
 * отсутствии включённых Phase-1/2 сервисов.
 *
 * НЕ имеет побочных эффектов кроме вызова переданных функций writer/refiner
 * и логгера. Все настройки — из featureFlags.
 */

const { getAegisFlags } = require('./featureFlags');
const { evaluateQualityGate, QualityGateFailedError } = require('./qualityGate');
const { createBudgetTracker, BudgetExceededError } = require('./budgetGuard');
const { computeQualityScore } = require('../qualityLayers/qualityScore');

/**
 * runRefineLoop({ writeFn, refineFn?, criticsFn, userMsg, maxIters?, logger? })
 *
 * @param {object} args
 * @param {(userMsg:string, ctx:object) => Promise<{html:string, usage:object}>} args.writeFn
 * @param {(userMsg:string, audit:object, ctx:object) => Promise<{html:string, usage:object}>} [args.refineFn]
 * @param {(html:string, ctx:object) => Promise<{reports:object, meta:object}>} args.criticsFn
 *   возвращает reports для computeQualityScore и meta (model_used, cost_usd...)
 * @param {string} args.userMsg — стартовый user prompt для writer'а.
 * @param {object} [args.ctx] — произвольный контекст (article_id, niche…).
 * @param {number} [args.maxIters] — override langgraph.maxRefineIters.
 * @param {object} [args.logger] — { info, warn } (default: console).
 * @param {object} [args.budgetTracker] — внешний трекер бюджета; иначе создаётся локальный.
 *
 * @returns {Promise<{
 *   html: string,
 *   audit: object,           // результат evaluateQualityGate финальной итерации
 *   qualityScore: object,    // computeQualityScore финальной итерации
 *   iterations: number,
 *   trace: Array<{iter:number, overall:number|null, verdict:string, reason:string|null}>,
 *   budget: object,
 *   passed: boolean,
 *   needs_human_review: boolean,
 * }>}
 */
async function runRefineLoop({
  writeFn,
  refineFn = null,
  criticsFn,
  userMsg,
  ctx = {},
  maxIters = null,
  logger = console,
  budgetTracker = null,
} = {}) {
  if (typeof writeFn   !== 'function') throw new Error('[aegis/orchestrator] writeFn required');
  if (typeof criticsFn !== 'function') throw new Error('[aegis/orchestrator] criticsFn required');

  const flags  = getAegisFlags();
  const limit  = Number.isFinite(maxIters) ? maxIters : flags.langgraph.maxRefineIters;
  const tracker = budgetTracker || createBudgetTracker({ logger });

  const trace = [];
  let html  = '';
  let qualityScore = null;
  let audit = null;

  for (let iter = 0; iter <= limit; iter += 1) {
    // ── Бюджет: до каждого LLM-вызова. ──────────────────────────
    try { tracker.assertWithinLimits(); }
    catch (err) {
      if (err instanceof BudgetExceededError) {
        return _finalize({
          html,
          qualityScore,
          audit,
          iterations: iter,
          trace,
          tracker,
          forcedReview: true,
          reason: err.reason,
        });
      }
      throw err;
    }

    // ── Write / Refine ──────────────────────────────────────────
    let generated;
    if (iter === 0) {
      logger.info && logger.info(`[aegis] writer iter=${iter}`);
      generated = await writeFn(userMsg, ctx);
    } else {
      const fn = refineFn || writeFn;
      const refinedUser = _buildRefinePrompt(userMsg, audit);
      logger.info && logger.info(`[aegis] refiner iter=${iter} (reason=${audit && audit.reason})`);
      generated = await fn(refinedUser, audit, ctx);
    }

    html = (generated && generated.html) || '';
    const usage = (generated && generated.usage) || {};
    tracker.charge({
      provider:  usage.provider || ctx.provider || 'gemini',
      tokensIn:  usage.tokensIn  || usage.tokens_in  || 0,
      tokensOut: usage.tokensOut || usage.tokens_out || 0,
      costUsd:   usage.costUsd   || usage.cost_usd   || 0,
    });

    // ── Critics → quality score ─────────────────────────────────
    let criticResult;
    try {
      criticResult = await criticsFn(html, ctx);
    } catch (err) {
      logger.warn && logger.warn(`[aegis] criticsFn failed iter=${iter}: ${err.message}`);
      criticResult = { reports: {}, meta: {} };
    }
    const reports = (criticResult && criticResult.reports) || {};
    const meta    = (criticResult && criticResult.meta)    || {};

    qualityScore = computeQualityScore(reports, meta);
    audit = evaluateQualityGate(qualityScore);
    trace.push({
      iter,
      overall: qualityScore.overall,
      verdict: audit.verdict,
      reason:  audit.reason,
      sub_fails: audit.sub_fails,
    });

    logger.info && logger.info(
      `[aegis] iter=${iter} overall=${qualityScore.overall} verdict=${audit.verdict}`,
    );

    if (audit.passed) {
      return _finalize({
        html, qualityScore, audit,
        iterations: iter + 1, trace, tracker,
        forcedReview: false,
      });
    }
    if (iter >= limit) break;
  }

  // ── Цикл исчерпан, гейт не пройден. ───────────────────────────
  // Поведение: 'fail' → бросаем QualityGateFailedError; 'review' → отдаём с пометкой.
  const onFail = flags.qualityGate.onFail;
  if (onFail === 'fail') {
    throw new QualityGateFailedError(
      `refine_loop exhausted after ${limit + 1} iterations: ${audit && audit.reason}`,
      { audit, qualityScore, trace, budget: tracker.snapshot() },
    );
  }
  return _finalize({
    html, qualityScore, audit,
    iterations: limit + 1, trace, tracker,
    forcedReview: true,
    reason: audit && audit.reason,
  });
}

function _finalize({ html, qualityScore, audit, iterations, trace, tracker, forcedReview, reason }) {
  const passed = Boolean(audit && audit.passed && !forcedReview);
  return {
    html,
    audit,
    qualityScore,
    iterations,
    trace,
    budget: tracker.snapshot(),
    passed,
    needs_human_review: !passed,
    forced_review_reason: forcedReview ? (reason || (audit && audit.reason)) : null,
  };
}

function _buildRefinePrompt(originalUser, audit) {
  if (!audit) return originalUser;
  const issues = [];
  if (audit.reason) issues.push(`общая причина: ${audit.reason}`);
  for (const f of (audit.sub_fails || [])) {
    issues.push(`${f.key}: ${f.value} < ${f.threshold}`);
  }
  return [
    originalUser,
    '',
    '────────────────  [AEGIS REFINER]  ────────────────',
    'Предыдущая версия не прошла гейт качества. Проблемы:',
    ...issues.map((s) => `  • ${s}`),
    '',
    'Перепиши блок, устранив каждый пункт. Сохрани структуру H2/H3,',
    'формулу Флеша-RU и не превышай LSI-плотность. Верни ТОЛЬКО HTML.',
  ].join('\n');
}

module.exports = { runRefineLoop, _buildRefinePrompt };
