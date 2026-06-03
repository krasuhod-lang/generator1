'use strict';

/**
 * projects/periodComparison.js — детерминированное сравнение период-к-периоду
 * (Period-over-Period, PoP) и декомпозиция Δclicks.
 *
 * Идея: вместо «упало на 12%» отдать LLM (и UI) разложение —
 *   • что изменилось из-за изменения СПРОСА (Δимпрессий),
 *   • что — из-за изменения ПОЗИЦИЙ (Δсредней позиции),
 *   • что — из-за CTR (релевантность сниппета).
 *
 * Классическая формула декомпозиции:
 *   Δclicks ≈ Δimpressions × CTRprev      (вклад спроса)
 *           + impressionsCurr × ΔCTR      (вклад CTR/позиций)
 *
 * Дополнительно — топ движущих запросов и страниц по абсолютному ΔClicks.
 *
 * Чистая логика, без сети и LLM. Graceful: на пустых данных возвращает
 * { available:false }.
 */

function _round(n, p = 2) {
  const f = Math.pow(10, p);
  return Math.round((Number(n) || 0) * f) / f;
}

function _pct(curr, prev) {
  if (!prev) return null; // деление на ноль — отдельный сигнал «не определено»
  return _round(((curr - prev) / prev) * 100, 2);
}

/**
 * Сравнение тоталов и декомпозиция Δclicks.
 * @param {{clicks:number,impressions:number,ctr:number,position:number}} curr
 *   ctr — в процентах (как в gscService._round * 100).
 * @param {{clicks:number,impressions:number,ctr:number,position:number}} prev
 */
function compareTotals(curr, prev) {
  const c = curr || {};
  const p = prev || {};
  const dClicks = (c.clicks || 0) - (p.clicks || 0);
  const dImpr   = (c.impressions || 0) - (p.impressions || 0);
  const ctrCurr = (c.ctr || 0) / 100; // обратно к доле
  const ctrPrev = (p.ctr || 0) / 100;
  const dCtr    = ctrCurr - ctrPrev;
  // Декомпозиция:
  //   demand_contrib = ΔImpr × CTRprev
  //   ctr_contrib    = ImprCurr × ΔCTR
  // Сумма аппроксимирует ΔClicks (точна с точностью до cross-term).
  const demandContrib = dImpr * ctrPrev;
  const ctrContrib    = (c.impressions || 0) * dCtr;
  return {
    delta: {
      clicks: dClicks,
      impressions: dImpr,
      ctr: _round((ctrCurr - ctrPrev) * 100, 2),
      position: _round((c.position || 0) - (p.position || 0), 2),
    },
    pct: {
      clicks: _pct(c.clicks, p.clicks),
      impressions: _pct(c.impressions, p.impressions),
      ctr: _pct(c.ctr, p.ctr),
      // Для позиции «рост» = снижение числа, отдельным флагом.
      position: _pct(c.position, p.position),
    },
    decomposition: {
      demand_contrib_clicks: _round(demandContrib, 2),
      ctr_contrib_clicks:    _round(ctrContrib, 2),
      // Доли вклада в общий Δclicks (для UI bar-chart). На околонулевом Δ
      // знаменатель → проценты не считаем.
      demand_share_pct: dClicks ? _round((demandContrib / dClicks) * 100, 1) : null,
      ctr_share_pct:    dClicks ? _round((ctrContrib    / dClicks) * 100, 1) : null,
    },
  };
}

/**
 * Сравнение двух массивов «топ-запросов» (или страниц): для каждого ключа
 * считает Δclicks, Δimpressions, Δposition, Δctr; возвращает топ роста и
 * топ падения по абсолютному Δclicks.
 *
 * Формат входа: массивы { key, clicks, impressions, ctr%, position }.
 */
function compareKeyed(currentArr, previousArr, opts = {}) {
  const minImpr = Number(opts.minImpressions) || 0;
  const minAbs  = Number(opts.minClicksAbsDelta) || 0;
  const top     = Math.max(1, Number(opts.topN) || 10);

  const prevMap = new Map();
  for (const it of (previousArr || [])) {
    if (!it || !it.key) continue;
    prevMap.set(it.key, it);
  }
  const seen = new Set();
  const merged = [];
  for (const it of (currentArr || [])) {
    if (!it || !it.key) continue;
    seen.add(it.key);
    const prev = prevMap.get(it.key) || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
    merged.push(_diffRow(it, prev, /*newcomer*/ !prevMap.has(it.key)));
  }
  // Запросы/страницы, которые УШЛИ (были, теперь нет в выборке).
  for (const [k, prev] of prevMap.entries()) {
    if (seen.has(k)) continue;
    merged.push(_diffRow({ key: k, clicks: 0, impressions: 0, ctr: 0, position: 0 }, prev, false, /*lost*/ true));
  }

  const filtered = merged.filter((m) => {
    const passImpr = (m.impressions_curr >= minImpr) || (m.impressions_prev >= minImpr);
    const passAbs  = Math.abs(m.delta.clicks) >= minAbs;
    return passImpr && passAbs;
  });

  // Сортировки разнонаправленные.
  const risers  = [...filtered].sort((a, b) => b.delta.clicks - a.delta.clicks).slice(0, top);
  const fallers = [...filtered].sort((a, b) => a.delta.clicks - b.delta.clicks).slice(0, top);
  const newcomers = filtered.filter((m) => m.is_new && m.clicks_curr > 0)
    .sort((a, b) => b.clicks_curr - a.clicks_curr).slice(0, top);
  const lost = filtered.filter((m) => m.is_lost)
    .sort((a, b) => b.clicks_prev - a.clicks_prev).slice(0, top);

  return { risers, fallers, newcomers, lost, total_compared: filtered.length };
}

function _diffRow(curr, prev, isNew = false, isLost = false) {
  return {
    key: curr.key,
    is_new: !!isNew,
    is_lost: !!isLost,
    clicks_curr: curr.clicks || 0,
    clicks_prev: prev.clicks || 0,
    impressions_curr: curr.impressions || 0,
    impressions_prev: prev.impressions || 0,
    ctr_curr: _round(curr.ctr || 0, 2),
    ctr_prev: _round(prev.ctr || 0, 2),
    position_curr: _round(curr.position || 0, 2),
    position_prev: _round(prev.position || 0, 2),
    delta: {
      clicks:      (curr.clicks || 0)      - (prev.clicks || 0),
      impressions: (curr.impressions || 0) - (prev.impressions || 0),
      ctr:         _round((curr.ctr || 0) - (prev.ctr || 0), 2),
      // Δposition: отрицательное значение = улучшение (ниже число — выше место).
      position:    _round((curr.position || 0) - (prev.position || 0), 2),
    },
  };
}

/**
 * Полный отчёт PoP. Безопасен на пустых входах.
 */
function buildPeriodReport({ currTotals, prevTotals, currQueries, prevQueries, currPages, prevPages, opts }) {
  const o = opts || {};
  if (!currTotals || !prevTotals) {
    return { available: false, reason: 'no_prev_period' };
  }
  return {
    available: true,
    totals: compareTotals(currTotals, prevTotals),
    queries: compareKeyed(currQueries || [], prevQueries || [], {
      minImpressions: o.minImpressions, minClicksAbsDelta: o.minClicksAbsDelta, topN: o.topQueriesDelta,
    }),
    pages: compareKeyed(currPages || [], prevPages || [], {
      minImpressions: o.minImpressions, minClicksAbsDelta: o.minClicksAbsDelta, topN: o.topPagesDelta,
    }),
  };
}

/**
 * Сравнение двух сохранённых снимков (project_snapshots.gsc_data). В отличие
 * от buildPeriodReport, который требует «свежих» массивов из gscService, здесь
 * на вход поступают уже агрегированные снимки, и можно сравнить любые два
 * (например, текущий с тем, что был 3 месяца назад).
 *
 * @param {object} curr  gsc_data текущего снимка
 * @param {object} prev  gsc_data предыдущего снимка
 * @returns {{available:boolean, totals?:object, queries?:object, pages?:object,
 *           periods?:{curr:object,prev:object}}}
 */
function compareSnapshots(curr, prev, opts = {}) {
  if (!curr || !prev || typeof curr !== 'object' || typeof prev !== 'object') {
    return { available: false, reason: 'missing_snapshot' };
  }
  const o = {
    minImpressions: opts.minImpressions || 0,
    minClicksAbsDelta: opts.minClicksAbsDelta || 0,
    topQueriesDelta: Math.max(1, Number(opts.topQueriesDelta) || 10),
    topPagesDelta: Math.max(1, Number(opts.topPagesDelta) || 10),
  };
  const currTotals = curr.totals || null;
  const prevTotals = prev.totals || null;
  if (!currTotals || !prevTotals) {
    return { available: false, reason: 'no_totals' };
  }
  return {
    available: true,
    periods: {
      curr: curr.range || null,
      prev: prev.range || null,
    },
    totals: compareTotals(currTotals, prevTotals),
    queries: compareKeyed(curr.top_queries || [], prev.top_queries || [], {
      minImpressions: o.minImpressions,
      minClicksAbsDelta: o.minClicksAbsDelta,
      topN: o.topQueriesDelta,
    }),
    pages: compareKeyed(curr.top_pages || [], prev.top_pages || [], {
      minImpressions: o.minImpressions,
      minClicksAbsDelta: o.minClicksAbsDelta,
      topN: o.topPagesDelta,
    }),
  };
}

module.exports = {
  compareTotals,
  compareKeyed,
  buildPeriodReport,
  compareSnapshots,
};
