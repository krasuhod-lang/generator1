'use strict';

/**
 * aegis/serpOutcomeTracker (B1) — замыкаем петлю обучения Bio-Brain на
 * реальный результат в выдаче Google.
 *
 * Поток:
 *   1) recordPublication({ url, queries, features, featureLabels, projectId })
 *      — при публикации статьи кладём 8D вектор фич + URL + запросы в
 *      `aegis_serp_outcomes` со status='pending'.
 *   2) Через measureAfterDays (см. featureFlags.serpOutcomes) другой шаг
 *      (admin-эндпоинт или scheduled job) вызывает closeOutcome(id, gscMetrics)
 *      — мы считаем reward 0..1 по формуле в featureFlags.serpOutcomes.rewardWeights
 *      и пушим в biobrainClient.feedback({ features, real_spq_overall: reward * 100 }).
 *   3) status переходит pending → measured → fed.
 *
 * Этот сервис намеренно НЕ читает GSC напрямую — это делает gscService
 * в backend/src/services/projects/. Здесь — только инфраструктура хранения
 * + reward-функция + мост в biobrain.feedback.
 *
 * Без новых ENV.
 */

const crypto = require('crypto');
const { getAegisFlags } = require('./featureFlags');
const biobrainClient = require('./biobrainClient');

let _db = null;
function setDbConnection(db) { _db = db; }

/**
 * Записать публикацию в очередь будущих измерений.
 *
 * @param {Object} p
 * @param {string} p.url           канонический URL опубликованной страницы
 * @param {string[]} p.queries     запросы, под которые она оптимизирована
 * @param {number[]} p.features    8D вектор фич биомозга (см. feature_vector.py)
 * @param {string[]} [p.featureLabels] параллельный массив имён фич
 * @param {string} [p.projectId]   UUID связанного проекта
 * @param {string} [p.outcomeKey]  idempotency key for one publication/version
 * @param {string} [p.taskId]      generation task id
 * @param {string} [p.opportunityId] linked growth opportunity
 * @param {object} [p.baselineMetrics] baseline GSC/Yandex metrics
 * @param {string} [p.promptVersion] prompt/brain version
 * @param {string} [p.modelVersion] model version
 * @returns {Promise<{ok:boolean, id?:number, reason?:string}>}
 */
async function recordPublication(p) {
  const flags = getAegisFlags().serpOutcomes || {};
  if (!flags.enabled) return { ok: false, reason: 'disabled' };
  if (!_db) return { ok: false, reason: 'db_not_wired' };
  if (!p || !p.url || !Array.isArray(p.queries) || p.queries.length === 0 || !Array.isArray(p.features)) {
    return { ok: false, reason: 'invalid_input' };
  }
  const outcomeKey = String(p.outcomeKey || crypto.createHash('sha256')
    .update(`${p.taskId || ''}|${p.url}|${p.promptVersion || ''}|${p.modelVersion || ''}`)
    .digest('hex')).slice(0, 200);
  const measureDays = Math.max(1, Number(flags.measureAfterDays) || 14);
  try {
    const r = await _db.query(
      `INSERT INTO aegis_serp_outcomes
          (outcome_key, url, queries, features, feature_labels, project_id,
           measure_after_at, task_id, opportunity_id, prompt_version,
           model_version, baseline_metrics)
        VALUES ($1, $2, $3, $4::real[], $5, $6,
                NOW() + ($7::int * INTERVAL '1 day'), $8, $9, $10, $11, $12::jsonb)
        ON CONFLICT (outcome_key) DO NOTHING
        RETURNING id`,
      [outcomeKey, p.url, p.queries, p.features.map(Number),
       Array.isArray(p.featureLabels) ? p.featureLabels : [], p.projectId || null,
       measureDays, p.taskId || null, p.opportunityId || null,
       p.promptVersion || null, p.modelVersion || null,
       JSON.stringify(p.baselineMetrics || {})]
    );
    if (r.rows && r.rows[0]) return { ok: true, id: r.rows[0].id, deduplicated: false };
    const existing = await _db.query(
      `SELECT id, status FROM aegis_serp_outcomes WHERE outcome_key = $1 LIMIT 1`,
      [outcomeKey],
    );
    return { ok: true, id: existing.rows[0] && existing.rows[0].id, deduplicated: true,
      status: existing.rows[0] && existing.rows[0].status };
  } catch (e) {
    console.warn('[aegis/serpOutcomeTracker] recordPublication:', e.message);
    return { ok: false, reason: 'db_error', error: e.message };
  }
}

/**
 * Подсчитать reward 0..1 из реальных метрик SERP.
 *
 * @param {Object} m
 * @param {number} [m.avgPosition]   средняя позиция (1=top, 100=плохо)
 * @param {number} [m.bestPosition]
 * @param {number} [m.inTop3]        счётчик попаданий в top-3
 * @param {number} [m.inTop10]
 * @param {number} [m.deltaClicks]   PoP Δclicks
 */
function computeReward(m) {
  const flags = getAegisFlags().serpOutcomes || {};
  const w = (flags.rewardWeights) || { position: 0.4, top10: 0.2, top3: 0.2, clicks: 0.2 };

  // Position score: монотонно убывающая функция позиции.
  // pos=1 → 1.0, pos=10 → ~0.55, pos=20 → ~0.3, pos≥50 → 0.
  let pos = Number(m && m.avgPosition);
  if (!Number.isFinite(pos)) pos = 50;
  pos = Math.max(1, Math.min(100, pos));
  const posScore = Math.max(0, 1.0 - Math.log10(pos) / 2.0);

  const top10Score = Number(m && m.inTop10) > 0 ? 1.0 : 0.0;
  const top3Score  = Number(m && m.inTop3)  > 0 ? 1.0 : 0.0;

  // Clicks: лог-нормализация. ΔCTR=0 → 0, ΔCTR=10 → ~0.5, ΔCTR=100 → 1.
  const dc = Number(m && m.deltaClicks);
  const clicksScore = Number.isFinite(dc) && dc > 0
    ? Math.min(1.0, Math.log10(1 + dc) / 2.0)
    : 0.0;

  const sum = w.position + w.top10 + w.top3 + w.clicks;
  const reward = (
    w.position * posScore +
    w.top10    * top10Score +
    w.top3     * top3Score +
    w.clicks   * clicksScore
  ) / Math.max(1e-6, sum);
  return Math.max(0, Math.min(1, Number(reward.toFixed(4))));
}

/**
 * Закрыть outcome: записать измерения, посчитать reward, отправить в biobrain.
 */
async function closeOutcome(id, metrics) {
  const flags = getAegisFlags().serpOutcomes || {};
  if (!flags.enabled) return { ok: false, reason: 'disabled' };
  if (!_db) return { ok: false, reason: 'db_not_wired' };
  const reward = computeReward(metrics || {});
  try {
    const r = await _db.query(
      `UPDATE aegis_serp_outcomes
          SET avg_position          = $2,
              best_position         = $3,
              in_top3               = COALESCE($4, in_top3),
              in_top10              = COALESCE($5, in_top10),
              delta_clicks          = $6,
              delta_ctr             = $7,
              reward                = $8,
              post_metrics          = $9::jsonb,
              sample_size           = $10,
              measured_source       = $11,
              measurement_attempts  = COALESCE(measurement_attempts, 0) + 1,
              next_attempt_at       = NULL,
              last_error            = NULL,
              measured_at           = NOW(),
              status                = 'measured'
        WHERE id = $1 AND status IN ('pending', 'measuring', 'measured')
        RETURNING id, url, features, feature_labels`,
      [id,
       _num(metrics.avgPosition), _num(metrics.bestPosition),
       _int(metrics.inTop3), _int(metrics.inTop10),
       _num(metrics.deltaClicks), _num(metrics.deltaCtr),
       reward, JSON.stringify(metrics || {}), _int(metrics.sampleSize),
       metrics.source ? String(metrics.source).slice(0, 40) : null]
    );
    if (!r || !r.rows || !r.rows.length) {
      return { ok: false, reason: 'not_found' };
    }
    const row = r.rows[0];
    // Замыкание петли: отправляем reward в biobrain.feedback.
    // graceful — если py-сервис недоступен, status остаётся 'measured'
    // и можно пере-запустить позже.
    try {
      const fb = await biobrainClient.feedback({
        features: Array.isArray(row.features) ? row.features.map(Number) : null,
        real_spq_overall: reward * 100,
      });
      if (fb && fb.ok) {
        await _db.query(`UPDATE aegis_serp_outcomes
          SET status='fed', feedback_next_attempt_at=NULL, feedback_last_error=NULL
          WHERE id=$1`, [id]);
      } else {
        await _scheduleFeedbackRetry(id, (fb && fb.reason) || 'feedback_not_accepted').catch(() => {});
      }
      return { ok: true, id, reward, fed: Boolean(fb && fb.ok) };
    } catch (e) {
      console.warn('[aegis/serpOutcomeTracker] biobrain feedback failed:', e.message);
      await _scheduleFeedbackRetry(id, e).catch(() => {});
      return { ok: true, id, reward, fed: false };
    }
  } catch (e) {
    console.warn('[aegis/serpOutcomeTracker] closeOutcome:', e.message);
    return { ok: false, reason: 'db_error', error: e.message };
  }
}

function _num(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

function _int(x) {
  const v = Number(x);
  return Number.isFinite(v) ? Math.round(v) : null;
}

async function _scheduleFeedbackRetry(id, error) {
  if (!_db || !id) return;
  await _db.query(
    `UPDATE aegis_serp_outcomes
        SET feedback_attempts = COALESCE(feedback_attempts, 0) + 1,
            feedback_next_attempt_at = NOW() +
              (LEAST(1440, 5 * (2 ^ LEAST(8, COALESCE(feedback_attempts, 0))))::int * INTERVAL '1 minute'),
            feedback_last_error = $2
      WHERE id = $1 AND status = 'measured'`,
    [id, String(error && (error.message || error.reason) || error || 'feedback_failed').slice(0, 1000)],
  );
}

async function retryMeasuredFeedback({ limit = 10 } = {}) {
  if (!_db) return { ok: false, reason: 'db_not_wired' };
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
  const { rows } = await _db.query(
    `WITH claim AS (
       SELECT id
         FROM aegis_serp_outcomes
        WHERE status = 'measured'
          AND (feedback_next_attempt_at IS NULL OR feedback_next_attempt_at <= NOW())
        ORDER BY measured_at ASC NULLS LAST
        FOR UPDATE SKIP LOCKED
        LIMIT $1
     )
     UPDATE aegis_serp_outcomes o
        SET feedback_next_attempt_at = NOW() + INTERVAL '5 minutes'
       FROM claim
      WHERE o.id = claim.id
      RETURNING o.id, o.features, o.reward`,
    [safeLimit],
  );
  let fed = 0;
  let failed = 0;
  for (const row of rows || []) {
    try {
      const fb = await biobrainClient.feedback({
        features: Array.isArray(row.features) ? row.features.map(Number) : null,
        real_spq_overall: Number.isFinite(Number(row.reward)) ? Number(row.reward) * 100 : null,
      });
      if (!fb || !fb.ok) throw new Error((fb && fb.reason) || 'feedback_not_accepted');
      await _db.query(
        `UPDATE aegis_serp_outcomes
            SET status = 'fed', feedback_next_attempt_at = NULL, feedback_last_error = NULL
          WHERE id = $1 AND status = 'measured'`,
        [row.id],
      );
      fed += 1;
    } catch (error) {
      failed += 1;
      await _scheduleFeedbackRetry(row.id, error).catch(() => {});
    }
  }
  return { ok: true, claimed: (rows || []).length, fed, failed };
}

/**
 * Записывает outcome только когда задача действительно имеет опубликованный
 * canonical URL и query set. Без URL/queries система не выдумывает публикацию.
 * Feature vector берётся из BioBrain predictor, поэтому feedback не получает
 * synthetic features при недоступном Python service.
 */
async function recordTaskPublication({
  taskId, kind, publishedUrl, queries, html, plain, projectId, opportunityId,
  promptVersion, modelVersion, baselineMetrics, qualitySignals,
} = {}) {
  if (!publishedUrl || !Array.isArray(queries) || queries.length === 0) {
    return { ok: false, reason: 'not_published_or_no_queries' };
  }
  let prediction;
  try {
    prediction = await biobrainClient.predict({
      text: html || plain || '',
      signals: qualitySignals || null,
    });
  } catch (e) {
    return { ok: false, reason: 'feature_vector_unavailable', error: e.message };
  }
  const features = prediction && Array.isArray(prediction.features)
    ? prediction.features.map(Number)
    : [];
  if (!prediction || !prediction.ok || features.length !== 8 || features.some((value) => !Number.isFinite(value))) {
    return { ok: false, reason: 'feature_vector_unavailable', detail: prediction && prediction.reason };
  }
  return recordPublication({
    outcomeKey: `task:${kind || 'content'}:${taskId || ''}:${promptVersion || ''}`,
    url: publishedUrl,
    queries: queries.map((q) => String(q).trim()).filter(Boolean).slice(0, 100),
    features,
    featureLabels: prediction.feature_labels || [],
    projectId,
    taskId,
    opportunityId,
    baselineMetrics,
    promptVersion,
    modelVersion,
  });
}

/** Список outcomes по статусу — для admin-UI «🎯 SERP-обучение». */
async function listOutcomes({ status = null, limit = 50, offset = 0 } = {}) {
  if (!_db) return { ok: false, reason: 'db_not_wired' };
  const params = [];
  let where = '';
  if (status) { params.push(status); where = `WHERE status = $${params.length}`; }
  params.push(Math.min(500, Math.max(1, Number(limit) || 50)));
  params.push(Math.max(0, Number(offset) || 0));
  const r = await _db.query(
    `SELECT id, url, queries, status, published_at, measured_at,
            avg_position, best_position, in_top3, in_top10,
            delta_clicks, reward, project_id
       FROM aegis_serp_outcomes
       ${where}
       ORDER BY published_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { ok: true, items: r.rows };
}

module.exports = {
  setDbConnection,
  recordPublication,
  recordTaskPublication,
  computeReward,
  closeOutcome,
  retryMeasuredFeedback,
  listOutcomes,
};
