'use strict';

/**
 * aegis/internalSensors.js — слой сенсоров «мозг Эгиды на наших продуктах».
 *
 * Задача 2: каждый завершённый анализ проекта и каждый новый snapshot
 * (через N дней) превращаются в observation для будущего обучения
 * рекомендательного модуля. Внешний RAG-контент в эту таблицу не попадает.
 *
 * Все функции — no-op, если featureFlags.brain.internalLearning = false.
 * Если у проекта снят чекбокс contribute_to_brain — observation тоже
 * не пишется (см. опт-аут на уровне проекта).
 *
 * Все записи помечены scope = 'internal_product', чтобы при тренировке
 * DSPy легко отфильтровать ровно «наши» данные (см. поле
 * aegis_dspy_dataset.aegis_source_scope, миграция 093).
 *
 * Тесты: backend/scripts/test-aegis-internal-sensors.js (с моком db).
 */

const db = require('../../config/db');
const { getAegisFlags } = require('./featureFlags');
const reward = require('./rewardCalculator');

function _enabled() {
  try {
    const f = getAegisFlags();
    return !!(f && f.brain && f.brain.internalLearning);
  } catch (_) { return false; }
}

/**
 * Чистая функция: вытащить компактные числовые features из gsc_snapshot
 * (без бренд-имён/URL-ов — анонимизация на уровне «голые цифры»).
 * Что попадает: KPI-сводка, размер action_plan, среднее по striking_distance,
 * intent_split в процентах. Если поля нет — пропускаем.
 */
function extractFeatures(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const f = {};
  if (snapshot.kpi && typeof snapshot.kpi === 'object') {
    f.kpi = {
      clicks:      Number(snapshot.kpi.clicks)      || 0,
      impressions: Number(snapshot.kpi.impressions) || 0,
      ctr:         Number(snapshot.kpi.ctr)         || 0,
      position:    Number(snapshot.kpi.position)    || 0,
    };
  }
  if (snapshot.action_plan && snapshot.action_plan.recommendations) {
    f.action_plan_size = Array.isArray(snapshot.action_plan.recommendations)
      ? snapshot.action_plan.recommendations.length : 0;
  }
  if (snapshot.insights && snapshot.insights.intent_split) {
    f.intent_split = snapshot.insights.intent_split;
  }
  if (snapshot.insights && snapshot.insights.striking_distance) {
    const sd = snapshot.insights.striking_distance;
    f.striking_distance_count = Array.isArray(sd) ? sd.length : 0;
  }
  return Object.keys(f).length ? f : null;
}

/**
 * Чистая функция: компактный список «что было рекомендовано».
 * Берём только тип и численные ожидания, без текста рекомендации.
 */
function extractRecommendation(snapshot) {
  if (!snapshot || !snapshot.action_plan || !Array.isArray(snapshot.action_plan.recommendations)) {
    return null;
  }
  const items = snapshot.action_plan.recommendations.map((r) => ({
    kind: r && r.kind ? String(r.kind).slice(0, 64) : 'unknown',
    expected_clicks: Number((r && r.expected_clicks_gain) || 0) || 0,
    priority: r && r.priority ? String(r.priority).slice(0, 16) : null,
  }));
  return { items, count: items.length };
}

function extractPredictedKpi(snapshot) {
  if (!snapshot || !snapshot.action_plan) return null;
  const ap = snapshot.action_plan;
  const summary = ap.summary || {};
  return {
    expected_clicks: Number(summary.expected_clicks_total) || 0,
    expected_traffic_uplift_pct: Number(summary.expected_traffic_uplift_pct) || 0,
  };
}

/**
 * Записывает observation по только что завершённому анализу.
 * Безопасна для production: если фича-флаг выключен или БД упала —
 * возвращает {skipped:true} и НЕ бросает исключение (это асинхронный
 * хук, который не должен ронять основной processAnalysis).
 *
 *   { projectId, analysisId, snapshot, costUsd }
 *
 * Возвращает { id, skipped, reason? }.
 */
async function recordAnalysisObservation({ projectId, analysisId, snapshot, costUsd = 0 }, dbInstance = db) {
  if (!_enabled())  return { skipped: true, reason: 'flag_off' };
  if (!projectId)   return { skipped: true, reason: 'no_project' };
  try {
    // Проверяем опт-аут проекта.
    const { rows: pRows } = await dbInstance.query(
      `SELECT contribute_to_brain FROM projects WHERE id = $1`, [projectId],
    );
    if (!pRows.length) return { skipped: true, reason: 'project_not_found' };
    if (pRows[0].contribute_to_brain === false) return { skipped: true, reason: 'opted_out' };

    const features       = extractFeatures(snapshot);
    const recommendation = extractRecommendation(snapshot);
    const predicted      = extractPredictedKpi(snapshot);
    if (!features && !recommendation) return { skipped: true, reason: 'no_signal' };

    const { rows } = await dbInstance.query(
      `INSERT INTO aegis_internal_observations
         (project_id, analysis_id, source, features, recommendation, predicted_kpi,
          scope, contribute)
       VALUES ($1, $2, 'project_analysis', $3::jsonb, $4::jsonb, $5::jsonb,
          'internal_product', TRUE)
       RETURNING id, taken_at`,
      [
        projectId, analysisId || null,
        features       ? JSON.stringify(features)       : null,
        recommendation ? JSON.stringify(recommendation) : null,
        predicted      ? JSON.stringify({ ...predicted, cost_usd: Number(costUsd) || 0 }) : null,
      ],
    );
    return { id: rows[0].id, taken_at: rows[0].taken_at, skipped: false };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[internalSensors] recordAnalysisObservation failed:', e.message);
    return { skipped: true, reason: 'error', error: e.message };
  }
}

/**
 * Подтягивает outcome для observation: рассчитывает delta между фичами
 * observation и переданным «свежим» snapshot, считает reward, апдейтит запись.
 * Возвращает { id, reward } или {skipped:true}.
 */
async function updateObservationOutcome(observationId, freshSnapshot, dbInstance = db) {
  if (!_enabled())     return { skipped: true, reason: 'flag_off' };
  if (!observationId)  return { skipped: true, reason: 'no_id' };
  try {
    const { rows } = await dbInstance.query(
      `SELECT id, features, predicted_kpi FROM aegis_internal_observations WHERE id = $1`,
      [observationId],
    );
    if (!rows.length) return { skipped: true, reason: 'not_found' };
    const obs = rows[0];
    const oldFeatures = obs.features || {};
    const newFeatures = extractFeatures(freshSnapshot) || {};
    const oldKpi = (oldFeatures && oldFeatures.kpi) || {};
    const newKpi = (newFeatures && newFeatures.kpi) || {};
    const deltaClicks   = (Number(newKpi.clicks)   || 0) - (Number(oldKpi.clicks)   || 0);
    const deltaPosition = (Number(newKpi.position) || 0) - (Number(oldKpi.position) || 0);
    const budgetUsd     = Number((obs.predicted_kpi || {}).cost_usd) || 0;
    const { reward: r, breakdown } = reward.computeProjectReward({
      deltaClicks,
      deltaPosition,
      spq:           0,
      ctrGapClosed:  0,
      budgetUsd,
    });
    const outcome = {
      kpi:           newKpi,
      delta_clicks:  deltaClicks,
      delta_position: deltaPosition,
      reward_breakdown: breakdown,
    };
    await dbInstance.query(
      `UPDATE aegis_internal_observations
          SET outcome = $1::jsonb, reward = $2, outcome_at = NOW()
        WHERE id = $3`,
      [JSON.stringify(outcome), r, observationId],
    );
    return { id: observationId, reward: r, skipped: false };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[internalSensors] updateObservationOutcome failed:', e.message);
    return { skipped: true, reason: 'error', error: e.message };
  }
}

/**
 * Краткая сводка для админского дашборда «Brain training health».
 * Возвращает { total, with_outcome, avg_reward, latest_taken_at }.
 */
async function getBrainHealth(dbInstance = db) {
  try {
    const { rows } = await dbInstance.query(
      `SELECT
         COUNT(*)::int                                              AS total,
         COUNT(*) FILTER (WHERE outcome IS NOT NULL)::int           AS with_outcome,
         AVG(reward)::numeric                                       AS avg_reward,
         MAX(taken_at)                                              AS latest_taken_at
       FROM aegis_internal_observations
       WHERE scope = 'internal_product' AND contribute = TRUE`,
    );
    return rows[0] || { total: 0, with_outcome: 0, avg_reward: null, latest_taken_at: null };
  } catch (e) {
    return { total: 0, with_outcome: 0, avg_reward: null, latest_taken_at: null, error: e.message };
  }
}

module.exports = {
  recordAnalysisObservation,
  updateObservationOutcome,
  getBrainHealth,
  // экспорт чистых функций для тестов
  extractFeatures,
  extractRecommendation,
  extractPredictedKpi,
  _enabled,
};
