'use strict';

/**
 * aegis/dspyAutoRetrain — автономный планировщик MIPROv2 retrain.
 *
 * Зачем: чтобы первый «компилированный мозг» собрался сам, без ручного
 * POST /api/aegis/dspy/retrain. Раз в N секунд (см. featureFlags.dspy.
 * autoRetrainCheckIntervalSec) воркер проверяет:
 *   • dspy.enabled = true
 *   • в aegis_dspy_dataset ≥ autoRetrainMinRows
 *   • с последнего успешного `deployed_at` в aegis_brain_versions
 *     прошло ≥ autoRetrainMinSpacingSec
 * Если все три условия выполнены — зовёт dspyClient.retrain().
 *
 * Telemetry поднимается в /api/aegis/status (dspy.last_retrain_at /
 * next_retrain_eta_sec / last_retrain_reason).
 */

const db = require('../../config/db');
const dspy = require('./dspyClient');
const { getAegisFlags } = require('./featureFlags');

let _timer = null;
let _running = false;

const _telemetry = {
  last_check_at:        null,
  last_retrain_at:      null,
  last_retrain_ok:      null,
  last_retrain_reason:  null,
  next_retrain_eta_sec: null,
  dataset_rows:         null,
};

function getDspyAutoTelemetry() {
  return { ..._telemetry };
}

async function _datasetCount() {
  try {
    const r = await db.query(`SELECT COUNT(*)::int AS c FROM aegis_dspy_dataset`);
    return Number(r.rows[0]?.c || 0);
  } catch (_) { return 0; }
}

async function _datasetRows(limit = 500) {
  try {
    const safeLimit = Math.max(4, Math.min(2000, Number(limit) || 500));
    const r = await db.query(
      `SELECT id, article_ref, niche, user_prompt, html_output,
              quality_score, spq_overall, ppo_weight, model_used, cost_usd
         FROM aegis_dspy_dataset
        WHERE user_prompt IS NOT NULL AND html_output IS NOT NULL
        ORDER BY created_at DESC
        LIMIT $1`,
      [safeLimit],
    );
    return r.rows || [];
  } catch (e) {
    console.warn('[aegis/dspyAutoRetrain] dataset rows failed:', e.message);
    return [];
  }
}

async function _lastDeployedAt() {
  try {
    const r = await db.query(
      `SELECT deployed_at FROM aegis_brain_versions
        WHERE rolled_back_at IS NULL
        ORDER BY deployed_at DESC LIMIT 1`
    );
    return r.rows[0]?.deployed_at || null;
  } catch (_) { return null; }
}

async function tick() {
  if (_running) return;
  _running = true;
  try {
    const flags = getAegisFlags().dspy || {};
    _telemetry.last_check_at = new Date().toISOString();

    if (!flags.enabled) {
      _telemetry.last_retrain_reason = 'dspy_disabled';
      return;
    }
    if (!flags.autoRetrainEnabled) {
      _telemetry.last_retrain_reason = 'auto_retrain_disabled';
      return;
    }

    const minRows = Number(flags.autoRetrainMinRows) || 10;
    const minSpacingSec = Number(flags.autoRetrainMinSpacingSec) || 21600;

    const rows = await _datasetCount();
    _telemetry.dataset_rows = rows;
    if (rows < minRows) {
      _telemetry.last_retrain_reason = `dataset_too_small:${rows}/${minRows}`;
      _telemetry.next_retrain_eta_sec = null;
      return;
    }

    const lastDeployed = await _lastDeployedAt();
    if (lastDeployed) {
      const ageSec = (Date.now() - new Date(lastDeployed).getTime()) / 1000;
      if (ageSec < minSpacingSec) {
        const eta = Math.ceil(minSpacingSec - ageSec);
        _telemetry.last_retrain_reason = `spacing_not_elapsed`;
        _telemetry.next_retrain_eta_sec = eta;
        _telemetry.last_retrain_at = new Date(lastDeployed).toISOString();
        return;
      }
    }

    // Условия выполнены — передаём реальные rows, не только count.
    const realRows = await _datasetRows();
    const r = await dspy.retrain({ niche: null, dryRun: false, realRows });
    const body = r && r.body && typeof r.body === 'object' ? r.body : (r || {});
    _telemetry.last_retrain_at = new Date().toISOString();
    _telemetry.last_retrain_ok = Boolean(r && r.ok && body.last_status === 'deployed');
    _telemetry.last_retrain_reason = body.last_status === 'deployed'
      ? 'deployed'
      : String(body.reason || body.last_status || r.reason || 'retrain_not_deployed');
    _telemetry.next_retrain_eta_sec = minSpacingSec;
    if (r && r.ok && body.last_status === 'deployed' && body.artifact_path) {
      await db.query(
        `INSERT INTO aegis_brain_versions
          (yaml_path, sha, mean_spq_before, mean_spq_after, improvement_pct,
           trials_done, dataset_size, cost_usd, deployed_at, notes,
           status, artifact_sha, artifact_type, holdout_score, evaluation, deployed_by)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, NULL, NOW(), $7,
                 'deployed', $8, 'dspy_compiled', $9, $10::jsonb, 'aegis_auto_retrain')`,
        [body.artifact_path, body.mean_spq_before || null, body.mean_spq_after || null,
         body.improvement_pct || null, body.max_trials || null, body.dataset_size || null,
         JSON.stringify({ model: body.model || null, mutation_kind: body.mutation_kind || null }),
         body.artifact_sha || null, body.mean_spq_after == null ? null : Number(body.mean_spq_after),
         JSON.stringify({ holdout_size: body.holdout_size || null, reason: 'holdout_gate_passed' })],
      ).catch((e) => console.warn('[aegis/dspyAutoRetrain] version persist failed:', e.message));
    }
  } catch (e) {
    _telemetry.last_retrain_ok = false;
    _telemetry.last_retrain_reason = `error:${e.message}`;
    console.warn('[aegis/dspyAutoRetrain] tick failed:', e.message);
  } finally {
    _running = false;
  }
}

function startDspyAutoRetrain() {
  if (_timer) return;
  const flags = getAegisFlags().dspy || {};
  const intervalSec = Number(flags.autoRetrainCheckIntervalSec) || 3600;
  _timer = setInterval(() => {
    tick().catch((e) => console.warn('[aegis/dspyAutoRetrain] interval:', e.message));
  }, intervalSec * 1000);
  _timer.unref?.();
  // первый тик — отложенно, чтобы дать app.listen завершиться
  setTimeout(() => tick().catch(() => {}), 15_000).unref?.();
}

function stopDspyAutoRetrain() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = { startDspyAutoRetrain, stopDspyAutoRetrain, tick, getDspyAutoTelemetry };
