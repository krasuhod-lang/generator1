'use strict';

const crypto = require('crypto');
const db = require('../../config/db');
const { getAegisFlags } = require('./featureFlags');
const dspyClient = require('./dspyClient');
const { buildPromptMeta } = require('./promptAudit');

const MAX_PROMPT_CHARS = 4000;
const AUTO_RETRAIN_EVERY = 50;
const AUTO_RETRAIN_COOLDOWN_MS = 60 * 60 * 1000;

let _lastRetrainAt = 0;

function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function _hashUser(userId) {
  if (!userId) return null;
  return crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 16);
}

function _passesGate(qualityScore) {
  const flags = getAegisFlags().qualityGate;
  const overall = _num(qualityScore && qualityScore.overall);
  if (overall == null || overall < flags.minOverall) return false;

  const subs = qualityScore && qualityScore.subscores || {};
  const eeat = _num(subs.eeat);
  const factCheck = _num(subs.fact_check);
  const plagiarism = _num(subs.plagiarism);
  const eeatSafe = eeat == null ? overall : eeat;
  const factSafe = factCheck == null ? overall : factCheck;
  const plagSafe = plagiarism == null ? overall : plagiarism;

  if (eeatSafe < flags.minSub.eeat) return false;
  if (factSafe < flags.minSub.fact_check) return false;
  if (plagSafe < flags.minSub.plagiarism) return false;
  return true;
}

async function _maybeTriggerRetrain() {
  if (!getAegisFlags().dspy.enabled) return;
  if (Date.now() - _lastRetrainAt < AUTO_RETRAIN_COOLDOWN_MS) return;

  try {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n
         FROM aegis_dspy_dataset
        WHERE used_in_retrain IS NULL AND is_seed = FALSE`,
    );
    const pending = Number(rows[0] && rows[0].n) || 0;
    if (pending < AUTO_RETRAIN_EVERY) return;

    _lastRetrainAt = Date.now();
    dspyClient.retrain({ niche: null, dryRun: false }).catch((e) => {
      console.warn('[aegis/datasetWriter] auto-retrain failed:', e.message);
    });
  } catch (e) {
    console.warn('[aegis/datasetWriter] pending rows read failed:', e.message);
  }
}

async function recordTrainingExample({
  articleRef,
  kind,
  niche,
  userPrompt,
  htmlOutput,
  qualityScore,
  feedbackMetrics,
  gaMetrics, // deprecated alias for feedbackMetrics (обратная совместимость)
  modelUsed,
  costUsd,
  userId,
  promptHash = null,
  promptMeta = null,
}) {
  if (!articleRef || !kind || !qualityScore || !htmlOutput) return { ok: false, reason: 'invalid_payload' };
  if (!_passesGate(qualityScore)) return { ok: false, reason: 'quality_gate_reject' };

  const promptSafe = String(userPrompt || '').slice(0, MAX_PROMPT_CHARS);
  const feedback = feedbackMetrics != null ? feedbackMetrics : (gaMetrics != null ? gaMetrics : null);
  const linkage = promptHash
    ? { prompt_hash: promptHash, prompt_meta: promptMeta || {} }
    : buildPromptMeta({ kind, userPrompt });
  const spqOverall = _num(qualityScore.overall);
  if (spqOverall == null) return { ok: false, reason: 'invalid_overall' };

  try {
    await db.query(
      `INSERT INTO aegis_dspy_dataset
         (article_ref, niche, user_prompt, html_output, quality_score,
          spq_overall, ppo_weight, feedback_metrics, model_used, cost_usd,
          user_hash, source_kind, prompt_hash, prompt_meta)
       VALUES ($1, $2, $3, $4, $5::jsonb,
               $6, 1.0, $7::jsonb, $8, $9,
               $10, $11, $12, $13::jsonb)
       ON CONFLICT (article_ref)
       DO UPDATE SET
         niche = EXCLUDED.niche,
         user_prompt = EXCLUDED.user_prompt,
         html_output = EXCLUDED.html_output,
         quality_score = EXCLUDED.quality_score,
         spq_overall = EXCLUDED.spq_overall,
         feedback_metrics = EXCLUDED.feedback_metrics,
         model_used = EXCLUDED.model_used,
         cost_usd = EXCLUDED.cost_usd,
         user_hash = EXCLUDED.user_hash,
         source_kind = EXCLUDED.source_kind,
         prompt_hash = EXCLUDED.prompt_hash,
         prompt_meta = EXCLUDED.prompt_meta`,
      [
        String(articleRef),
        niche || null,
        promptSafe,
        String(htmlOutput),
        JSON.stringify(qualityScore || {}),
        spqOverall,
        feedback ? JSON.stringify(feedback) : null,
        modelUsed || null,
        _num(costUsd),
        _hashUser(userId),
        String(kind),
        linkage.prompt_hash || null,
        JSON.stringify(linkage.prompt_meta || {}),
      ],
    );
  } catch (e) {
    return { ok: false, reason: 'db_error', error: e.message };
  }

  _maybeTriggerRetrain().catch(() => {});
  return { ok: true };
}

module.exports = { recordTrainingExample, _passesGate, _hashUser };
