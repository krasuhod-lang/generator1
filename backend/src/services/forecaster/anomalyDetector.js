'use strict';

/**
 * forecaster/anomalyDetector.js — поиск «зон падения спроса».
 *
 * Алгоритм:
 *   1. Для каждой точки вычисляем baseline = median(prev N точек,
 *      исключая текущую). N задаётся config.anomalies.baselineWindow.
 *   2. Если value <= baseline * (1 - minDropPct) — точка помечена как «drop».
 *   3. Подряд идущие drop-точки объединяются в зону длиной ≥ minRunMonths.
 *   4. Severity зоны = max dropPct внутри.
 *
 * Возвращает структуру для рендера (включая severity-классы), которая
 * напрямую кладётся в forecaster_tasks.anomalies.
 */

const { getForecasterConfig } = require('./config');

function _median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/**
 * @param {Array<{period:string, demand:number}>} monthly
 */
function detectAnomalies(monthly) {
  const cfg = getForecasterConfig().anomalies;
  const drops = [];
  if (!monthly || monthly.length < cfg.baselineWindow + 1) {
    return { drops: [], summary: { count: 0, max_severity: 'none' } };
  }

  // Помечаем каждую точку
  const flags = monthly.map((pt, idx) => {
    if (idx < cfg.baselineWindow) {
      return { idx, period: pt.period, value: pt.demand, baseline: null, dropPct: 0, isDrop: false };
    }
    const window = monthly.slice(idx - cfg.baselineWindow, idx).map((p) => p.demand);
    const baseline = _median(window);
    if (baseline <= 0) {
      return { idx, period: pt.period, value: pt.demand, baseline, dropPct: 0, isDrop: false };
    }
    const dropPct = (baseline - pt.demand) / baseline;
    return {
      idx,
      period: pt.period,
      value: pt.demand,
      baseline,
      dropPct,
      isDrop: dropPct >= cfg.minDropPct,
    };
  });

  // Объединяем подряд идущие drop-точки в зоны
  let cur = null;
  let maxSeverityNum = 0;
  for (const f of flags) {
    if (f.isDrop) {
      if (!cur) {
        cur = {
          from: f.period,
          to: f.period,
          length: 1,
          maxDropPct: f.dropPct,
          minValue: f.value,
          baselineAtStart: f.baseline,
          points: [{ period: f.period, value: f.value, dropPct: f.dropPct }],
        };
      } else {
        cur.to = f.period;
        cur.length += 1;
        if (f.dropPct > cur.maxDropPct) cur.maxDropPct = f.dropPct;
        if (f.value < cur.minValue) cur.minValue = f.value;
        cur.points.push({ period: f.period, value: f.value, dropPct: f.dropPct });
      }
    } else if (cur) {
      _closeZone(cur, cfg, drops);
      cur = null;
    }
    if (f.dropPct > maxSeverityNum) maxSeverityNum = f.dropPct;
  }
  if (cur) _closeZone(cur, cfg, drops);

  const sev = maxSeverityNum >= cfg.severityHigh ? 'high'
            : maxSeverityNum >= cfg.severityMid  ? 'mid'
            : drops.length > 0                    ? 'low' : 'none';
  return {
    drops,
    summary: {
      count: drops.length,
      max_severity: sev,
      max_drop_pct: Math.round(maxSeverityNum * 100) / 100,
    },
  };
}

function _closeZone(z, cfg, out) {
  if (z.length < cfg.minRunMonths) return;
  const sev = z.maxDropPct >= cfg.severityHigh ? 'high'
            : z.maxDropPct >= cfg.severityMid  ? 'mid' : 'low';
  out.push({
    from: z.from,
    to: z.to,
    length_months: z.length,
    severity: sev,
    drop_pct: Math.round(z.maxDropPct * 1000) / 1000,
    min_value: z.minValue,
    baseline: z.baselineAtStart,
    points: z.points,
  });
}

module.exports = { detectAnomalies };
