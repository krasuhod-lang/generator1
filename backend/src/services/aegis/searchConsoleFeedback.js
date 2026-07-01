'use strict';

/**
 * aegis/searchConsoleFeedback — источник per-URL CTR-сигнала для контура
 * Reinforcement Learning (PPO-веса в DSPy выборке).
 *
 * Заменяет прежний GA4-клиент: у нас нет и не предусмотрено Google Analytics,
 * поэтому реальный пользовательский сигнал (CTR/клики/показы по URL) берём из
 * уже интегрированных источников проекта:
 *   • Google Search Console — per-URL срез (dimension=page) через gscService;
 *   • Яндекс.Вебмастер     — host-level CTR через ydxService (Webmaster API не
 *                            отдаёт per-URL разрез, поэтому его вклад
 *                            учитывается на уровне хоста как общий приор).
 *
 * Оба источника сливаются в единый сигнал `{ pagePath, clicks, impressions,
 * ctr }` с CTR, взвешенным по показам между движками. Клиент graceful-
 * деградирует: если проект не подключён к источнику или источник выключен
 * флагом — он просто не участвует, ошибка не бросается. Если ни один источник
 * недоступен — возвращаем { ok:false, reason:'not_configured' }, и RL-контур
 * откатывается на uniform-веса (=1 для всех статей).
 *
 * Без новых зависимостей: переиспользуем gscService/ydxService, которые уже
 * управляют OAuth-токенами проекта.
 *
 * Тесты: backend/scripts/test-aegis.js ([aegis/searchConsoleFeedback]).
 */

const { getAegisFlags } = require('./featureFlags');

function _cfg() {
  const rl = getAegisFlags().rlFeedback || {};
  const sources = rl.sources || {};
  return {
    enabled:            Boolean(rl.enabled),
    searchConsole:      sources.searchConsole !== false,
    yandexWebmaster:    sources.yandexWebmaster !== false,
    topCtrQuantile:     Number.isFinite(rl.topCtrQuantile) ? rl.topCtrQuantile : 0.75,
    ppoWeight:          Number.isFinite(rl.ppoWeight) ? rl.ppoWeight : 3.0,
  };
}

function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Нормализует URL к pathname (pagePath). Некорректный URL возвращаем как есть. */
function normalizePath(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).pathname || '/';
  } catch (_) {
    // Уже путь (начинается с /) или мусор — отдаём как есть.
    return raw.startsWith('/') ? raw : raw;
  }
}

/**
 * fetchGscPageMetrics(project, urls, range) — per-URL срез из Google Search
 * Console (dimension=page, отфильтрованный по переданным URL). Возвращает
 * массив { pagePath, url, clicks, impressions } (CTR считаем при слиянии).
 *
 * Graceful: если проект не подключён к GSC или источник выключен — [] c
 * причиной, без исключения.
 */
async function fetchGscPageMetrics(project, urls = [], range = {}) {
  const cfg = _cfg();
  if (!cfg.searchConsole) return { ok: false, reason: 'gsc_disabled', items: [] };
  if (!project || !project.gsc_connected || !project.gsc_site_url) {
    return { ok: false, reason: 'gsc_not_connected', items: [] };
  }
  const list = (urls || []).map((u) => String(u)).filter(Boolean);
  if (!list.length) return { ok: true, items: [] };

  const gscService = require('../projects/gscService');
  const gscClient = require('../projects/gscClient');
  try {
    const { startDate, endDate } = gscService.resolveRange(range);
    const accessToken = await gscService.getValidAccessToken(project);
    const { rows } = await gscClient.querySearchAnalyticsAll(accessToken, project.gsc_site_url, {
      startDate, endDate,
      dimensions: ['page'],
      dimensionFilterGroups: [{
        groupType: 'or',
        filters: list.map((u) => ({ dimension: 'page', operator: 'equals', expression: u })),
      }],
    });
    const items = (rows || []).map((r) => {
      const url = Array.isArray(r.keys) ? (r.keys[0] || '') : '';
      return {
        pagePath: normalizePath(url),
        url,
        clicks: _num(r.clicks),
        impressions: _num(r.impressions),
      };
    });
    return { ok: true, items };
  } catch (e) {
    return { ok: false, reason: `gsc_error:${e && e.code ? e.code : (e && e.message) || 'unknown'}`, items: [] };
  }
}

/**
 * fetchYandexHostMetrics(project, range) — host-level показатели из
 * Яндекс.Вебмастера. Webmaster API не отдаёт per-URL разрез (только per-query
 * и host-history), поэтому берём суммарные клики/показы за период и отдаём как
 * единый host-приор.
 *
 * @returns {{ok:boolean, reason?:string, clicks:number, impressions:number}}
 */
async function fetchYandexHostMetrics(project, range = {}) {
  const cfg = _cfg();
  if (!cfg.yandexWebmaster) return { ok: false, reason: 'yandex_disabled', clicks: 0, impressions: 0 };
  if (!project || !project.ydx_connected) {
    return { ok: false, reason: 'yandex_not_connected', clicks: 0, impressions: 0 };
  }
  const ydxService = require('../projects/ydxService');
  try {
    const perf = await ydxService.fetchPerformanceSeries(project, range);
    const totals = (perf && perf.totals) || {};
    return { ok: true, clicks: _num(totals.clicks), impressions: _num(totals.impressions) };
  } catch (e) {
    return { ok: false, reason: `yandex_error:${e && e.code ? e.code : (e && e.message) || 'unknown'}`, clicks: 0, impressions: 0 };
  }
}

/**
 * mergePageMetrics(engineResults) — сливает per-URL метрики разных движков в
 * единый сигнал по pagePath. Каждый engineResult: { source, items:[{pagePath,
 * clicks, impressions}] }. Клики/показы суммируются, CTR = clicks/impressions
 * (взвешен по показам естественным образом).
 *
 * @returns {Array<{pagePath, clicks, impressions, ctr, sources:string[]}>}
 */
function mergePageMetrics(engineResults = []) {
  const byPath = new Map();
  for (const res of engineResults || []) {
    if (!res || !Array.isArray(res.items)) continue;
    const source = res.source || 'unknown';
    for (const it of res.items) {
      const pagePath = it && it.pagePath ? String(it.pagePath) : '';
      if (!pagePath) continue;
      const cur = byPath.get(pagePath) || { pagePath, clicks: 0, impressions: 0, sources: new Set() };
      cur.clicks += _num(it.clicks);
      cur.impressions += _num(it.impressions);
      cur.sources.add(source);
      byPath.set(pagePath, cur);
    }
  }
  return Array.from(byPath.values()).map((r) => ({
    pagePath: r.pagePath,
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.impressions > 0 ? r.clicks / r.impressions : 0,
    sources: Array.from(r.sources),
  }));
}

/**
 * fetchPageFeedback({ project, urls, range }) — оркестратор: тянет per-URL
 * сигнал из GSC и (host-level) из Яндекс.Вебмастера, сливает в единый сигнал.
 *
 * Яндекс host-CTR примешивается к per-URL сигналу как общий приор: его клики/
 * показы распределяются на найденные URL пропорционально их GSC-показам, чтобы
 * CTR оставался взвешенным по показам между движками. Если GSC-страниц нет —
 * Яндекс host-приор не на что распределить, и в сигнал попадают только GSC-URL.
 *
 * @returns {Promise<{ok:boolean, reason?:string, items:Array, engines:Object}>}
 */
async function fetchPageFeedback({ project, urls = [], range = {} } = {}) {
  const cfg = _cfg();
  if (!cfg.enabled) return { ok: false, reason: 'not_configured', items: [], engines: {} };

  const gsc = await fetchGscPageMetrics(project, urls, range);
  const ydx = await fetchYandexHostMetrics(project, range);

  const engines = {
    search_console: { ok: gsc.ok, reason: gsc.reason || null, pages: (gsc.items || []).length },
    yandex_webmaster: { ok: ydx.ok, reason: ydx.reason || null, clicks: ydx.clicks, impressions: ydx.impressions },
  };

  const engineResults = [{ source: 'search_console', items: gsc.items || [] }];

  // Примешиваем Яндекс host-приор, распределяя его клики/показы на GSC-URL
  // пропорционально их показам (взвешивание по показам сохраняется).
  if (ydx.ok && ydx.impressions > 0 && (gsc.items || []).length) {
    const totalGscImpr = gsc.items.reduce((s, it) => s + _num(it.impressions), 0);
    if (totalGscImpr > 0) {
      const yandexItems = gsc.items.map((it) => {
        const share = _num(it.impressions) / totalGscImpr;
        return {
          pagePath: it.pagePath,
          clicks: ydx.clicks * share,
          impressions: ydx.impressions * share,
        };
      });
      engineResults.push({ source: 'yandex_webmaster', items: yandexItems });
    }
  }

  const items = mergePageMetrics(engineResults);
  if (!items.length && !gsc.ok && !ydx.ok) {
    return { ok: false, reason: 'no_sources_available', items: [], engines };
  }
  return { ok: true, items, engines };
}

/**
 * computePpoWeights(items, opts?) — детерминированная PPO-логика: страницы с
 * CTR ≥ top-quantile (default 0.75) получают повышенный вес (default 3),
 * остальные — 1. Engine-agnostic: метрика берётся из it.ctr (реальный
 * поисковый CTR из GSC/Яндекса).
 */
function computePpoWeights(items, opts = {}) {
  const cfg = _cfg();
  const q = Number.isFinite(opts.topQuantile) ? opts.topQuantile : cfg.topCtrQuantile;
  const w = Number.isFinite(opts.ppoWeight) ? opts.ppoWeight : cfg.ppoWeight;

  const metric = (it) => {
    const c = Number(it.ctr);
    return Number.isFinite(c) ? c : Number(it.engagementRate);
  };

  const ctrs = (items || []).map(metric).filter(Number.isFinite).sort((a, b) => a - b);
  if (!ctrs.length) return (items || []).map((it) => ({ pagePath: it.pagePath, ppo_weight: 1 }));
  const idx = Math.min(ctrs.length - 1, Math.floor(q * ctrs.length));
  const threshold = ctrs[idx];

  return items.map((it) => {
    const c = metric(it);
    return {
      pagePath: it.pagePath,
      ctr: Number.isFinite(c) ? c : null,
      ppo_weight: Number.isFinite(c) && c >= threshold ? w : 1,
    };
  });
}

module.exports = {
  fetchGscPageMetrics,
  fetchYandexHostMetrics,
  fetchPageFeedback,
  mergePageMetrics,
  computePpoWeights,
  normalizePath,
};
