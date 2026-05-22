'use strict';

/**
 * aegis/dspyClient — клиент к DSPy MIPROv2 optimizer'у в aegis_py.
 * Графейс-деградирует.
 *
 * Сценарий: раз в неделю (Sunday 02:00 UTC) GitHub Action вызывает
 * POST /dspy/retrain. Сервис тянет dspy_train_dataset из PostgreSQL,
 * запускает Bayesian-оптимизацию и сохраняет новые веса в
 * brain_state/compiled_writer.yaml.
 */

const { getAegisFlags } = require('./featureFlags');
const http = require('./_httpClient');

function _opts() {
  const cfg = getAegisFlags().dspy;
  return {
    base: getAegisFlags().graphrag.pyServiceUrl,
    timeoutMs: 60 * 60 * 1000, // ретрейн долгий, 1 час
    enabled:   cfg.enabled,
    maxTrials: cfg.maxTrials,
    maxCostUsd: cfg.maxCostUsd,
    minImprovementPct: cfg.minImprovementPct,
  };
}

async function retrain({ niche = null, dryRun = false } = {}) {
  const { base, timeoutMs, enabled, maxTrials, maxCostUsd, minImprovementPct } = _opts();
  if (!enabled) return { ok: false, reason: 'disabled' };
  return http.post(base, '/dspy/retrain', {
    niche,
    dry_run:                dryRun,
    max_trials:             maxTrials,
    max_cost_usd:           maxCostUsd,
    min_improvement_pct:    minImprovementPct,
  }, { timeoutMs });
}

async function status() {
  const { base, timeoutMs } = _opts();
  const r = await http.get(base, '/dspy/status', { timeoutMs: 5000 });
  return r;
}

module.exports = { retrain, status };
