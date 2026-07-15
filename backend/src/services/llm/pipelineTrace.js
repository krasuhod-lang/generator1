'use strict';

const db = require('../../config/db');

function normalizeInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function normalizeScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n * 100) / 100));
}

/**
 * recordTrace — fail-open запись LLM/quality trace в pipeline_traces.
 *
 * Используется как центральная телеметрия поверх task_stages: любые ошибки БД
 * только логируются warn'ом и никогда не блокируют генерацию/публикацию.
 */
async function recordTrace({
  stage,
  pipeline = 'seo',
  taskId,
  model,
  promptVersion,
  inputTokens,
  outputTokens,
  durationMs,
  qualityScore,
  triggeredRefine = false,
} = {}) {
  if (!taskId && !stage) return null;
  try {
    await db.query(
      `INSERT INTO pipeline_traces
         (stage, pipeline, task_id, model, prompt_version,
          input_tokens, output_tokens, duration_ms, quality_score, triggered_refine)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        stage || null,
        pipeline || 'seo',
        taskId == null ? null : String(taskId),
        model || null,
        promptVersion || null,
        normalizeInt(inputTokens),
        normalizeInt(outputTokens),
        normalizeInt(durationMs),
        normalizeScore(qualityScore),
        !!triggeredRefine,
      ],
    );
  } catch (err) {
    console.warn(`[pipelineTrace] recordTrace failed: ${err.message}`);
  }
  return null;
}

module.exports = { recordTrace };
