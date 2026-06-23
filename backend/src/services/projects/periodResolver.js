'use strict';

/**
 * projects/periodResolver.js — детерминированный резолвер «полных периодов»
 * (ТЗ §5.1).
 *
 * Бизнес-правила:
 *   • headline KPI / MoM / YoY / PDF / AI insights строятся ТОЛЬКО по
 *     полностью завершённым месяцам;
 *   • текущий (не закрытый) месяц допустимо показывать на графике, но он
 *     ОБЯЗАН быть помечен как partial и не использоваться для итогов;
 *   • месяц считается завершённым, если:
 *       (а) календарно закончился,
 *       (б) с конца месяца прошло >= completeMonthLagDays дней
 *           (источники отдают данные с задержкой — GSC ~2-3д, Yandex ~1-2д).
 *
 * Чистая функция, без БД и сети. Все даты — ISO YYYY-MM-DD в UTC.
 */

const { getProjectsConfig } = require('./config');

function _pad(n) { return String(n).padStart(2, '0'); }

function _toUtcDate(value) {
  if (value instanceof Date) return new Date(Date.UTC(
    value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()
  ));
  if (typeof value === 'string' && value.length >= 10) {
    const y = Number(value.slice(0, 4));
    const m = Number(value.slice(5, 7));
    const d = Number(value.slice(8, 10));
    if (y && m && d) return new Date(Date.UTC(y, m - 1, d));
  }
  return null;
}

function _isoDate(d) {
  return `${d.getUTCFullYear()}-${_pad(d.getUTCMonth() + 1)}-${_pad(d.getUTCDate())}`;
}

function _monthKey(d) {
  return `${d.getUTCFullYear()}-${_pad(d.getUTCMonth() + 1)}`;
}

function _firstDayOfMonth(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function _lastDayOfMonth(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

function _addMonths(d, n) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

function _daysBetween(a, b) {
  return Math.round((b - a) / 86400000);
}

/**
 * Описание одного месячного периода.
 * @typedef {object} MonthPeriod
 * @property {string} key          — YYYY-MM
 * @property {string} from         — YYYY-MM-DD (1-е число)
 * @property {string} to           — YYYY-MM-DD (последний день месяца)
 * @property {boolean} is_complete — календарно закрыт и прошёл lag
 * @property {boolean} is_partial  — текущий незакрытый месяц или лаг не выдержан
 * @property {string} status       — 'complete' | 'partial' | 'future'
 */

/**
 * Проверка завершённости конкретного месяца относительно «сейчас» и
 * максимальной даты, которую отдал источник.
 *
 * @param {Date|string} monthAnchor — любая дата внутри месяца.
 * @param {object} opts
 * @param {Date|string} [opts.now]            — текущее время (default = new Date()).
 * @param {Date|string} [opts.sourceMaxDate]  — максимальная дата с данными в источнике.
 * @param {number}      [opts.lagDays]        — completeMonthLagDays (override).
 * @returns {MonthPeriod}
 */
function describeMonth(monthAnchor, opts = {}) {
  const cfg = getProjectsConfig().periods;
  const lag = Number.isFinite(opts.lagDays) ? opts.lagDays : cfg.completeMonthLagDays;
  const now = _toUtcDate(opts.now) || _toUtcDate(new Date());
  const src = opts.sourceMaxDate ? _toUtcDate(opts.sourceMaxDate) : null;
  const anchor = _toUtcDate(monthAnchor);
  if (!anchor) throw new Error('describeMonth: invalid monthAnchor');

  const first = _firstDayOfMonth(anchor);
  const last = _lastDayOfMonth(anchor);
  const key = _monthKey(anchor);

  // 1. Месяц ещё не наступил → future.
  if (first > now) {
    return { key, from: _isoDate(first), to: _isoDate(last),
      is_complete: false, is_partial: false, status: 'future' };
  }

  // 2. Текущий месяц или месяц, у которого ещё не прошёл лаг → partial.
  const lagPassed = _daysBetween(last, now) >= lag;
  // 3. Если источник ещё не дотянулся до последнего дня месяца — тоже partial.
  const sourceCovered = src ? src >= last : true;

  const complete = lagPassed && sourceCovered && last < now;
  return {
    key,
    from: _isoDate(first),
    to: _isoDate(last),
    is_complete: complete,
    is_partial: !complete,
    status: complete ? 'complete' : 'partial',
  };
}

/**
 * Резолвинг последних N полных месяцев + текущего partial.
 * Возвращает объект с быстрым доступом к ключевым периодам:
 *   • lastComplete — последний полностью закрытый месяц,
 *   • prevComplete — предыдущий полностью закрытый месяц (для MoM),
 *   • yoyComplete  — тот же месяц годом ранее (для YoY),
 *   • partialMonth — текущий не закрытый месяц (для графиков, помеченный),
 *   • months       — массив всех месяцев в окне (от старого к новому).
 *
 * @param {object} opts
 * @param {Date|string} [opts.now]
 * @param {Date|string} [opts.sourceMaxDate]
 * @param {number}      [opts.lookbackMonths=13] — глубина истории.
 * @param {number}      [opts.lagDays]
 * @returns {{ lastComplete:MonthPeriod|null, prevComplete:MonthPeriod|null,
 *            yoyComplete:MonthPeriod|null, partialMonth:MonthPeriod|null,
 *            months: MonthPeriod[] }}
 */
function resolveCompletedMonths(opts = {}) {
  const cfg = getProjectsConfig().periods;
  const lag = Number.isFinite(opts.lagDays) ? opts.lagDays : cfg.completeMonthLagDays;
  const lookback = Math.max(2, Math.min(36, Number(opts.lookbackMonths) || 14));
  const now = _toUtcDate(opts.now) || _toUtcDate(new Date());
  const src = opts.sourceMaxDate ? _toUtcDate(opts.sourceMaxDate) : null;

  const months = [];
  for (let i = lookback - 1; i >= 0; i--) {
    const anchor = _addMonths(_firstDayOfMonth(now), -i);
    months.push(describeMonth(anchor, { now, sourceMaxDate: src, lagDays: lag }));
  }

  const completeOnly = months.filter((m) => m.is_complete);
  const lastComplete = completeOnly[completeOnly.length - 1] || null;
  const prevComplete = completeOnly[completeOnly.length - 2] || null;

  let yoyComplete = null;
  if (lastComplete) {
    const lcAnchor = _toUtcDate(lastComplete.from);
    const yoyAnchor = new Date(Date.UTC(
      lcAnchor.getUTCFullYear() - 1, lcAnchor.getUTCMonth(), 1
    ));
    const candidate = months.find((m) => m.key === _monthKey(yoyAnchor));
    if (candidate && candidate.is_complete) yoyComplete = candidate;
  }

  const partialMonth = months.find((m) => m.status === 'partial') || null;

  return { lastComplete, prevComplete, yoyComplete, partialMonth, months };
}

/**
 * Проверка готовности произвольного диапазона как «полного».
 * Используется для отчётов с кастомным окном (квартал/полгода).
 * Полный = endDate < now, endDate <= sourceMaxDate, прошёл lag.
 *
 * @returns {{ is_complete:boolean, reason:string|null }}
 */
function isPeriodComplete(range, opts = {}) {
  const cfg = getProjectsConfig().periods;
  const lag = Number.isFinite(opts.lagDays) ? opts.lagDays : cfg.completeMonthLagDays;
  const now = _toUtcDate(opts.now) || _toUtcDate(new Date());
  const src = opts.sourceMaxDate ? _toUtcDate(opts.sourceMaxDate) : null;
  const end = _toUtcDate(range && (range.endDate || range.to));
  if (!end) return { is_complete: false, reason: 'invalid_range' };
  if (end >= now) return { is_complete: false, reason: 'period_not_finished' };
  if (_daysBetween(end, now) < lag) return { is_complete: false, reason: 'lag_not_passed' };
  if (src && src < end) return { is_complete: false, reason: 'source_behind' };
  return { is_complete: true, reason: null };
}

/**
 * Разбиение посуточной серии (как из gscService.fetchPerformanceSeries) на
 * помесячные агрегаты с пометкой is_partial/is_complete.
 * Источник даты — поле `date` (ISO YYYY-MM-DD).
 *
 * @param {Array<{date:string,clicks:number,impressions:number,ctr:number,position:number}>} series
 * @param {object} [opts] — { now, sourceMaxDate, lagDays }
 * @returns {Array<{key:string,from:string,to:string,is_complete:boolean,
 *   is_partial:boolean,status:string,clicks:number,impressions:number,
 *   ctr:number,position:number,days:number}>}
 */
function splitSeriesIntoMonths(series, opts = {}) {
  if (!Array.isArray(series) || !series.length) return [];
  const buckets = new Map();
  for (const row of series) {
    const d = _toUtcDate(row && row.date);
    if (!d) continue;
    const key = _monthKey(d);
    if (!buckets.has(key)) {
      buckets.set(key, {
        anchor: d,
        clicks: 0, impressions: 0,
        ctrSum: 0, positionSum: 0,
        days: 0,
      });
    }
    const b = buckets.get(key);
    b.clicks += Number(row.clicks) || 0;
    b.impressions += Number(row.impressions) || 0;
    b.ctrSum += Number(row.ctr) || 0;
    b.positionSum += Number(row.position) || 0;
    b.days += 1;
  }
  // Без сортировки буфер уже хронологичен (Map сохраняет порядок вставки),
  // но series мог прийти не сортированным — отсортируем явно.
  const ordered = Array.from(buckets.values()).sort((a, b) => a.anchor - b.anchor);
  return ordered.map((b) => {
    const desc = describeMonth(b.anchor, opts);
    const ctr = b.impressions
      ? Math.round((b.clicks / b.impressions) * 100 * 100) / 100
      : (b.days ? Math.round((b.ctrSum / b.days) * 100) / 100 : 0);
    const position = b.days ? Math.round((b.positionSum / b.days) * 100) / 100 : 0;
    return {
      key: desc.key,
      from: desc.from,
      to: desc.to,
      is_complete: desc.is_complete,
      is_partial: desc.is_partial,
      status: desc.status,
      days: b.days,
      clicks: b.clicks,
      impressions: b.impressions,
      ctr,
      position,
    };
  });
}

module.exports = {
  describeMonth,
  resolveCompletedMonths,
  isPeriodComplete,
  splitSeriesIntoMonths,
};
