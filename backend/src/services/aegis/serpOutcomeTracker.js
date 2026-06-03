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
 * @returns {Promise<{ok:boolean, id?:number, reason?:string}>}
 */
async function recordPublication(p) {
  const flags = getAegisFlags().serpOutcomes || {};
  if (!flags.enabled) return { ok: false, reason: 'disabled' };
  if (!_db) return { ok: false, reason: 'db_not_wired' };
  if (!p || !p.url || !Array.isArray(p.queries) || !Array.isArray(p.features)) {
    return { ok: false, reason: 'invalid_input' };
  }
  try {
    const r = await _db.query(
      `INSERT INTO aegis_serp_outcomes
          (url, queries, features, feature_labels, project_id)
        VALUES ($1, $2, $3::real[], $4, $5)
        ON CONFLICT (url, published_at) DO NOTHING
        RETURNING id`,
      [p.url, p.queries, p.features.map(Number),
       Array.isArray(p.featureLabels) ? p.featureLabels : [], p.projectId || null]
    );
    return { ok: true, id: r.rows && r.rows[0] && r.rows[0].id };
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
          SET avg_position  = $2,
              best_position = $3,
              in_top3       = COALESCE($4, in_top3),
              in_top10      = COALESCE($5, in_top10),
              delta_clicks  = $6,
              delta_ctr     = $7,
              reward        = $8,
              measured_at   = NOW(),
              status        = 'measured'
        WHERE id = $1
        RETURNING id, url, features, feature_labels`,
      [id,
       _num(metrics.avgPosition), _num(metrics.bestPosition),
       _int(metrics.inTop3), _int(metrics.inTop10),
       _num(metrics.deltaClicks), _num(metrics.deltaCtr),
       reward]
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
        await _db.query(`UPDATE aegis_serp_outcomes SET status='fed' WHERE id=$1`, [id]);
      }
      return { ok: true, id, reward, fed: Boolean(fb && fb.ok) };
    } catch (e) {
      console.warn('[aegis/serpOutcomeTracker] biobrain feedback failed:', e.message);
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
  computeReward,
  closeOutcome,
  listOutcomes,
};
