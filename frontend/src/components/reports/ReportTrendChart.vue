<script setup>
/**
 * ReportTrendChart.vue — мульти-серия линейного SVG-графика без зависимостей.
 * Рисует:
 *   • до 4 серий с заданными цветами,
 *   • прогноз пунктиром (поле dashed=true) с заливкой зоны 15% opacity,
 *   • двух-осный режим (yAxisID='y2'): отдельная правая ось для visibility.
 *   • hover-tooltip с данными всех серий в выбранной точке,
 *   • легенда с цветными маркерами и кликом для скрытия/показа серий.
 *
 * Props:
 *   labels: string[]      // подписи оси X (помесячно)
 *   datasets: Array<{
 *     label: string,
 *     data: Array<number|null>,  // null = не рисовать (например, прогноз для прошлого)
 *     color: string,
 *     dashed?: boolean,
 *     fill?: boolean,
 *     yAxisID?: 'y'|'y2',
 *   }>
 *   showSecondAxis?: boolean
 *   annotations?: Array<{ bucket?: string, date?: string, label?: string }>
 */
import { computed, ref } from 'vue';

const props = defineProps({
  labels: { type: Array, default: () => [] },
  datasets: { type: Array, default: () => [] },
  width: { type: Number, default: 880 },
  height: { type: Number, default: 320 },
  showSecondAxis: { type: Boolean, default: false },
  annotations: { type: Array, default: () => [] },
  showTrend: { type: Boolean, default: true },
  // ТЗ #1: расширенный объект range от бэка.
  //   { from, to, granularity, expected_buckets, actual_buckets,
  //     actual_from, actual_to, has_gaps }
  // Используется для:
  //   • подписи диапазона под графиком («диапазон: DD.MM.YYYY — DD.MM.YYYY»),
  //   • баннера «Источник вернул данные с DD.MM.YYYY — раньше истории нет»,
  //     когда actual_from > range.from.
  range: { type: Object, default: () => null },
});

function _fmtRu(iso) {
  if (!iso || typeof iso !== 'string') return '';
  const m = iso.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

const rangeCaption = computed(() => {
  const r = props.range;
  if (!r || !r.from || !r.to) return '';
  return `Диапазон: ${_fmtRu(r.from)} — ${_fmtRu(r.to)}`;
});

const sourceStartNotice = computed(() => {
  const r = props.range;
  if (!r || !r.actual_from || !r.from) return '';
  // показываем только если фактическое начало явно позже запрошенного
  if (r.actual_from <= r.from) return '';
  return `Источник вернул данные с ${_fmtRu(r.actual_from)} — раньше истории нет`;
});

const PAD = { l: 50, r: 50, t: 16, b: 36 };

const innerW = computed(() => props.width - PAD.l - PAD.r);
const innerH = computed(() => props.height - PAD.t - PAD.b);

const hiddenSeries = ref(new Set());
const hoverIndex = ref(-1);

function toggleSeries(idx) {
  const next = new Set(hiddenSeries.value);
  if (next.has(idx)) next.delete(idx);
  else next.add(idx);
  hiddenSeries.value = next;
}

const visibleDatasets = computed(() =>
  props.datasets.map((ds, i) => hiddenSeries.value.has(i) ? { ...ds, _hidden: true } : ds),
);

function _yMaxFor(axis) {
  let m = 0;
  for (let di = 0; di < props.datasets.length; di++) {
    if (hiddenSeries.value.has(di)) continue;
    const ds = props.datasets[di];
    const onAxis = axis === 'y' ? (ds.yAxisID || 'y') === 'y' : (ds.yAxisID === 'y2');
    if (!onAxis) continue;
    for (const v of ds.data) if (typeof v === 'number' && v > m) m = v;
  }
  return m > 0 ? m : 1;
}

const yMax = computed(() => _yMaxFor('y'));
const y2Max = computed(() => _yMaxFor('y2'));

function xFor(i) {
  const n = Math.max(1, props.labels.length - 1);
  return PAD.l + (i / n) * innerW.value;
}
function yFor(v, axis = 'y') {
  const max = axis === 'y2' ? y2Max.value : yMax.value;
  return PAD.t + innerH.value - (v / max) * innerH.value;
}

function pathOf(ds) {
  const pts = ds.data || [];
  let d = '';
  let started = false;
  for (let i = 0; i < pts.length; i++) {
    const v = pts[i];
    if (v == null || !Number.isFinite(v)) { started = false; continue; }
    const x = xFor(i);
    const y = yFor(v, ds.yAxisID || 'y');
    d += (!started ? `M${x},${y}` : ` L${x},${y}`);
    started = true;
  }
  return d;
}

function fillPathOf(ds) {
  const pts = ds.data || [];
  let firstIdx = -1; let lastIdx = -1;
  for (let i = 0; i < pts.length; i++) {
    if (pts[i] != null && Number.isFinite(pts[i])) {
      if (firstIdx < 0) firstIdx = i;
      lastIdx = i;
    }
  }
  if (firstIdx < 0) return '';
  let d = pathOf(ds);
  if (!d) return '';
  d += ` L${xFor(lastIdx)},${PAD.t + innerH.value} L${xFor(firstIdx)},${PAD.t + innerH.value} Z`;
  return d;
}

const ticksY = computed(() => {
  const out = []; const max = yMax.value;
  for (let i = 0; i <= 4; i++) {
    const v = (max * i) / 4;
    out.push({ y: yFor(v), label: _formatNum(v) });
  }
  return out;
});

const ticksY2 = computed(() => {
  if (!props.showSecondAxis) return [];
  const out = []; const max = y2Max.value;
  for (let i = 0; i <= 4; i++) {
    const v = (max * i) / 4;
    out.push({ y: yFor(v, 'y2'), label: _formatNum(v) });
  }
  return out;
});

function _formatNum(v) {
  if (v >= 1000) return `${Math.round(v / 100) / 10}k`;
  return Math.round(v).toString();
}

function _formatTooltipNum(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
}

const xLabels = computed(() => {
  const labels = props.labels;
  const n = labels.length;
  if (n <= 8) return labels.map((l, i) => ({ x: xFor(i), label: _shortLabel(l) }));
  const step = Math.ceil(n / 8);
  return labels.map((l, i) => ({ x: xFor(i), label: i % step === 0 ? _shortLabel(l) : '' }));
});

function _shortLabel(label) {
  if (!label) return '';
  const m = String(label).match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
  if (!m) return label;
  const months = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const mo = months[parseInt(m[2], 10) - 1] || '';
  if (m[3] && m[3] !== '01') return `${parseInt(m[3], 10)} ${mo}`;
  return `${mo} ${m[1].slice(2)}`;
}

const chartAnnotations = computed(() => {
  const labels = props.labels || [];
  return (props.annotations || [])
    .map((item, idx) => {
      const key = String(item.bucket || item.date || '').slice(0, 10);
      const labelIdx = labels.findIndex((label) => String(label).slice(0, 10) === key);
      if (labelIdx < 0) return null;
      return {
        id: `${idx}:${key}`,
        x: xFor(labelIdx),
        label: String(item.label || '').slice(0, 36),
      };
    })
    .filter(Boolean);
});

// Hover tooltip data
const tooltipData = computed(() => {
  if (hoverIndex.value < 0 || hoverIndex.value >= props.labels.length) return null;
  const idx = hoverIndex.value;
  const items = props.datasets.map((ds, di) => ({
    label: ds.label,
    color: ds.color,
    value: ds.data?.[idx],
    hidden: hiddenSeries.value.has(di),
  })).filter((it) => !it.hidden);
  return { label: props.labels[idx], x: xFor(idx), items };
});

// Invisible hover rects for each data point column
const hoverZones = computed(() => {
  const n = props.labels.length;
  if (n < 1) return [];
  const colW = n > 1 ? innerW.value / (n - 1) : innerW.value;
  return props.labels.map((_, i) => ({
    x: xFor(i) - colW / 2,
    w: colW,
    idx: i,
  }));
});

function onHover(idx) { hoverIndex.value = idx; }
function onLeave() { hoverIndex.value = -1; }

// --- Сводка тренда справа от графика (по запросу клиента) ---
// Для каждой видимой серии строим линию тренда методом наименьших квадратов
// (линейная регрессия) и считаем долю роста в % по концам этой линии. Это
// устойчивее «первое/последнее значение» и честно отражает направление тренда.
function _linregress(data) {
  const pts = [];
  (data || []).forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) return;
    pts.push([i, v]);
  });
  if (pts.length < 2) {
    const only = pts.length === 1 ? pts[0][1] : null;
    return { slope: 0, intercept: only, fitFirst: only, fitLast: only, n: pts.length };
  }
  const n = pts.length;
  let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const denom = n * sxx - sx * sx;
  const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
  const intercept = (sy - slope * sx) / n;
  return {
    slope,
    intercept,
    fitFirst: slope * pts[0][0] + intercept,
    fitLast: slope * pts[pts.length - 1][0] + intercept,
    n,
  };
}

const trendSummary = computed(() => {
  return props.datasets.map((ds, di) => {
    const { slope, fitFirst, fitLast, n } = _linregress(ds.data);
    if (fitFirst === null || fitLast === null || n < 1) {
      return { label: ds.label, color: ds.color, hidden: hiddenSeries.value.has(di), empty: true };
    }
    const delta = fitLast - fitFirst;
    const pct = fitFirst !== 0 ? (delta / Math.abs(fitFirst)) * 100 : null;
    const dir = slope > 0 ? 'up' : (slope < 0 ? 'down' : 'flat');
    return {
      label: ds.label,
      color: ds.color,
      hidden: hiddenSeries.value.has(di),
      empty: false,
      first: fitFirst, last: fitLast, delta, pct, dir, slope,
    };
  });
});

// Геометрия линии тренда для отрисовки прямо на графике (только видимые серии).
const trendLines = computed(() => {
  const n = props.labels.length;
  if (n < 2) return [];
  return props.datasets.map((ds, di) => {
    if (hiddenSeries.value.has(di)) return null;
    const { slope, intercept, n: cnt } = _linregress(ds.data);
    if (cnt < 2) return null;
    const axis = ds.yAxisID || 'y';
    return {
      color: ds.color,
      x1: xFor(0),
      x2: xFor(n - 1),
      y1: yFor(intercept, axis),
      y2: yFor(slope * (n - 1) + intercept, axis),
    };
  }).filter(Boolean);
});

function _fmtDelta(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return sign + Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
}
function _fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return '';
  const sign = v > 0 ? '+' : '';
  return `${sign}${Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
}
</script>

<template>
  <div class="report-trend-chart" @mouseleave="onLeave">
    <!-- ТЗ #1: баннер «нет истории раньше DD.MM.YYYY», когда источник
         (например, новый GSC-проект) вернул данные позже запрошенного from. -->
    <div v-if="sourceStartNotice" class="chart-source-notice">
      ℹ {{ sourceStartNotice }}
    </div>
    <div class="chart-row">
      <div class="chart-canvas">
      <svg :viewBox="`0 0 ${width} ${height}`" class="w-full h-auto" preserveAspectRatio="none">
      <!-- Y grid -->
      <g class="grid" stroke="rgba(0,0,0,0.06)" stroke-width="1">
        <line v-for="(t,i) in ticksY" :key="`gy${i}`" :x1="PAD.l" :x2="width - PAD.r" :y1="t.y" :y2="t.y" />
      </g>
      <!-- Y axis labels (left) -->
      <g class="ylabels" font-size="10" fill="rgba(0,0,0,0.55)" font-family="-apple-system, sans-serif">
        <text v-for="(t,i) in ticksY" :key="`yl${i}`" :x="PAD.l - 6" :y="t.y + 3" text-anchor="end">{{ t.label }}</text>
      </g>
      <!-- Y axis labels (right, %) -->
      <g v-if="showSecondAxis" font-size="10" fill="#6e5dc6" font-family="-apple-system, sans-serif">
        <text v-for="(t,i) in ticksY2" :key="`y2l${i}`" :x="width - PAD.r + 6" :y="t.y + 3" text-anchor="start">{{ t.label }}</text>
      </g>
      <!-- X labels -->
      <g class="xlabels" font-size="10" fill="rgba(0,0,0,0.55)" font-family="-apple-system, sans-serif">
        <text v-for="(t,i) in xLabels" :key="`x${i}`" :x="t.x" :y="height - PAD.b + 16" text-anchor="middle">{{ t.label }}</text>
      </g>
      <g v-if="chartAnnotations.length">
        <g v-for="item in chartAnnotations" :key="item.id">
          <line :x1="item.x" :x2="item.x" :y1="PAD.t" :y2="PAD.t + innerH" stroke="rgba(245,158,11,0.5)" stroke-dasharray="5,4" />
          <rect :x="Math.max(PAD.l, item.x - 54)" :y="PAD.t + 6" width="108" height="20" rx="10" fill="rgba(245,158,11,0.14)" />
          <text :x="item.x" :y="PAD.t + 20" text-anchor="middle" font-size="10" fill="#b45309">{{ item.label }}</text>
        </g>
      </g>
      <!-- Datasets -->
      <g v-for="(ds, di) in visibleDatasets" :key="`ds${di}`">
        <template v-if="!ds._hidden">
          <path v-if="ds.fill"
                :d="fillPathOf(ds)"
                :fill="ds.color"
                fill-opacity="0.12"
                stroke="none" />
          <path :d="pathOf(ds)"
                fill="none"
                :stroke="ds.color"
                stroke-width="2"
                :stroke-dasharray="ds.dashed ? '6,4' : '0'"
                stroke-linecap="round"
                stroke-linejoin="round" />
        </template>
      </g>
      <!-- Trend delta labels at line endpoints removed (см. trendDeltas computed) -->

      <!-- Линии тренда (линейная регрессия) для каждой видимой серии -->
      <line v-for="(tl, ti) in trendLines" :key="`trend${ti}`"
            :x1="tl.x1" :y1="tl.y1" :x2="tl.x2" :y2="tl.y2"
            :stroke="tl.color" stroke-width="1.5"
            stroke-dasharray="7,5" stroke-opacity="0.65"
            stroke-linecap="round" />

      <!-- Hover crosshair + dots -->
      <template v-if="hoverIndex >= 0 && hoverIndex < labels.length">
        <line :x1="xFor(hoverIndex)" :x2="xFor(hoverIndex)"
              :y1="PAD.t" :y2="PAD.t + innerH"
              stroke="rgba(0,0,0,0.15)" stroke-width="1" stroke-dasharray="3,3" />
        <template v-for="(ds, di) in datasets" :key="`dot${di}`">
          <circle v-if="!hiddenSeries.has(di) && ds.data?.[hoverIndex] != null && Number.isFinite(ds.data[hoverIndex])"
                  :cx="xFor(hoverIndex)"
                  :cy="yFor(ds.data[hoverIndex], ds.yAxisID || 'y')"
                  r="4" :fill="ds.color" stroke="#fff" stroke-width="2" />
        </template>
      </template>
      <!-- Invisible hover zones -->
      <g>
        <rect v-for="hz in hoverZones" :key="`hz${hz.idx}`"
              :x="Math.max(PAD.l, hz.x)" :y="PAD.t"
              :width="Math.min(hz.w, width - PAD.r - Math.max(PAD.l, hz.x))"
              :height="innerH"
              fill="transparent"
              @mouseenter="onHover(hz.idx)"
              style="cursor: crosshair" />
      </g>
    </svg>
    <!-- Tooltip -->
    <div v-if="tooltipData" class="chart-tooltip"
         :style="{ left: `${Math.min(Math.max(tooltipData.x / width * 100, 10), 90)}%` }">
      <div class="tooltip-date">{{ tooltipData.label }}</div>
      <div v-for="(item, idx) in tooltipData.items" :key="idx" class="tooltip-row">
        <span class="tooltip-dot" :style="{ background: item.color }" />
        <span class="tooltip-label">{{ item.label }}</span>
        <span class="tooltip-value">{{ _formatTooltipNum(item.value) }}</span>
      </div>
    </div>
      </div>
      <!-- Сводка тренда справа: дельта и доля роста по каждой серии -->
      <aside v-if="showTrend" class="trend-side">
        <div class="trend-side-title">Динамика за период</div>
        <div v-for="(t, i) in trendSummary" :key="`tr${i}`"
             class="trend-row" :class="{ dimmed: t.hidden }">
          <span class="trend-swatch" :style="{ background: t.color }" />
          <span class="trend-label">{{ t.label }}</span>
          <template v-if="!t.empty">
            <span class="trend-delta" :class="`trend-${t.dir}`">
              <template v-if="t.dir === 'up'">▲</template>
              <template v-else-if="t.dir === 'down'">▼</template>
              <template v-else>—</template>
              {{ _fmtPct(t.pct) }}
            </span>
            <span class="trend-abs">{{ _fmtDelta(t.delta) }}</span>
          </template>
          <span v-else class="trend-abs">—</span>
        </div>
      </aside>
    </div>
    <!-- Legend -->
    <div class="chart-legend">
      <button v-for="(ds, i) in datasets" :key="`lg${i}`"
              class="legend-item" :class="{ dimmed: hiddenSeries.has(i) }"
              @click="toggleSeries(i)">
        <span class="legend-swatch" :style="{
          borderColor: ds.color,
          borderStyle: ds.dashed ? 'dashed' : 'solid',
          opacity: hiddenSeries.has(i) ? 0.35 : 1,
        }" />
        <span class="legend-text" :style="{ color: hiddenSeries.has(i) ? 'rgba(0,0,0,0.3)' : ds.color }">{{ ds.label }}</span>
      </button>
    </div>
    <!-- ТЗ #1: подпись диапазона под графиком, чтобы клиент видел, какой
         именно период визуализирован, и понимал размер оси X. -->
    <div v-if="rangeCaption" class="chart-range-caption">{{ rangeCaption }}</div>
  </div>
</template>

<style scoped>
.report-trend-chart { width: 100%; position: relative; }
.chart-source-notice {
  margin: 0 0 8px;
  padding: 6px 10px;
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.25);
  border-radius: 6px;
  font-size: 12px;
  color: #92400e;
}
.chart-range-caption {
  margin-top: 6px;
  color: #6e6e73;
  font-size: 11px;
  text-align: center;
  letter-spacing: 0.02em;
}
.chart-row { display: flex; align-items: stretch; gap: 16px; }
.chart-canvas { flex: 1 1 auto; position: relative; min-width: 0; }
.trend-side {
  flex: 0 0 200px;
  display: flex; flex-direction: column; gap: 6px;
  padding: 12px;
  border-left: 1px solid rgba(0,0,0,0.06);
  font-size: 12px;
}
.trend-side-title {
  font-weight: 600; color: #6e6e73; font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 4px;
}
.trend-row {
  display: grid;
  grid-template-columns: 10px 1fr auto;
  grid-template-areas: "sw lbl delta" "sw lbl abs";
  align-items: center;
  column-gap: 6px;
  padding: 4px 0;
  border-bottom: 1px solid rgba(0,0,0,0.04);
}
.trend-row.dimmed { opacity: 0.4; }
.trend-swatch { grid-area: sw; width: 8px; height: 8px; border-radius: 2px; }
.trend-label { grid-area: lbl; color: #1d1d1f; font-weight: 500; }
.trend-delta { grid-area: delta; font-weight: 600; text-align: right; white-space: nowrap; }
.trend-abs { grid-area: abs; color: #8a8a8e; text-align: right; font-size: 11px; white-space: nowrap; }
.trend-up { color: #2e7d32; }
.trend-down { color: #c62828; }
.trend-flat { color: #8a8a8e; }
@media (max-width: 720px) {
  .chart-row { flex-direction: column; }
  .trend-side { flex-basis: auto; border-left: none; border-top: 1px solid rgba(0,0,0,0.06); }
}
.chart-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin-top: 8px;
  font-size: 12px;
}
.legend-item {
  display: inline-flex; align-items: center; gap: 6px;
  background: none; border: none; padding: 4px 6px; border-radius: 8px;
  cursor: pointer; transition: opacity 0.15s;
  font: inherit;
}
.legend-item:hover { background: rgba(0,0,0,0.04); }
.legend-item.dimmed { opacity: 0.55; }
.legend-swatch {
  display: inline-block;
  width: 18px; height: 0; border-top: 3px solid;
}
.legend-text {
  font-weight: 500;
  transition: color 0.15s;
}
.chart-tooltip {
  position: absolute;
  top: 8px;
  transform: translateX(-50%);
  background: rgba(255,255,255,0.96);
  border: 1px solid rgba(60,60,67,0.12);
  border-radius: 12px;
  padding: 10px 14px;
  font-size: 12px;
  pointer-events: none;
  box-shadow: 0 4px 16px rgba(0,0,0,0.10);
  z-index: 10;
  min-width: 140px;
  backdrop-filter: blur(8px);
}
.tooltip-date {
  font-weight: 600; margin-bottom: 6px; color: #1d1d1f;
}
.tooltip-row {
  display: flex; align-items: center; gap: 6px;
  margin-bottom: 3px;
}
.tooltip-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
}
.tooltip-label { color: #6e6e73; flex: 1; }
.tooltip-value { font-weight: 600; color: #1d1d1f; }
</style>
