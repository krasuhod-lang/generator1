<script setup>
/**
 * PositionChart.vue — SVG-график динамики позиций.
 *
 * Без внешних зависимостей. Показывает среднюю позицию (1 — сверху, ось Y
 * инвертирована) или доли ТОП-N (3 / 10 / 30) по букетам день/неделя/месяц.
 *
 * Props:
 *   • series — массив { bucket, avg_position, top3, top10, top30,
 *                       keywords_total, keywords_in_top }
 *   • mode   — 'position' | 'top'
 */
import { computed } from 'vue';

const props = defineProps({
  series: { type: Array, required: true },
  mode:   { type: String, default: 'position' }, // 'position' | 'top'
  width:  { type: Number, default: 920 },
  height: { type: Number, default: 320 },
});

const PAD = { l: 48, r: 18, t: 18, b: 38 };

const points = computed(() => Array.isArray(props.series) ? props.series : []);

const innerW = computed(() => Math.max(100, props.width  - PAD.l - PAD.r));
const innerH = computed(() => Math.max(60,  props.height - PAD.t - PAD.b));

// Diapazon Y
const yDomain = computed(() => {
  const pts = points.value;
  if (props.mode === 'position') {
    const vals = pts.map((p) => p.avg_position).filter((v) => v != null);
    if (!vals.length) return { min: 1, max: 50 };
    let min = Math.min(...vals);
    let max = Math.max(...vals);
    if (max - min < 5) { max = min + 5; }
    return { min: Math.max(1, Math.floor(min - 1)), max: Math.ceil(max + 1) };
  }
  // top%: 0..100
  return { min: 0, max: 100 };
});

function _x(i, n) {
  if (n <= 1) return PAD.l + innerW.value / 2;
  return PAD.l + (i * innerW.value) / (n - 1);
}
// position-mode: smaller value = higher on screen (Y inverted intentionally
// so "1" остаётся снизу значения, но «лучше». Для «эффекта инвертированной
// оси» (1 сверху) переворачиваем mapping).
function _yPos(value) {
  const { min, max } = yDomain.value;
  if (value == null) return null;
  const t = (value - min) / (max - min || 1);
  // top of chart = lowest position number; flip mapping
  return PAD.t + t * innerH.value;
}
function _yTop(value) {
  // value 0..100, 100 — сверху
  const t = value / 100;
  return PAD.t + (1 - t) * innerH.value;
}

const series1 = computed(() => {
  const pts = points.value;
  const n = pts.length;
  return pts.map((p, i) => {
    const v = props.mode === 'position'
      ? p.avg_position
      : (p.keywords_total ? (100 * (p.top10 || 0) / p.keywords_total) : null);
    return { x: _x(i, n), y: v == null ? null : (props.mode === 'position' ? _yPos(v) : _yTop(v)), v, label: p.bucket };
  });
});

// Для 'top'-режима добавляем линии ТОП-3 и ТОП-30.
const series2 = computed(() => {
  if (props.mode !== 'top') return [];
  const pts = points.value;
  const n = pts.length;
  return pts.map((p, i) => ({
    x: _x(i, n),
    y: p.keywords_total ? _yTop(100 * (p.top3 || 0) / p.keywords_total) : null,
    v: p.keywords_total ? +(100 * (p.top3 || 0) / p.keywords_total).toFixed(1) : null,
    label: p.bucket,
  }));
});
const series3 = computed(() => {
  if (props.mode !== 'top') return [];
  const pts = points.value;
  const n = pts.length;
  return pts.map((p, i) => ({
    x: _x(i, n),
    y: p.keywords_total ? _yTop(100 * (p.top30 || 0) / p.keywords_total) : null,
    v: p.keywords_total ? +(100 * (p.top30 || 0) / p.keywords_total).toFixed(1) : null,
    label: p.bucket,
  }));
});

function pathOf(s) {
  const pieces = [];
  let started = false;
  for (const p of s) {
    if (p.y == null) { started = false; continue; }
    pieces.push(`${started ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`);
    started = true;
  }
  return pieces.join(' ');
}

const path1 = computed(() => pathOf(series1.value));
const path2 = computed(() => pathOf(series2.value));
const path3 = computed(() => pathOf(series3.value));

const yTicks = computed(() => {
  const { min, max } = yDomain.value;
  const ticks = [];
  const steps = 5;
  for (let i = 0; i <= steps; i += 1) {
    const value = min + ((max - min) * i) / steps;
    const y = props.mode === 'position'
      ? PAD.t + (i / steps) * innerH.value
      : PAD.t + (1 - i / steps) * innerH.value;
    ticks.push({ y, value: props.mode === 'position' ? Math.round(value) : Math.round((i / steps) * 100) });
  }
  return ticks;
});

const xLabels = computed(() => {
  const pts = points.value;
  if (!pts.length) return [];
  const step = Math.max(1, Math.ceil(pts.length / 8));
  return pts.map((p, i) => ({
    x: _x(i, pts.length),
    label: p.bucket,
    show: i % step === 0 || i === pts.length - 1,
  }));
});

const isEmpty = computed(() => !points.value.some(
  (p) => (props.mode === 'position' ? p.avg_position : (p.keywords_total)),
));
</script>

<template>
  <div class="position-chart">
    <svg v-if="!isEmpty" :viewBox="`0 0 ${width} ${height}`" preserveAspectRatio="xMidYMid meet" class="w-full h-auto">
      <!-- grid -->
      <g stroke="#e5e7eb" stroke-width="1">
        <line v-for="(t, i) in yTicks" :key="i"
              :x1="PAD.l" :x2="width - PAD.r" :y1="t.y" :y2="t.y" />
      </g>
      <!-- y labels -->
      <g font-size="11" fill="#6b7280" text-anchor="end">
        <text v-for="(t, i) in yTicks" :key="'l'+i"
              :x="PAD.l - 6" :y="t.y + 4">{{ t.value }}{{ mode === 'top' ? '%' : '' }}</text>
      </g>
      <!-- main lines -->
      <path v-if="mode === 'top' && path3" :d="path3" fill="none" stroke="#fbbf24" stroke-width="2" />
      <path v-if="path1" :d="path1" fill="none" :stroke="mode === 'position' ? '#6366f1' : '#10b981'" stroke-width="2.4" />
      <path v-if="mode === 'top' && path2" :d="path2" fill="none" stroke="#ef4444" stroke-width="2" />
      <!-- points -->
      <g>
        <circle v-for="(p, i) in series1" :key="'p1'+i"
                v-show="p.y != null"
                :cx="p.x" :cy="p.y" r="3"
                :fill="mode === 'position' ? '#6366f1' : '#10b981'">
          <title>{{ p.label }}: {{ p.v }}{{ mode === 'top' ? '%' : '' }}</title>
        </circle>
      </g>
      <!-- x labels -->
      <g font-size="11" fill="#6b7280" text-anchor="middle">
        <text v-for="(l, i) in xLabels" :key="'x'+i"
              v-show="l.show"
              :x="l.x" :y="height - PAD.b + 18">{{ l.label }}</text>
      </g>
      <!-- legend -->
      <g v-if="mode === 'top'" font-size="11" fill="#374151" :transform="`translate(${PAD.l + 8}, ${PAD.t + 12})`">
        <g>
          <rect width="10" height="10" fill="#ef4444" rx="2" />
          <text x="14" y="9">ТОП-3</text>
        </g>
        <g transform="translate(70, 0)">
          <rect width="10" height="10" fill="#10b981" rx="2" />
          <text x="14" y="9">ТОП-10</text>
        </g>
        <g transform="translate(150, 0)">
          <rect width="10" height="10" fill="#fbbf24" rx="2" />
          <text x="14" y="9">ТОП-30</text>
        </g>
      </g>
    </svg>
    <div v-else class="empty">Данных пока нет — запустите первый съём позиций.</div>
  </div>
</template>

<style scoped>
.position-chart { width: 100%; }
.empty {
  padding: 32px;
  text-align: center;
  color: #6b7280;
  font-size: 14px;
  background: #f9fafb;
  border-radius: 12px;
  border: 1px dashed #e5e7eb;
}
</style>
