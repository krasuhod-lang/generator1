const db = require('../../config/db');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuidOrNull(value) {
  const text = String(value || '').trim();
  return UUID_RE.test(text) ? text : null;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * Stores one real external API attempt for admin reconciliation.
 * This is intentionally best-effort: an observability failure must never fail
 * the generation pipeline or change its token/cost semantics.
 */
async function recordApiRequest({
  provider,
  model = null,
  pipeline = null,
  stageName = null,
  callLabel = null,
  taskId = null,
  traceTaskId = null,
  requestStatus = 'success',
  httpStatus = null,
  attempt = 1,
  durationMs = null,
  promptSize = null,
  tokensIn = 0,
  tokensOut = 0,
  cachedTokens = 0,
  cacheHitTokens = 0,
  cacheMissTokens = 0,
  thoughtsTokens = 0,
  inputCostUsd = 0,
  outputCostUsd = 0,
  costUsd = 0,
  errorCode = null,
  errorMessage = null,
  meta = {},
}) {
  if (!provider) return false;
  try {
    await db.query(
      `INSERT INTO admin_api_request_ledger
         (provider, model, pipeline, stage_name, call_label, task_id,
          trace_task_id, request_status, http_status, attempt, duration_ms,
          prompt_size, tokens_in, tokens_out, cached_tokens, cache_hit_tokens,
          cache_miss_tokens, thoughts_tokens, input_cost_usd, output_cost_usd,
          cost_usd, error_code, error_message, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [
        String(provider).slice(0, 64),
        model ? String(model).slice(0, 160) : null,
        pipeline ? String(pipeline).slice(0, 64) : null,
        stageName ? String(stageName).slice(0, 160) : null,
        callLabel ? String(callLabel).slice(0, 200) : null,
        uuidOrNull(taskId),
        uuidOrNull(traceTaskId),
        String(requestStatus || 'success').slice(0, 32),
        Number.isFinite(Number(httpStatus)) ? Number(httpStatus) : null,
        Math.max(1, Math.trunc(finiteNumber(attempt, 1))),
        durationMs == null ? null : Math.max(0, Math.trunc(finiteNumber(durationMs))),
        promptSize == null ? null : Math.max(0, Math.trunc(finiteNumber(promptSize))),
        Math.max(0, Math.trunc(finiteNumber(tokensIn))),
        Math.max(0, Math.trunc(finiteNumber(tokensOut))),
        Math.max(0, Math.trunc(finiteNumber(cachedTokens))),
        Math.max(0, Math.trunc(finiteNumber(cacheHitTokens))),
        Math.max(0, Math.trunc(finiteNumber(cacheMissTokens))),
        Math.max(0, Math.trunc(finiteNumber(thoughtsTokens))),
        finiteNumber(inputCostUsd),
        finiteNumber(outputCostUsd),
        finiteNumber(costUsd),
        errorCode ? String(errorCode).slice(0, 120) : null,
        errorMessage ? String(errorMessage).slice(0, 1000) : null,
        JSON.stringify(meta && typeof meta === 'object' ? meta : {}),
      ],
    );
    return true;
  } catch (error) {
    console.error('[adminApiLedger] failed to persist API event:', error.message);
    return false;
  }
}

module.exports = { recordApiRequest, uuidOrNull };
