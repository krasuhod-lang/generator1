<script setup>
/**
 * GscPerformanceChart.vue — SVG-график эффективности GSC (аналог нативного
 * графика Google Search Console). Без внешних зависимостей.
 *
 * 4 метрики: Клики, Показы, CTR (%), Средняя позиция. Каждая линия
 * нормируется по собственному максимуму (как в нативном GSC, где у метрик
 * разные оси), а в тултипе показываются реальные значения.
 *
 * Интерактив:
 *   • Кликабельная легенда — клик по метрике скрывает/показывает линию.
 *   • Hover → вертикальная направляющая + тултип со значениями за дату.
 *
 * Замечание про позицию: меньшая позиция = лучше, поэтому её линия
 * инвертируется (1 наверху), чтобы «рост вверх» означал улучшение.
 */
import { computed, ref } from 'vue';

const props = defineProps({
  series: { type: Array, required: true }, // [{date,clicks,impressions,ctr,position}]
  width:  { type: Number, default: 900 },
  height: { type: Number, default: 340 },
});

const PAD = { l: 16, r: 16, t: 16, b: 40 };

const METRICS = [
  { key: 'clicks',      label: 'Клики',           color: '#6366f1', invert: false, unit: '' },
  { key: 'impressions', label: 'Показы',          color: '#8b5cf6', invert: false, unit: '' },
  { key: 'ctr',         label: 'CTR',             color: '#10b981', invert: false, unit: '%' },
  { key: 'position',    label: 'Средняя позиция', color: '#f59e0b', invert: true,  unit: '' },
];

// Видимость метрик (toggle через легенду).
const visible = ref({ clicks: true, impressions: true, ctr: true, position: true });
function toggle(key) { visible.value[key] = !visible.value[key]; }

const points = computed(() => Array.isArray(props.series) ? props.series : []);
const innerW = computed(() => props.width - PAD.l - PAD.r);
const innerH = computed(() => props.height - PAD.t - PAD.b);

function xFor(i) {
  const n = points.value.length;
  if (n <= 1) return PAD.l + innerW.value / 2;
  return PAD.l + (i / (n - 1)) * innerW.value;
}

// Максимум по каждой метрике для индивидуальной нормализации.
const maxima = computed(() => {
  const m = { clicks: 1, impressions: 1, ctr: 1, position: 1 };
  for (const p of points.value) {
    for (const k of ['clicks', 'impressions', 'ctr', 'position']) {
      const v = Number(p[k]) || 0;
      if (v > m[k]) m[k] = v;
    }
  }
  return m;
});

function yFor(metric, value) {
  const v = Number(value) || 0;
  const max = maxima.value[metric.key] || 1;
  let frac = max ? v / max : 0;
  if (metric.invert) frac = 1 - frac; // позиция: меньше = выше
  // 6% отступ сверху/снизу, чтобы линии не липли к краям.
  const usable = innerH.value * 0.88;
  const top = PAD.t + innerH.value * 0.06;
  return top + usable - frac * usable;
}

function pathFor(metric) {
  const pts = points.value;
  if (!pts.length) return '';
  let d = '';
  for (let i = 0; i < pts.length; i++) {
    const x = xFor(i);
    const y = yFor(metric, pts[i][metric.key]);
    d += (i === 0 ? `M${x},${y}` : ` L${x},${y}`);
  }
  return d;
}

// X-метки (макс 6 равномерно).
const xLabels = computed(() => {
  const pts = points.value;
  const n = pts.length;
  if (!n) return [];
  const count = Math.min(6, n);
  const out = [];
  for (let j = 0; j < count; j++) {
    const i = Math.round((j / (count - 1 || 1)) * (n - 1));
    out.push({ x: xFor(i), label: _shortDate(pts[i].date) });
  }
  return out;
});

function _shortDate(d) {
  if (!d) return '';
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}` : String(d);
}

// Hover.
const hoverIdx = ref(-1);
function onMove(evt) {
  const svg = evt.currentTarget;
  const rect = svg.getBoundingClientRect();
  const x = (evt.clientX - rect.left) * (props.width / rect.width);
  const n = points.value.length;
  if (n <= 1) { hoverIdx.value = n - 1; return; }
  const rel = (x - PAD.l) / innerW.value;
  hoverIdx.value = Math.max(0, Math.min(n - 1, Math.round(rel * (n - 1))));
}
function onLeave() { hoverIdx.value = -1; }

const hoverPoint = computed(() => {
  const i = hoverIdx.value;
  if (i < 0 || i >= points.value.length) return null;
  return { i, x: xFor(i), p: points.value[i] };
});

const tooltipLeft = computed(() => {
  if (!hoverPoint.value) return 0;
  const ratio = hoverPoint.value.x / props.width;
  return Math.max(4, Math.min(props.width - 170, ratio * props.width - 80));
});
</script>

<template>
  <div class="w-full">
    <!-- Легенда (кликабельная) -->
    <div class="flex flex-wrap gap-3 mb-2">
      <button v-for="m in METRICS" :key="m.key" type="button"
              class="flex items-center gap-1.5 text-xs px-2 py-1 rounded border transition-colors"
              :class="visible[m.key] ? 'border-gray-700 text-gray-200' : 'border-gray-800 text-gray-600 line-through'"
              @click="toggle(m.key)">
        <span class="inline-block w-3 h-1.5 rounded-full" :style="{ background: m.color, opacity: visible[m.key] ? 1 : 0.3 }"></span>
        {{ m.label }}
      </button>
    </div>

    <div class="relative">
      <svg :viewBox="`0 0 ${width} ${height}`" class="w-full h-auto select-none"
           @mousemove="onMove" @mouseleave="onLeave">
        <!-- baseline -->
        <line :x1="PAD.l" :y1="height - PAD.b" :x2="width - PAD.r" :y2="height - PAD.b"
              stroke="#1f2937" stroke-width="1" />

        <!-- линии метрик -->
        <template v-for="m in METRICS" :key="m.key">
          <path v-if="visible[m.key]" :d="pathFor(m)" fill="none" :stroke="m.color"
                stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        </template>

        <!-- hover guide + точки -->
        <template v-if="hoverPoint">
          <line :x1="hoverPoint.x" :y1="PAD.t" :x2="hoverPoint.x" :y2="height - PAD.b"
                stroke="#374151" stroke-width="1" stroke-dasharray="3 3" />
          <template v-for="m in METRICS" :key="'h' + m.key">
            <circle v-if="visible[m.key]" :cx="hoverPoint.x" :cy="yFor(m, hoverPoint.p[m.key])"
                    r="3.5" :fill="m.color" stroke="#0b0f19" stroke-width="1.5" />
          </template>
        </template>

        <!-- x-метки -->
        <text v-for="(lb, i) in xLabels" :key="'x' + i" :x="lb.x" :y="height - PAD.b + 18"
              text-anchor="middle" fill="#6b7280" font-size="10">{{ lb.label }}</text>
      </svg>

      <!-- Тултип -->
      <div v-if="hoverPoint"
           class="absolute top-2 bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-xs pointer-events-none shadow-lg"
           :style="{ left: tooltipLeft + 'px', width: '160px' }">
        <div class="text-gray-400 mb-1">{{ hoverPoint.p.date }}</div>
        <div v-for="m in METRICS" :key="'t' + m.key" v-show="visible[m.key]"
             class="flex items-center justify-between">
          <span class="flex items-center gap-1">
            <span class="inline-block w-2 h-2 rounded-full" :style="{ background: m.color }"></span>
            {{ m.label }}
          </span>
          <span class="text-gray-100 font-medium">{{ hoverPoint.p[m.key] }}{{ m.unit }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
