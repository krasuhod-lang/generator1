'use strict';

/**
 * aegis/qualityLogWriter — writer для «теневого» датасета aegis_quality_log
 * и одновременной записи в aegis_runs (Слои 1 и 2 плана).
 *
 * В отличие от datasetWriter.recordTrainingExample (узкий «золотой» writer,
 * который пишет в aegis_dspy_dataset только статьи с SPQ ≥ 80), этот модуль
 * пишет КАЖДУЮ генерацию — независимо от прохождения гейта качества.
 *
 * Используется в 4 пайплайнах (info_article, link_article, meta_tags,
 * article_topics) рядом с вызовом recordTrainingExample, чтобы:
 *   • дашборд «Последние запуски» оживал и показывал все прогоны;
 *   • Discovery-карточка «Топ причин провалов» имела источник данных;
 *   • будущий Lessons-репозиторий (слой 4 плана) мог агрегировать причины.
 *
 * Никаких side-effects, кроме INSERT'ов; ошибки БД логируются и не бросаются
 * выше (best-effort), чтобы не ронять основную задачу из-за телеметрии.
 */

const crypto = require('crypto');
const db = require('../../config/db');
const { getAegisFlags } = require('./featureFlags');
const { analyzeFailures } = require('./failureAnalyzer');
const { _passesGate } = require('./datasetWriter');

function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function _hashUser(userId) {
  if (!userId) return null;
  return crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 16);
}

function _resolveStatus({ passes, qualityScore }) {
  if (passes) return 'success';
  const overall = _num(qualityScore && qualityScore.overall);
  if (overall == null) return 'failed';
  // 60..80 — refiner мог бы получить шанс (слой 10 плана), пока просто метим.
  if (overall >= 60) return 'needs_refine';
  return 'rejected_by_gate';
}

/**
 * recordQualityLog — главный экспорт.
 *
 * @param {Object} args
 * @param {string} args.articleRef    — уникальный ID статьи (info_article:<uuid>).
 * @param {string} args.kind          — info_article | link_article | meta_tags | article_topics.
 * @param {string|null} args.niche
 * @param {Object} args.qualityScore  — выход computeQualityScore.
 * @param {Object} args.reports       — { eeat_audit, fact_check_report, ... }.
 * @param {string|null} args.modelUsed
 * @param {number|null} args.costUsd
 * @param {number} [args.iterations]  — сколько раз гоняли refine-loop (default 1).
 * @param {string|null} [args.taskRef] — task uuid (для FK в aegis_runs.task_ref).
 * @param {string|null} [args.userId]
 * @returns {Promise<{ ok: boolean, reason?: string, error?: string, status?: string }>}
 */
async function recordQualityLog({
  articleRef,
  kind,
  niche,
  qualityScore,
  reports,
  modelUsed,
  costUsd,
  iterations,
  taskRef,
  userId,
} = {}) {
  if (!articleRef || !kind) return { ok: false, reason: 'invalid_payload' };

  let flags;
  try {
    flags = getAegisFlags();
  } catch (_) {
    flags = null;
  }
  const enabled = !flags || !flags.qualityLog || flags.qualityLog.enabled !== false;
  if (!enabled) return { ok: false, reason: 'disabled' };

  const passes = (() => {
    try { return _passesGate(qualityScore); } catch (_) { return false; }
  })();

  const diagnoses = analyzeFailures({
    reports: reports || {},
    qualityScore: qualityScore || {},
  });

  const subs = (qualityScore && qualityScore.subscores) || {};
  const overall = _num(qualityScore && qualityScore.overall);
  const itersSafe = Number.isFinite(iterations) && iterations > 0
    ? Math.floor(iterations) : 1;
  const status = _resolveStatus({ passes, qualityScore });
  const userHash = _hashUser(userId);
  const cost = _num(costUsd);

  // ── 1. aegis_quality_log (теневой датасет) ────────────────────────
  try {
    await db.query(
      `INSERT INTO aegis_quality_log
         (article_ref, kind, niche, spq_overall, sub, verdict_summary,
          failure_reasons, top_failure_layer, diagnoses, status, passes_gate,
          model_used, cost_usd, iterations, user_hash)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb,
               $7::jsonb, $8, $9::jsonb, $10, $11,
               $12, $13, $14, $15)
       ON CONFLICT (article_ref)
       DO UPDATE SET
         kind              = EXCLUDED.kind,
         niche             = EXCLUDED.niche,
         spq_overall       = EXCLUDED.spq_overall,
         sub               = EXCLUDED.sub,
         verdict_summary   = EXCLUDED.verdict_summary,
         failure_reasons   = EXCLUDED.failure_reasons,
         top_failure_layer = EXCLUDED.top_failure_layer,
         diagnoses         = EXCLUDED.diagnoses,
         status            = EXCLUDED.status,
         passes_gate       = EXCLUDED.passes_gate,
         model_used        = EXCLUDED.model_used,
         cost_usd          = EXCLUDED.cost_usd,
         iterations        = EXCLUDED.iterations,
         user_hash         = EXCLUDED.user_hash`,
      [
        String(articleRef),
        String(kind),
        niche || null,
        overall,
        JSON.stringify(subs || {}),
        JSON.stringify(diagnoses.verdict_summary || {}),
        JSON.stringify(diagnoses.failure_reasons || []),
        diagnoses.top_failure_layer || null,
        JSON.stringify({ symptoms: diagnoses.symptoms || [] }),
        status,
        Boolean(passes),
        modelUsed || null,
        cost,
        itersSafe,
        userHash,
      ],
    );
  } catch (e) {
    console.warn('[aegis/qualityLogWriter] quality_log insert failed:', e.message);
    // Не возвращаем здесь — пробуем хотя бы aegis_runs.
  }

  // ── 2. aegis_runs (оживить «нерезанную ниточку») ──────────────────
  try {
    await db.query(
      `INSERT INTO aegis_runs
         (kind, task_ref, niche, status, overall_score, iterations,
          cost_usd, audit, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6,
               $7, $8::jsonb, NOW())`,
      [
        String(kind),
        taskRef || articleRef,
        niche || null,
        status,
        overall,
        itersSafe,
        cost == null ? 0 : cost,
        JSON.stringify({
          subscores:         subs,
          verdict_summary:   diagnoses.verdict_summary,
          failure_reasons:   diagnoses.failure_reasons,
          top_failure_layer: diagnoses.top_failure_layer,
          passes_gate:       Boolean(passes),
          model_used:        modelUsed || null,
        }),
      ],
    );
  } catch (e) {
    console.warn('[aegis/qualityLogWriter] aegis_runs insert failed:', e.message);
  }

  return { ok: true, status, passes_gate: passes };
}

module.exports = {
  recordQualityLog,
  _resolveStatus,
};
