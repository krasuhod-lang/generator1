'use strict';

/**
 * aegis/ga4Client — клиент к GA4 Reporting API v1 для контура
 * Reinforcement Learning (PPO-веса в DSPy выборке).
 *
 * Графейс-деградирует: если AEGIS_GA4_PROPERTY_ID или сервисный аккаунт
 * не настроены — возвращает { ok:false, reason:'not_configured' } и
 * НЕ бросает ошибку. RL-контур в этом случае откатывается на uniform
 * веса (=1 для всех статей).
 *
 * Без новых deps: запрос через нативный https, OAuth2 через JWT
 * (RS256) делегируется в aegis_py (`/ga4/fetch`) — чтобы не тянуть
 * google-auth-library в Node. Если aegis_py не доступен — возвращаем
 * not_configured.
 */

const { getAegisFlags } = require('./featureFlags');
const http = require('./_httpClient');

function _opts() {
  const cfg = getAegisFlags().rlGa4;
  return {
    base:       getAegisFlags().graphrag.pyServiceUrl,
    propertyId: cfg.propertyId,
    saJson:     cfg.serviceAccountJson,
    enabled:    cfg.enabled,
    topQuantile: cfg.topCtrQuantile,
    ppoWeight:  cfg.ppoWeight,
  };
}

/**
 * fetchPageMetrics({ pagePaths, dateRange? }) — агрегированные метрики
 * GA4 (sessions, averageSessionDuration, engagementRate) по списку
 * URL-путей за указанный период (по умолчанию — последние 14 дней).
 *
 * @returns {Promise<{ok:boolean, items:Array<{pagePath:string, sessions:number,
 *   avgSessionDurationSec:number, engagementRate:number}>}>}
 */
async function fetchPageMetrics({ pagePaths = [], dateRange = '14daysAgo' } = {}) {
  const { base, propertyId, enabled } = _opts();
  if (!enabled || !propertyId) return { ok: false, reason: 'not_configured', items: [] };
  if (!pagePaths.length) return { ok: true, items: [] };
  const r = await http.post(base, '/ga4/fetch', {
    property_id: propertyId,
    page_paths:  pagePaths,
    date_range:  dateRange,
  }, { timeoutMs: 30_000 });
  if (!r.ok) return { ok: false, reason: r.reason, items: [] };
  return { ok: true, items: (r.body && r.body.items) || [] };
}

/**
 * computePpoWeights(items, opts?) — детерминированная функция в Node,
 * перепакованная из RL-логики aegis_py для удобства тестирования.
 *
 * Берёт массив { pagePath, engagementRate (CTR-прокси) } и для каждой
 * страницы решает PPO-вес: если CTR ≥ top-quantile (default 0.75) →
 * weight = ppoWeight (default 3), иначе 1.
 */
function computePpoWeights(items, opts = {}) {
  const cfg = _opts();
  const q   = Number.isFinite(opts.topQuantile) ? opts.topQuantile : cfg.topQuantile;
  const w   = Number.isFinite(opts.ppoWeight)   ? opts.ppoWeight   : cfg.ppoWeight;

  const ctrs = (items || []).map((it) => Number(it.engagementRate)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!ctrs.length) return (items || []).map((it) => ({ pagePath: it.pagePath, ppo_weight: 1 }));
  const idx = Math.min(ctrs.length - 1, Math.floor(q * ctrs.length));
  const threshold = ctrs[idx];

  return items.map((it) => {
    const c = Number(it.engagementRate);
    return {
      pagePath: it.pagePath,
      engagementRate: Number.isFinite(c) ? c : null,
      ppo_weight: Number.isFinite(c) && c >= threshold ? w : 1,
    };
  });
}

module.exports = { fetchPageMetrics, computePpoWeights };
