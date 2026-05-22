'use strict';

/**
 * aegis/budgetGuard — семафор бюджета на одну задачу A.E.G.I.S.
 *
 * Защита от «галлюцинаторного цикла» (бесконечный refine):
 *   - GEMINI_TASK_TOKEN_BUDGET — лимит суммарных input+output токенов Gemini;
 *   - DEEPSEEK_TASK_BUDGET    — лимит $ DeepSeek;
 *   - OVERALL_TASK_USD_BUDGET — общий потолок задачи в $.
 *
 * При превышении бросается BudgetExceededError; вызывающий код
 * должен поймать его и завершить задачу как needs_human_review.
 *
 * Использование:
 *   const tracker = createBudgetTracker();
 *   tracker.charge({ provider:'gemini', tokensIn:1234, tokensOut:567, costUsd:0.012 });
 *   tracker.assertWithinLimits(); // throws BudgetExceededError если за пределами
 */

const { getAegisFlags } = require('./featureFlags');

class BudgetExceededError extends Error {
  constructor(reason, snapshot) {
    super(`[aegis/budgetGuard] Budget exceeded: ${reason}`);
    this.name      = 'BudgetExceededError';
    this.reason    = reason;
    this.snapshot  = snapshot;
  }
}

/**
 * createBudgetTracker(opts?) — фабрика трекера.
 *
 * @param {{
 *   geminiTaskTokens?:number,
 *   deepseekTaskUsd?:number,
 *   overallTaskUsd?:number,
 *   logger?:{warn?:Function}
 * }} [opts]
 */
function createBudgetTracker(opts = {}) {
  const flags = getAegisFlags().budgets;
  const limits = {
    geminiTaskTokens:  Number.isFinite(opts.geminiTaskTokens) ? opts.geminiTaskTokens : flags.geminiTaskTokens,
    deepseekTaskUsd:   Number.isFinite(opts.deepseekTaskUsd)  ? opts.deepseekTaskUsd  : flags.deepseekTaskUsd,
    overallTaskUsd:    Number.isFinite(opts.overallTaskUsd)   ? opts.overallTaskUsd   : flags.overallTaskUsd,
  };
  const logger = opts.logger || console;

  const state = {
    gemini:   { tokensIn: 0, tokensOut: 0, costUsd: 0, calls: 0 },
    deepseek: { tokensIn: 0, tokensOut: 0, costUsd: 0, calls: 0 },
    other:    { tokensIn: 0, tokensOut: 0, costUsd: 0, calls: 0 },
    startedAt: Date.now(),
  };

  function _bucket(provider) {
    const p = String(provider || '').toLowerCase();
    if (p === 'gemini')   return state.gemini;
    if (p === 'deepseek') return state.deepseek;
    return state.other;
  }

  function charge({ provider, tokensIn = 0, tokensOut = 0, costUsd = 0 } = {}) {
    const b = _bucket(provider);
    b.tokensIn  += Math.max(0, Number(tokensIn)  || 0);
    b.tokensOut += Math.max(0, Number(tokensOut) || 0);
    b.costUsd   += Math.max(0, Number(costUsd)   || 0);
    b.calls     += 1;
  }

  function snapshot() {
    const totalUsd = state.gemini.costUsd + state.deepseek.costUsd + state.other.costUsd;
    const geminiTokens = state.gemini.tokensIn + state.gemini.tokensOut;
    return {
      gemini:   { ...state.gemini, total_tokens: geminiTokens },
      deepseek: { ...state.deepseek },
      other:    { ...state.other },
      totals:   {
        cost_usd:        Math.round(totalUsd * 1e6) / 1e6,
        gemini_tokens:   geminiTokens,
        elapsed_ms:      Date.now() - state.startedAt,
      },
      limits,
    };
  }

  function assertWithinLimits() {
    const s = snapshot();
    if (s.gemini.total_tokens > limits.geminiTaskTokens) {
      throw new BudgetExceededError(
        `Gemini tokens=${s.gemini.total_tokens} > limit=${limits.geminiTaskTokens}`,
        s,
      );
    }
    if (s.deepseek.costUsd > limits.deepseekTaskUsd) {
      throw new BudgetExceededError(
        `DeepSeek cost=$${s.deepseek.costUsd.toFixed(4)} > limit=$${limits.deepseekTaskUsd}`,
        s,
      );
    }
    if (s.totals.cost_usd > limits.overallTaskUsd) {
      throw new BudgetExceededError(
        `Overall cost=$${s.totals.cost_usd.toFixed(4)} > limit=$${limits.overallTaskUsd}`,
        s,
      );
    }
  }

  function withinLimits() {
    try { assertWithinLimits(); return true; }
    catch (err) {
      if (err instanceof BudgetExceededError) {
        if (logger && typeof logger.warn === 'function') {
          logger.warn(err.message);
        }
        return false;
      }
      throw err;
    }
  }

  return { charge, snapshot, assertWithinLimits, withinLimits, limits };
}

module.exports = { createBudgetTracker, BudgetExceededError };
