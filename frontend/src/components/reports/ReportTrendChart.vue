<script setup>
/**
 * ReportTrendChart.vue — мульти-серия линейного SVG-графика без зависимостей.
 * Рисует:
 *   • до 4 серий с заданными цветами,
 *   • прогноз пунктиром (поле dashed=true) с заливкой зоны 15% opacity,
 *   • двух-осный режим (yAxisID='y2'): отдельная правая ось для visibility.
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
 */
import { computed } from 'vue';

const props = defineProps({
  labels: { type: Array, default: () => [] },
  datasets: { type: Array, default: () => [] },
  width: { type: Number, default: 880 },
  height: { type: Number, default: 320 },
  showSecondAxis: { type: Boolean, default: false },
});

const PAD = { l: 50, r: 50, t: 16, b: 36 };

const innerW = computed(() => props.width - PAD.l - PAD.r);
const innerH = computed(() => props.height - PAD.t - PAD.b);

function _yMaxFor(axis) {
  let m = 0;
  for (const ds of props.datasets) {
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
  // Простейшая зона: линия + спуск к низу первого/последнего ненулевого x.
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
    out.push({ y: yFor(v, 'y2'), label: _formatPct(v) });
  }
  return out;
});

function _formatNum(v) {
  if (v >= 1000) return `${Math.round(v / 100) / 10}k`;
  return Math.round(v).toString();
}
function _formatPct(v) {
  return `${Math.round(v * 1000) / 10}%`;
}

const xLabels = computed(() => {
  // Показываем не более 8 подписей.
  const labels = props.labels;
  const n = labels.length;
  if (n <= 8) return labels.map((l, i) => ({ x: xFor(i), label: _shortMonth(l) }));
  const step = Math.ceil(n / 8);
  return labels.map((l, i) => ({ x: xFor(i), label: i % step === 0 ? _shortMonth(l) : '' }));
});

function _shortMonth(label) {
  if (!label) return '';
  // YYYY-MM-DD → "Янв 2026"
  const m = String(label).match(/^(\d{4})-(\d{2})/);
  if (!m) return label;
  const months = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  return `${months[parseInt(m[2], 10) - 1] || ''} ${m[1].slice(2)}`;
}
</script>

<template>
  <div class="report-trend-chart">
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
      <!-- Datasets -->
      <g v-for="(ds, di) in datasets" :key="`ds${di}`">
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
      </g>
    </svg>
    <div class="chart-legend">
      <span v-for="(ds, i) in datasets" :key="`lg${i}`" class="legend-item">
        <span class="legend-swatch" :style="{ backgroundColor: ds.color, borderStyle: ds.dashed ? 'dashed' : 'solid' }" />
        {{ ds.label }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.report-trend-chart { width: 100%; }
.chart-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 18px;
  margin-top: 6px;
  font-size: 12px;
  color: rgba(0,0,0,0.65);
}
.legend-item { display: inline-flex; align-items: center; gap: 6px; }
.legend-swatch {
  display: inline-block;
  width: 14px; height: 0; border-top-width: 3px; border-color: currentColor;
  background: transparent !important;
}
.legend-item .legend-swatch { background: transparent !important; }
.legend-item span.legend-swatch {
  width: 18px; height: 0; border-top: 3px solid; display: inline-block;
}
</style>
