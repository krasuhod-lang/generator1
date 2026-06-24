'use strict';

/**
 * reports/headlineBuilder.js — Sprint 2 ("client-first layout").
 *
 * Pure module that boils a fully aggregated `data` payload (вывод
 * dataAggregator.aggregateForDraft) down to a one-screen executive
 * headline pitched at the **client** reader:
 *
 *   {
 *     main_kpi:           { label, value, unit, source },     // ОДИН главный KPI
 *     delta:              { abs, pct, direction, label },     // период vs. предыдущий
 *     change_summary:     'Клики выросли на 24% (+1 240) ...',// 1 строка на русском
 *     secondary_kpis:     [ { label, value }, ... ],          // 2-4 поддерживающих
 *     top_achievements:   [ 'Запросы в ТОП-10 +12', ... ],    // <=3 пункта
 *     top_risks:          [ 'Keys.so отдают устаревшие ...', ... ], // <=3 пункта
 *     completeness_note:  null | 'Данные частично свежие: ...'
 *   }
 *
 * Никаких внешних зависимостей; никаких числовых "score" — только то,
 * что клиент может понять без знания SEO.
 *
 * Тестируется: backend/scripts/test-reports-headline.js
 */

/* ─────────────────────────────────────────────────────────────────────── */

function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function _isFinitePositive(n) {
  return Number.isFinite(n) && n > 0;
}

function _sumKey(series, key) {
  if (!Array.isArray(series)) return 0;
  let sum = 0;
  for (const r of series) sum += _num(r && r[key]);
  return sum;
}

function _splitHalf(series) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const mid = Math.floor(series.length / 2);
  return { prev: series.slice(0, mid), curr: series.slice(mid) };
}

function _delta(prev, curr) {
  const abs = Math.round((curr - prev) * 100) / 100;
  let direction = 'stable';
  if (abs > 0) direction = 'up';
  else if (abs < 0) direction = 'down';
  let pct = null;
  if (_isFinitePositive(prev)) {
    pct = Math.round(((curr - prev) / prev) * 1000) / 10; // 1 знак после запятой
  }
  return { abs, pct, direction };
}

function _formatNumberRu(n) {
  if (!Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('ru-RU');
}

function _formatDeltaLabel(d, opts = {}) {
  if (!d) return '';
  const sign = d.abs > 0 ? '+' : '';
  const abs = `${sign}${_formatNumberRu(d.abs)}${opts.unit ? ' ' + opts.unit : ''}`;
  if (d.pct == null) return abs;
  const pctSign = d.pct > 0 ? '+' : '';
  return `${abs} (${pctSign}${d.pct}%)`;
}

/* ─── KPI selection ─────────────────────────────────────────────────────── */

/**
 * Подбираем "главный KPI" для headline.
 * Приоритет (как в ТЗ §6.2 client-first):
 *   1) суммарный clicks (Google + Яндекс) — самая понятная клиенту метрика
 *   2) GSC clicks
 *   3) Яндекс clicks
 *   4) keys_so.visibility.current
 *   5) position.summary.top10
 */
function _pickMainKpi(data) {
  const gscClicks = _num(data?.gsc?.totals?.clicks);
  const ywmClicks = _num(data?.ywm?.totals?.clicks);
  const total = gscClicks + ywmClicks;
  if (total > 0) {
    const sources = [];
    if (gscClicks > 0) sources.push('Google');
    if (ywmClicks > 0) sources.push('Яндекс');
    return {
      label: 'Клики из поиска',
      value: total,
      unit: 'клик.',
      source: sources.join(' + ') || 'поиск',
    };
  }
  const visibility = _num(
    data?.keys_so?.yandex?.current?.visibility ?? data?.keys_so?.current?.visibility,
  );
  if (visibility > 0) {
    return { label: 'Видимость в Keys.so', value: visibility, unit: '%', source: 'Keys.so' };
  }
  const top10 = _num(data?.position?.summary?.top10);
  if (top10 > 0) {
    return { label: 'Запросов в ТОП-10', value: top10, unit: '', source: 'Съём позиций' };
  }
  return null;
}

/**
 * Считаем delta главной метрики vs. предыдущего полупериода
 * (по сериям, которые лежат в той же секции, что и выбранный KPI).
 */
function _pickMainDelta(data, mainKpi) {
  if (!mainKpi) return null;
  if (mainKpi.label === 'Клики из поиска') {
    const gscSeries = data?.gsc?.series || [];
    const ywmSeries = data?.ywm?.series || [];
    // Сшиваем по дате — клиенту важна суммарная динамика, не источниковая.
    const map = new Map();
    for (const r of gscSeries) map.set(r.date, (map.get(r.date) || 0) + _num(r.clicks));
    for (const r of ywmSeries) map.set(r.date, (map.get(r.date) || 0) + _num(r.clicks));
    const combined = Array.from(map.entries())
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map(([date, clicks]) => ({ date, clicks }));
    const split = _splitHalf(combined);
    if (!split) return null;
    return _delta(_sumKey(split.prev, 'clicks'), _sumKey(split.curr, 'clicks'));
  }
  if (mainKpi.label === 'Видимость в Keys.so') {
    const series = data?.keys_so?.yandex?.series || data?.keys_so?.series || [];
    const split = _splitHalf(series);
    if (!split) return null;
    const avg = (arr) => {
      const xs = arr.map((r) => _num(r.visibility)).filter((v) => v > 0);
      if (!xs.length) return 0;
      return xs.reduce((a, b) => a + b, 0) / xs.length;
    };
    return _delta(avg(split.prev), avg(split.curr));
  }
  return null;
}

function _changeSummary(mainKpi, delta) {
  if (!mainKpi) return 'За период данных по основным метрикам нет.';
  const valueLbl = `${_formatNumberRu(mainKpi.value)}${mainKpi.unit ? ' ' + mainKpi.unit : ''}`;
  if (!delta || delta.direction === 'stable' || delta.abs === 0) {
    return `${mainKpi.label}: ${valueLbl}. Динамика стабильная.`;
  }
  const verb = delta.direction === 'up' ? 'выросли' : 'снизились';
  const tag = _formatDeltaLabel(delta, { unit: mainKpi.unit });
  return `${mainKpi.label}: ${valueLbl}. ${capitalize(verb)} на ${tag} к предыдущему периоду.`;
}

function capitalize(s) {
  return s && s[0] ? s[0].toUpperCase() + s.slice(1) : s;
}

/* ─── Supporting KPIs (2-4 maximum) ─────────────────────────────────────── */

function _secondaryKpis(data, mainKpi) {
  const out = [];
  const seen = new Set();
  const push = (label, value, formatter) => {
    if (label === mainKpi?.label) return;
    if (value == null || !Number.isFinite(Number(value))) return;
    if (seen.has(label)) return;
    seen.add(label);
    out.push({ label, value: formatter ? formatter(value) : _formatNumberRu(value), raw: Number(value) });
  };
  const g = data?.gsc?.totals;
  if (g) {
    push('Показы в Google', g.impressions);
    push('CTR Google', g.ctr, (v) => `${_num(v).toFixed(2)}%`);
  }
  const y = data?.ywm?.totals;
  if (y) {
    push('Показы в Яндексе', y.impressions);
  }
  const k = data?.keys_so?.yandex?.current || data?.keys_so?.current;
  if (k) {
    push('Запросов в ТОП-10 (Яндекс)', k.top10);
  }
  const p = data?.position?.summary;
  if (p && p.avg_position != null) {
    push('Средняя позиция', p.avg_position, (v) => Number(v).toFixed(1));
  }
  return out.slice(0, 4);
}

/* ─── Achievements & risks ──────────────────────────────────────────────── */

/**
 * Top-3 достижения. Источники по приоритету:
 *   1) summary.highlights (готовый текст от AI)
 *   2) positive deltas из секций (GSC clicks↑, ywm clicks↑, ТОП-10↑)
 *   3) tasks.total_generated > 0 — "выполнено N работ"
 */
function _topAchievements(data, summary, mainDelta) {
  const out = [];

  const highlights = Array.isArray(summary?.highlights) ? summary.highlights : [];
  for (const h of highlights) {
    if (out.length >= 3) break;
    const s = typeof h === 'string' ? h : [h?.title, h?.detail].filter(Boolean).join(' — ');
    if (s && s.trim()) out.push(s.trim());
  }

  if (out.length < 3 && mainDelta && mainDelta.direction === 'up' && mainDelta.abs > 0) {
    out.push(`Поисковый трафик вырос на ${_formatDeltaLabel(mainDelta, { unit: 'клик.' })}.`);
  }

  if (out.length < 3) {
    const kCur = data?.keys_so?.yandex?.current || data?.keys_so?.current;
    const kSeries = data?.keys_so?.yandex?.series || data?.keys_so?.series || [];
    if (kCur && kSeries.length >= 2) {
      const first = _num(kSeries[0]?.keywords_top10);
      const last = _num(kSeries[kSeries.length - 1]?.keywords_top10);
      const d = last - first;
      if (d > 0) out.push(`Запросов в ТОП-10 Яндекс выросло на +${_formatNumberRu(d)}.`);
    }
  }

  if (out.length < 3) {
    const done = _num(data?.tasks?.total_generated);
    if (done > 0) out.push(`Выполнено работ по SEO: ${_formatNumberRu(done)}.`);
  }

  return out.slice(0, 3);
}

/**
 * Top-3 risks / точки роста. Источники:
 *   1) completeness.failed_sources — приоритет (клиент должен знать про дыру в данных)
 *   2) summary.vulnerabilities[]
 *   3) negative delta главной метрики
 *   4) completeness.partial_sources
 */
function _topRisks(data, summary, mainDelta) {
  const out = [];
  const seen = new Set();
  const push = (s) => {
    if (!s) return;
    const txt = String(s).trim();
    if (!txt || seen.has(txt) || out.length >= 3) return;
    seen.add(txt);
    out.push(txt);
  };
  const failed = Array.isArray(data?.completeness?.failed_sources) ? data.completeness.failed_sources : [];
  for (const src of failed) push(`Нет данных из источника: ${src}.`);

  const vulns = Array.isArray(summary?.vulnerabilities) ? summary.vulnerabilities : [];
  for (const v of vulns) {
    const s = typeof v === 'string' ? v : [v?.title, v?.detail].filter(Boolean).join(' — ');
    push(s);
  }

  if (mainDelta && mainDelta.direction === 'down' && mainDelta.abs < 0) {
    push(`Поисковый трафик снизился на ${_formatDeltaLabel(mainDelta, { unit: 'клик.' })}.`);
  }

  const partial = Array.isArray(data?.completeness?.partial_sources) ? data.completeness.partial_sources : [];
  for (const src of partial) push(`Источник «${src}» отдал неполные данные.`);

  return out;
}

function _completenessNote(data) {
  const c = data?.completeness;
  if (!c) return null;
  if (!c.has_partial && !c.has_error) return null;
  const parts = [];
  if (Array.isArray(c.failed_sources) && c.failed_sources.length) {
    parts.push(`не получены данные: ${c.failed_sources.join(', ')}`);
  }
  if (Array.isArray(c.partial_sources) && c.partial_sources.length) {
    parts.push(`частично свежие: ${c.partial_sources.join(', ')}`);
  }
  if (!parts.length) return null;
  return `Отчёт собран по неполным данным (${parts.join('; ')}). Цифры выше отражают только доступные источники.`;
}

/* ─── Public API ────────────────────────────────────────────────────────── */

function buildHeadline(data, summary = null) {
  const safeData = data && typeof data === 'object' ? data : {};
  const mainKpi = _pickMainKpi(safeData);
  const delta = _pickMainDelta(safeData, mainKpi);
  return {
    main_kpi: mainKpi,
    delta: delta ? { ...delta, label: _formatDeltaLabel(delta, { unit: mainKpi?.unit }) } : null,
    change_summary: _changeSummary(mainKpi, delta),
    secondary_kpis: _secondaryKpis(safeData, mainKpi),
    top_achievements: _topAchievements(safeData, summary, delta),
    top_risks: _topRisks(safeData, summary, delta),
    completeness_note: _completenessNote(safeData),
  };
}

module.exports = {
  buildHeadline,
  // exposed for tests
  _internal: {
    _pickMainKpi,
    _pickMainDelta,
    _delta,
    _formatDeltaLabel,
    _changeSummary,
    _secondaryKpis,
    _topAchievements,
    _topRisks,
    _completenessNote,
  },
};
