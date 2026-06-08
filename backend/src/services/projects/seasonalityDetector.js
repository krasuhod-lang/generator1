'use strict';

/**
 * projects/seasonalityDetector.js — детектор закономерностей спада (ТЗ п.4).
 *
 * На диапазоне в несколько месяцев одного линейного тренда мало: важно понять
 * КОГДА именно проседает трафик — в какие дни недели, в какие месяцы, и нет ли
 * системного помесячного спада. Это даёт конкретные зацепки («по выходным CTR
 * валится», «третий месяц подряд минус», «понедельник всегда худший день»).
 *
 * Вход — дневной ряд totals из GSC: [{date:'YYYY-MM-DD', clicks, impressions,
 * ctr, position}]. Полностью детерминированно, без сети и LLM, не бросает.
 *
 * Выдаёт:
 *   • trend          — линейная регрессия clicks по дням (направление, наклон);
 *   • weekday         — средние по дням недели + системно слабые дни;
 *   • monthly         — помесячные суммы + MoM-изменения + серия спада подряд;
 *   • findings[]      — человекочитаемые наблюдения для отчёта.
 */

const WEEKDAY_NAMES = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

function _round(n, p = 2) {
  const f = Math.pow(10, p);
  return Math.round((Number(n) || 0) * f) / f;
}

function _num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

/** Линейная регрессия y по индексу x=0..n-1. Возвращает slope/mean/slope_norm. */
function _regression(values) {
  const n = values.length;
  if (n < 2) return { n, slope: 0, mean: n ? values[0] : 0, slope_norm: 0 };
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i; sumY += values[i]; sumXY += i * values[i]; sumXX += i * i;
  }
  const denom = (n * sumXX) - (sumX * sumX);
  const slope = denom ? ((n * sumXY) - (sumX * sumY)) / denom : 0;
  const mean = sumY / n;
  return { n, slope: _round(slope, 4), mean: _round(mean, 2), slope_norm: _round(slope / Math.max(mean, 1), 4) };
}

/** Нормализованные/отсортированные по дате дневные точки с валидной датой. */
function _clean(series) {
  return (series || [])
    .filter((p) => p && typeof p.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date))
    .map((p) => ({
      date: p.date,
      clicks: _num(p.clicks),
      impressions: _num(p.impressions),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Средние клики по дню недели + системно слабые дни (ниже среднего на threshold). */
function _weekdayProfile(points, threshold) {
  const buckets = Array.from({ length: 7 }, () => ({ clicks: 0, days: 0 }));
  for (const p of points) {
    const d = new Date(`${p.date}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) continue;
    const wd = d.getUTCDay();
    buckets[wd].clicks += p.clicks;
    buckets[wd].days += 1;
  }
  const avg = buckets.map((b, i) => ({
    weekday: i,
    name: WEEKDAY_NAMES[i],
    avg_clicks: b.days ? _round(b.clicks / b.days, 2) : 0,
    days: b.days,
  }));
  const present = avg.filter((a) => a.days > 0);
  const overall = present.length
    ? present.reduce((s, a) => s + a.avg_clicks, 0) / present.length
    : 0;
  // Слабый день: средние клики ниже общего на threshold (доля), напр. -25%.
  const weak = present
    .filter((a) => overall > 0 && (a.avg_clicks - overall) / overall <= threshold)
    .map((a) => ({ ...a, below_pct: _round(((a.avg_clicks - overall) / overall) * 100, 1) }))
    .sort((a, b) => a.avg_clicks - b.avg_clicks);
  return { overall_avg: _round(overall, 2), by_weekday: avg, weak_days: weak };
}

/** Помесячные суммы кликов + MoM-изменения + длина текущей серии спада. */
function _monthlyProfile(points) {
  const byMonth = new Map();
  for (const p of points) {
    const month = p.date.slice(0, 7); // YYYY-MM
    const m = byMonth.get(month) || { month, clicks: 0, impressions: 0, days: 0 };
    m.clicks += p.clicks; m.impressions += p.impressions; m.days += 1;
    byMonth.set(month, m);
  }
  const months = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
  for (let i = 0; i < months.length; i++) {
    if (i === 0) { months[i].mom_pct = null; continue; }
    const prev = months[i - 1].clicks;
    months[i].mom_pct = prev > 0 ? _round(((months[i].clicks - prev) / prev) * 100, 1) : null;
    months[i].clicks = _round(months[i].clicks, 2);
  }
  if (months[0]) months[0].clicks = _round(months[0].clicks, 2);
  // Текущая серия помесячного спада подряд (с конца ряда).
  let declineStreak = 0;
  for (let i = months.length - 1; i >= 1; i--) {
    if (typeof months[i].mom_pct === 'number' && months[i].mom_pct < 0) declineStreak += 1;
    else break;
  }
  return { by_month: months, decline_streak_months: declineStreak };
}

/**
 * Детектор закономерностей спада.
 * @param {Array} series — дневной ряд totals [{date,clicks,impressions,...}]
 * @param {object} cfg — { enabled, minDays, weekdayWeakThreshold, trendDownThreshold }
 */
function detectSeasonality(series, cfg) {
  const c = cfg || {};
  const minDays = Math.max(7, Number(c.minDays) || 28);
  const weekdayWeakThreshold = Number.isFinite(Number(c.weekdayWeakThreshold))
    ? Number(c.weekdayWeakThreshold) : -0.25;
  const trendDownThreshold = Number.isFinite(Number(c.trendDownThreshold))
    ? Number(c.trendDownThreshold) : -0.003;

  const points = _clean(series);
  if (points.length < minDays) {
    return { available: false, reason: 'not_enough_days', days: points.length };
  }

  const trendReg = _regression(points.map((p) => p.clicks));
  let direction = 'flat';
  if (trendReg.slope_norm <= trendDownThreshold) direction = 'down';
  else if (trendReg.slope_norm >= -trendDownThreshold) direction = 'up';

  const weekday = _weekdayProfile(points, weekdayWeakThreshold);
  const monthly = _monthlyProfile(points);

  const findings = [];
  if (direction === 'down') {
    findings.push(`Системный спад трафика: в среднем ${trendReg.slope >= 0 ? '+' : ''}${trendReg.slope} кликов/день (${_round(trendReg.slope_norm * 100, 1)}% к среднему ежедневно).`);
  } else if (direction === 'up') {
    findings.push(`Трафик растёт: в среднем ${trendReg.slope >= 0 ? '+' : ''}${trendReg.slope} кликов/день.`);
  }
  if (monthly.decline_streak_months >= 2) {
    findings.push(`Помесячный спад ${monthly.decline_streak_months} мес. подряд — закономерность, а не разовый провал.`);
  }
  if (weekday.weak_days.length) {
    const names = weekday.weak_days.map((d) => `${d.name} (${d.below_pct}%)`).join(', ');
    findings.push(`Системно слабые дни недели (ниже среднего): ${names}.`);
  }

  return {
    available: true,
    days: points.length,
    range: { from: points[0].date, to: points[points.length - 1].date },
    trend: { direction, slope_clicks_per_day: trendReg.slope, slope_norm: trendReg.slope_norm, mean_daily_clicks: trendReg.mean },
    weekday,
    monthly,
    findings,
  };
}

module.exports = {
  WEEKDAY_NAMES,
  _regression,
  _weekdayProfile,
  _monthlyProfile,
  detectSeasonality,
};
