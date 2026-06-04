<script setup>
/**
 * GscPerformanceChart.vue — SVG-график эффективности GSC.
 *
 * Без внешних зависимостей. Сдержанный, «эпловский» стиль: чистая сетка,
 * мягкая заливка под линией, плавная отрисовка, аккуратная адаптивная вёрстка.
 *
 * Разбивка по вкладкам (как в нативном GSC):
 *   • «Показы и клики» — две линии в одном поле, каждая со своей шкалой.
 *   • «Позиция»        — средняя позиция (1 — наверху, меньше = лучше).
 *   • «CTR»            — кликабельность, %.
 *
 * Гранулярность (сортировка/агрегация): дни · недели · месяцы · годы.
 *   — Показы и клики суммируются.
 *   — CTR пересчитывается как Σкликов / Σпоказов.
 *   — Позиция усредняется с весом по показам.
 */
import { computed, ref } from 'vue';

const props = defineProps({
  series: { type: Array, required: true }, // [{date,clicks,impressions,ctr,position}]
  width:  { type: Number, default: 920 },
  height: { type: Number, default: 320 },
});

const PAD = { l: 44, r: 18, t: 18, b: 38 };

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

const METRICS = {
  clicks:      { label: 'Клики',           color: '#6366f1', unit: '',  position: false },
  impressions: { label: 'Показы',          color: '#8b5cf6', unit: '',  position: false },
  ctr:         { label: 'CTR',             color: '#10b981', unit: '%', position: false },
  position:    { label: 'Средняя позиция', color: '#f59e0b', unit: '',  position: true  },
};

const TABS = [
  { key: 'volume',   label: 'Показы и клики', metrics: ['impressions', 'clicks'] },
  { key: 'position', label: 'Позиция',        metrics: ['position'] },
  { key: 'ctr',      label: 'CTR',            metrics: ['ctr'] },
];

const GRANS = [
  { key: 'day',   label: 'Дни' },
  { key: 'week',  label: 'Недели' },
  { key: 'month', label: 'Месяцы' },
  { key: 'year',  label: 'Годы' },
];

const activeTab = ref('volume');
const granularity = ref('day');

const tab = computed(() => TABS.find((t) => t.key === activeTab.value) || TABS[0]);
const activeMetrics = computed(() => tab.value.metrics);

// ── Агрегация по выбранной гранулярности ──────────────────────────────────
function bucketOf(dateStr, gran) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return { key: String(dateStr), label: String(dateStr), sort: String(dateStr) };
  const [, y, mo, d] = m;
  if (gran === 'year') return { key: y, label: y, sort: y };
  if (gran === 'month') return { key: `${y}-${mo}`, label: `${MONTHS[+mo - 1]} ${y.slice(2)}`, sort: `${y}${mo}` };
  if (gran === 'week') {
    const dt = new Date(Date.UTC(+y, +mo - 1, +d));
    const offset = (dt.getUTCDay() + 6) % 7; // понедельник = 0
    dt.setUTCDate(dt.getUTCDate() - offset);
    const wy = dt.getUTCFullYear();
    const wm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const wd = String(dt.getUTCDate()).padStart(2, '0');
    return { key: `${wy}-${wm}-${wd}`, label: `${wd}.${wm}`, sort: `${wy}${wm}${wd}` };
  }
  return { key: `${y}-${mo}-${d}`, label: `${d}.${mo}`, sort: `${y}${mo}${d}` };
}

const points = computed(() => {
  const raw = Array.isArray(props.series) ? props.series : [];
  const map = new Map();
  for (const p of raw) {
    const b = bucketOf(p.date, granularity.value);
    let acc = map.get(b.key);
    if (!acc) {
      acc = { date: b.key, label: b.label, sort: b.sort, clicks: 0, impressions: 0, _posW: 0, _posN: 0 };
      map.set(b.key, acc);
    }
    const cl = Number(p.clicks) || 0;
    const im = Number(p.impressions) || 0;
    const pos = Number(p.position) || 0;
    acc.clicks += cl;
    acc.impressions += im;
    if (pos > 0) { const w = im || 1; acc._posW += pos * w; acc._posN += w; }
  }
  const out = [...map.values()].sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
  for (const a of out) {
    a.ctr = a.impressions ? +((a.clicks / a.impressions) * 100).toFixed(2) : 0;
    a.position = a._posN ? +(a._posW / a._posN).toFixed(1) : 0;
  }
  return out;
});

const innerW = computed(() => props.width - PAD.l - PAD.r);
const innerH = computed(() => props.height - PAD.t - PAD.b);
const usableH = computed(() => innerH.value * 0.9);
const topY = computed(() => PAD.t + innerH.value * 0.05);

function xFor(i) {
  const n = points.value.length;
  if (n <= 1) return PAD.l + innerW.value / 2;
  return PAD.l + (i / (n - 1)) * innerW.value;
}

function niceCeil(v) {
  if (v <= 0) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / e;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * e;
}

// Шкала (домен) для каждой метрики: [lo (низ), hi (верх)].
const domains = computed(() => {
  const out = {};
  for (const key of activeMetrics.value) {
    const vals = points.value.map((p) => Number(p[key]) || 0);
    if (METRICS[key].position) {
      const pv = vals.filter((v) => v > 0);
      const mn = pv.length ? Math.min(...pv) : 1;
      const mx = pv.length ? Math.max(...pv) : 10;
      // Верх = лучшая (меньшая) позиция, низ = худшая.
      out[key] = { lo: mx === mn ? mx + 1 : mx, hi: Math.max(1, Math.floor(mn)) };
    } else {
      out[key] = { lo: 0, hi: niceCeil(Math.max(1, ...vals)) };
    }
  }
  return out;
});

function yFor(key, value) {
  const d = domains.value[key];
  if (!d) return topY.value + usableH.value;
  const span = d.hi - d.lo || 1;
  const frac = (( (Number(value) || 0) - d.lo) / span);
  const clamped = Math.max(0, Math.min(1, frac));
  return topY.value + usableH.value - clamped * usableH.value;
}

function pathFor(key) {
  const pts = points.value;
  if (!pts.length) return '';
  let d = '';
  for (let i = 0; i < pts.length; i++) {
    const x = xFor(i);
    const y = yFor(key, pts[i][key]);
    d += i === 0 ? `M${x},${y}` : ` L${x},${y}`;
  }
  return d;
}

function areaFor(key) {
  const line = pathFor(key);
  if (!line) return '';
  const pts = points.value;
  const baseY = topY.value + usableH.value;
  return `${line} L${xFor(pts.length - 1)},${baseY} L${xFor(0)},${baseY} Z`;
}

// Горизонтальная сетка + подписи по первой (ведущей) метрике вкладки.
const primaryKey = computed(() => activeMetrics.value[0]);
const gridLines = computed(() => {
  const key = primaryKey.value;
  const d = domains.value[key];
  if (!d) return [];
  const fracs = [0, 0.25, 0.5, 0.75, 1];
  return fracs.map((g) => {
    const value = d.lo + g * (d.hi - d.lo);
    return { y: topY.value + usableH.value - g * usableH.value, label: fmtAxis(key, value) };
  });
});

function fmtAxis(key, value) {
  if (METRICS[key].position) return (Math.round(value * 10) / 10).toFixed(1);
  if (key === 'ctr') return `${Math.round(value * 10) / 10}%`;
  return _short(value);
}

function _short(v) {
  const n = Number(v) || 0;
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

function fmtVal(key, value) {
  const v = Number(value) || 0;
  if (METRICS[key].position) return v.toFixed(1);
  if (key === 'ctr') return `${v}%`;
  return v.toLocaleString('ru');
}

// X-подписи (максимум 7 равномерно).
const xLabels = computed(() => {
  const pts = points.value;
  const n = pts.length;
  if (!n) return [];
  const count = Math.min(7, n);
  const out = [];
  for (let j = 0; j < count; j++) {
    const i = Math.round((j / (count - 1 || 1)) * (n - 1));
    out.push({ x: xFor(i), label: pts[i].label });
  }
  return out;
});

// ── Hover ─────────────────────────────────────────────────────────────────
const hoverIdx = ref(-1);
function onMove(evt) {
  const rect = evt.currentTarget.getBoundingClientRect();
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
  return Math.max(4, Math.min(props.width - 180, ratio * props.width - 84));
});

// Ключ для пере-проигрывания анимации отрисовки линий.
const animKey = computed(() => `${activeTab.value}:${granularity.value}:${points.value.length}`);
</script>

<template>
  <div class="gsc-chart w-full">
    <!-- Панель управления: вкладки метрик + гранулярность -->
    <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
      <div class="seg" role="tablist" aria-label="Метрики">
        <button v-for="t in TABS" :key="t.key" type="button" role="tab"
                :aria-selected="activeTab === t.key"
                class="seg-btn" :class="{ 'seg-btn--on': activeTab === t.key }"
                @click="activeTab = t.key">{{ t.label }}</button>
      </div>
      <div class="seg seg--muted" role="group" aria-label="Период">
        <button v-for="g in GRANS" :key="g.key" type="button"
                class="seg-btn" :class="{ 'seg-btn--on': granularity === g.key }"
                @click="granularity = g.key">{{ g.label }}</button>
      </div>
    </div>

    <!-- Текущие метрики -->
    <div class="flex flex-wrap gap-4 mb-2">
      <span v-for="key in activeMetrics" :key="key" class="flex items-center gap-1.5 text-xs text-gray-300">
        <span class="inline-block w-3 h-1.5 rounded-full" :style="{ background: METRICS[key].color }"></span>
        {{ METRICS[key].label }}
      </span>
    </div>

    <div class="relative">
      <svg :viewBox="`0 0 ${width} ${height}`" class="w-full h-auto select-none"
           @mousemove="onMove" @mouseleave="onLeave">
        <defs>
          <linearGradient v-for="key in activeMetrics" :key="'g' + key" :id="'grad-' + key" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" :stop-color="METRICS[key].color" stop-opacity="0.22" />
            <stop offset="100%" :stop-color="METRICS[key].color" stop-opacity="0" />
          </linearGradient>
        </defs>

        <!-- Горизонтальная сетка + подписи оси Y -->
        <g>
          <line v-for="(gl, i) in gridLines" :key="'gl' + i"
                :x1="PAD.l" :y1="gl.y" :x2="width - PAD.r" :y2="gl.y"
                stroke="#1f2937" stroke-width="1" :stroke-dasharray="i === 0 ? '0' : '2 4'" />
          <text v-for="(gl, i) in gridLines" :key="'gt' + i"
                :x="PAD.l - 8" :y="gl.y + 3" text-anchor="end" fill="#6b7280" font-size="10">{{ gl.label }}</text>
        </g>

        <!-- Заливка + линии (с анимацией отрисовки) -->
        <g :key="animKey">
          <path v-for="key in activeMetrics" :key="'a' + key" :d="areaFor(key)"
                :fill="`url(#grad-${key})`" class="gsc-area" />
          <path v-for="key in activeMetrics" :key="'l' + key" :d="pathFor(key)" fill="none"
                :stroke="METRICS[key].color" stroke-width="2.25" stroke-linejoin="round"
                stroke-linecap="round" pathLength="1" class="gsc-line" />
        </g>

        <!-- Hover: направляющая + точки -->
        <template v-if="hoverPoint">
          <line :x1="hoverPoint.x" :y1="topY" :x2="hoverPoint.x" :y2="topY + usableH"
                stroke="#374151" stroke-width="1" stroke-dasharray="3 3" />
          <circle v-for="key in activeMetrics" :key="'h' + key"
                  :cx="hoverPoint.x" :cy="yFor(key, hoverPoint.p[key])" r="3.75"
                  :fill="METRICS[key].color" stroke="#0b0f19" stroke-width="1.5" />
        </template>

        <!-- X-подписи -->
        <text v-for="(lb, i) in xLabels" :key="'x' + i" :x="lb.x" :y="height - 12"
              text-anchor="middle" fill="#6b7280" font-size="10">{{ lb.label }}</text>
      </svg>

      <!-- Тултип -->
      <transition name="tip">
        <div v-if="hoverPoint"
             class="absolute top-1 bg-gray-950/95 backdrop-blur border border-gray-700 rounded-lg px-3 py-2 text-xs pointer-events-none shadow-xl"
             :style="{ left: tooltipLeft + 'px', width: '168px' }">
          <div class="text-gray-400 mb-1">{{ hoverPoint.p.label }}</div>
          <div v-for="key in activeMetrics" :key="'t' + key" class="flex items-center justify-between py-0.5">
            <span class="flex items-center gap-1.5 text-gray-300">
              <span class="inline-block w-2 h-2 rounded-full" :style="{ background: METRICS[key].color }"></span>
              {{ METRICS[key].label }}
            </span>
            <span class="text-gray-100 font-medium">{{ fmtVal(key, hoverPoint.p[key]) }}{{ METRICS[key].unit }}</span>
          </div>
        </div>
      </transition>
    </div>
  </div>
</template>

<style scoped>
/* Сегментированные переключатели в духе iOS/macOS. */
.seg {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border-radius: 10px;
  background: rgba(31, 41, 55, 0.55);
  border: 1px solid rgba(55, 65, 81, 0.6);
}
.seg-btn {
  appearance: none;
  border: 0;
  background: transparent;
  color: #9ca3af;
  font-size: 12px;
  line-height: 1;
  padding: 6px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: color 0.2s ease, background-color 0.2s ease, box-shadow 0.2s ease;
}
.seg-btn:hover { color: #e5e7eb; }
.seg-btn--on {
  color: #f9fafb;
  background: rgba(99, 102, 241, 0.22);
  box-shadow: inset 0 0 0 1px rgba(129, 140, 248, 0.45);
}
.seg--muted .seg-btn--on {
  background: rgba(148, 163, 184, 0.18);
  box-shadow: inset 0 0 0 1px rgba(148, 163, 184, 0.4);
  color: #e5e7eb;
}

/* Плавная «прорисовка» линии и проявление заливки. */
.gsc-line {
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  animation: gsc-draw 0.7s cubic-bezier(0.22, 0.61, 0.36, 1) forwards;
}
.gsc-area {
  opacity: 0;
  animation: gsc-fade 0.7s ease forwards;
  animation-delay: 0.15s;
}
@keyframes gsc-draw { to { stroke-dashoffset: 0; } }
@keyframes gsc-fade { to { opacity: 1; } }

@media (prefers-reduced-motion: reduce) {
  .gsc-line { animation: none; stroke-dashoffset: 0; }
  .gsc-area { animation: none; opacity: 1; }
}

.tip-enter-active, .tip-leave-active { transition: opacity 0.15s ease; }
.tip-enter-from, .tip-leave-to { opacity: 0; }
</style>
