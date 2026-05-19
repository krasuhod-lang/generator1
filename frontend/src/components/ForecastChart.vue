<script setup>
/**
 * ForecastChart.vue — SVG-график помесячного спроса + прогноз + аномалии.
 *
 * Без внешних зависимостей. Принимает уже подготовленные данные:
 *   • historical: Array<{ period:'YYYY-MM', demand:number }>
 *   • forecastPoints: Array<{ period, value, lo, hi }>
 *   • trendEma: Array<number>  (length == historical.length)
 *   • anomalies: Array<{ from:'YYYY-MM', to:'YYYY-MM', severity:'low|mid|high' }>
 *
 * Рендерит:
 *   • синюю линию исторических данных,
 *   • пунктирную оранжевую линию прогноза,
 *   • полупрозрачную «ленту» 95% CI вокруг прогноза,
 *   • красные подсвеченные прямоугольники для аномальных зон,
 *   • зелёную сглаженную линию тренда (EMA).
 *
 * Интерактив:
 *   • hover → вертикальная направляющая, подсветка точки и тултип со всеми
 *     значениями за этот месяц (история / прогноз / CI / тренд),
 *   • плавная анимация появления линий (CSS-keyframe + stroke-dasharray),
 *   • плавный transition CI-области и направляющей.
 */
import { computed, ref } from 'vue';

const props = defineProps({
  historical:      { type: Array, required: true },
  forecastPoints:  { type: Array, default: () => [] },
  trendEma:        { type: Array, default: () => [] },
  anomalies:       { type: Array, default: () => [] },
  width:           { type: Number, default: 900 },
  height:          { type: Number, default: 360 },
});

const PAD = { l: 50, r: 20, t: 24, b: 50 };

const allPoints = computed(() => {
  const hist = (props.historical || []).map((p) => ({
    period: p.period, value: p.demand, type: 'hist',
  }));
  const fc = (props.forecastPoints || []).map((p) => ({
    period: p.period, value: p.value, lo: p.lo, hi: p.hi, type: 'fc',
  }));
  return [...hist, ...fc];
});

const yMax = computed(() => {
  let m = 0;
  for (const p of allPoints.value) {
    if (p.value > m) m = p.value;
    if (typeof p.hi === 'number' && p.hi > m) m = p.hi;
  }
  return m > 0 ? m : 1;
});

const innerW = computed(() => props.width - PAD.l - PAD.r);
const innerH = computed(() => props.height - PAD.t - PAD.b);

function xFor(i) {
  const n = allPoints.value.length;
  if (n <= 1) return PAD.l;
  return PAD.l + (i / (n - 1)) * innerW.value;
}
function yFor(v) {
  return PAD.t + innerH.value - (v / yMax.value) * innerH.value;
}

function indexOfPeriod(period) {
  return allPoints.value.findIndex((p) => p.period === period);
}

const histPath = computed(() => {
  const pts = props.historical || [];
  if (!pts.length) return '';
  let d = '';
  for (let i = 0; i < pts.length; i++) {
    const x = xFor(i);
    const y = yFor(pts[i].demand);
    d += (i === 0 ? `M${x},${y}` : ` L${x},${y}`);
  }
  return d;
});

const fcPath = computed(() => {
  const histN = (props.historical || []).length;
  const pts = props.forecastPoints || [];
  if (!pts.length) return '';
  let d = '';
  // соединяем с последней исторической точкой для плавности
  if (histN > 0) {
    const lastH = props.historical[histN - 1];
    d += `M${xFor(histN - 1)},${yFor(lastH.demand)}`;
  }
  for (let i = 0; i < pts.length; i++) {
    const x = xFor(histN + i);
    const y = yFor(pts[i].value);
    d += (i === 0 && !d ? `M${x},${y}` : ` L${x},${y}`);
  }
  return d;
});

const ciArea = computed(() => {
  const histN = (props.historical || []).length;
  const pts = props.forecastPoints || [];
  if (!pts.length) return '';
  const top = [];
  const bot = [];
  for (let i = 0; i < pts.length; i++) {
    const x = xFor(histN + i);
    top.push(`${x},${yFor(pts[i].hi)}`);
    bot.push(`${x},${yFor(pts[i].lo)}`);
  }
  return `M${top.join(' L')} L${bot.reverse().join(' L')} Z`;
});

const emaPath = computed(() => {
  const ema = props.trendEma || [];
  if (!ema.length) return '';
  let d = '';
  for (let i = 0; i < ema.length; i++) {
    const x = xFor(i);
    const y = yFor(ema[i]);
    d += (i === 0 ? `M${x},${y}` : ` L${x},${y}`);
  }
  return d;
});

const anomalyRects = computed(() => {
  const out = [];
  for (const a of (props.anomalies || [])) {
    const i1 = indexOfPeriod(a.from);
    const i2 = indexOfPeriod(a.to);
    if (i1 < 0 || i2 < 0) continue;
    const x1 = xFor(Math.max(0, i1 - 0.5));
    const x2 = xFor(Math.min(allPoints.value.length - 1, i2 + 0.5));
    const w = Math.max(2, x2 - x1);
    const color = a.severity === 'high' ? 'rgba(239, 68, 68, 0.22)'
                : a.severity === 'mid'  ? 'rgba(249, 115, 22, 0.20)'
                : 'rgba(234, 179, 8, 0.18)';
    const stroke = a.severity === 'high' ? 'rgba(239, 68, 68, 0.55)'
                 : a.severity === 'mid'  ? 'rgba(249, 115, 22, 0.50)'
                 : 'rgba(234, 179, 8, 0.45)';
    out.push({
      x: x1, w, fill: color, stroke,
      label: `${a.from} … ${a.to}` + (a.drop_pct ? ` (−${Math.round(a.drop_pct * 100)}%)` : ''),
      labelX: x1 + w / 2,
    });
  }
  return out;
});

// Y-grid
const yTicks = computed(() => {
  const ticks = [];
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const v = (yMax.value * i) / steps;
    ticks.push({
      v: Math.round(v),
      y: yFor(v),
    });
  }
  return ticks;
});

// X-labels (показываем каждую N-ю точку, чтобы не было каши)
const xLabels = computed(() => {
  const n = allPoints.value.length;
  if (n === 0) return [];
  const step = Math.max(1, Math.ceil(n / 12));
  const out = [];
  for (let i = 0; i < n; i += step) {
    out.push({ i, x: xFor(i), label: allPoints.value[i].period });
  }
  // плюс самая последняя
  if (out.length && out[out.length - 1].i !== n - 1) {
    out.push({ i: n - 1, x: xFor(n - 1), label: allPoints.value[n - 1].period });
  }
  return out;
});

// разделитель «история | прогноз»
const fcStartX = computed(() => {
  const histN = (props.historical || []).length;
  if (histN === 0 || !(props.forecastPoints || []).length) return null;
  return xFor(histN - 1);
});

// ── HOVER ──────────────────────────────────────────────────────────
// hoverIndex — индекс ближайшей точки в allPoints; null = курсор вне графика.
const hoverIndex = ref(null);
const svgRef = ref(null);

function onMove(ev) {
  const n = allPoints.value.length;
  if (!n || !svgRef.value) return;
  const rect = svgRef.value.getBoundingClientRect();
  // переводим CSS-координаты в координаты viewBox с учётом масштабирования
  const scaleX = props.width / rect.width;
  const xCss = ev.clientX - rect.left;
  const xVb  = xCss * scaleX;
  if (xVb < PAD.l - 4 || xVb > props.width - PAD.r + 4) { hoverIndex.value = null; return; }
  // ближайший индекс
  const i = Math.round(((xVb - PAD.l) / Math.max(1, innerW.value)) * (n - 1));
  hoverIndex.value = Math.max(0, Math.min(n - 1, i));
}
function onLeave() { hoverIndex.value = null; }

const hoverInfo = computed(() => {
  if (hoverIndex.value == null) return null;
  const i = hoverIndex.value;
  const p = allPoints.value[i];
  if (!p) return null;
  const histN = (props.historical || []).length;
  const isHist = i < histN;
  const tx = xFor(i);
  // позиция тултипа: справа от точки, либо слева, если близко к правому краю
  const tooltipW = 200;
  const flip = tx + 12 + tooltipW > props.width - PAD.r;
  return {
    i,
    x: tx,
    period: p.period,
    isHist,
    value:   p.value,
    lo:      p.lo,
    hi:      p.hi,
    ema:     isHist && (props.trendEma || [])[i] != null ? props.trendEma[i] : null,
    tooltipX: flip ? tx - 12 - tooltipW : tx + 12,
    tooltipY: Math.max(PAD.t + 4, Math.min(props.height - 110, yFor(p.value) - 30)),
    tooltipW,
    point_y: yFor(p.value),
    point_hi_y: typeof p.hi === 'number' ? yFor(p.hi) : null,
    point_lo_y: typeof p.lo === 'number' ? yFor(p.lo) : null,
    point_ema_y: isHist && (props.trendEma || [])[i] != null ? yFor(props.trendEma[i]) : null,
  };
});

function fmtNum(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return Math.round(v).toLocaleString('ru-RU');
}

// Длина пути для draw-on-mount анимации: SVG getTotalLength недоступна без
// шаблонного ref'а на конкретный path; используем фиксированный «большой»
// dasharray и анимируем dashoffset (визуально неотличимо).
</script>

<template>
  <div class="w-full overflow-x-auto">
    <svg ref="svgRef" :viewBox="`0 0 ${width} ${height}`" :width="width" :height="height"
         class="fc-svg bg-gray-900 rounded-lg" preserveAspectRatio="xMidYMid meet" role="img"
         :aria-label="'Прогноз сезонного спроса'"
         @mousemove="onMove" @mouseleave="onLeave">
      <!-- Y-grid -->
      <g>
        <line v-for="t in yTicks" :key="'g'+t.v"
              :x1="PAD.l" :x2="width - PAD.r" :y1="t.y" :y2="t.y"
              stroke="#1f2937" stroke-width="1" />
        <text v-for="t in yTicks" :key="'l'+t.v"
              :x="PAD.l - 6" :y="t.y + 4" text-anchor="end"
              fill="#6b7280" font-size="11">{{ t.v.toLocaleString('ru-RU') }}</text>
      </g>

      <!-- Anomaly rectangles (под линиями) -->
      <g>
        <rect v-for="(r, i) in anomalyRects" :key="'a'+i"
              :x="r.x" :y="PAD.t" :width="r.w" :height="innerH"
              :fill="r.fill" :stroke="r.stroke" stroke-dasharray="3 3"
              class="fc-anomaly" />
        <text v-for="(r, i) in anomalyRects" :key="'al'+i"
              :x="r.labelX" :y="PAD.t + 14" text-anchor="middle"
              fill="#fecaca" font-size="10" font-weight="600"
              class="fc-anomaly-label">⚠ {{ r.label }}</text>
      </g>

      <!-- CI band -->
      <path v-if="ciArea" :d="ciArea" fill="rgba(251, 146, 60, 0.18)" stroke="none"
            class="fc-ci" />

      <!-- Trend EMA (зелёная) -->
      <path v-if="emaPath" :d="emaPath" stroke="#22c55e" stroke-width="1.5"
            fill="none" stroke-dasharray="2 2" opacity="0.7"
            class="fc-line fc-line-ema" />

      <!-- Historical (синяя) -->
      <path v-if="histPath" :d="histPath" stroke="#60a5fa" stroke-width="2" fill="none"
            class="fc-line fc-line-hist" />

      <!-- Forecast (оранжевая, пунктир) -->
      <path v-if="fcPath" :d="fcPath" stroke="#fb923c" stroke-width="2"
            fill="none" stroke-dasharray="6 4"
            class="fc-line fc-line-fc" />

      <!-- разделитель -->
      <line v-if="fcStartX != null" :x1="fcStartX" :x2="fcStartX"
            :y1="PAD.t" :y2="PAD.t + innerH"
            stroke="#374151" stroke-width="1" stroke-dasharray="4 4" />

      <!-- X-labels -->
      <g>
        <text v-for="lab in xLabels" :key="'x'+lab.i"
              :x="lab.x" :y="height - PAD.b + 16"
              text-anchor="middle" fill="#6b7280" font-size="10"
              :transform="`rotate(-35, ${lab.x}, ${height - PAD.b + 16})`">
          {{ lab.label }}
        </text>
      </g>

      <!-- HOVER guideline + точки -->
      <g v-if="hoverInfo" class="fc-hover-layer">
        <line :x1="hoverInfo.x" :x2="hoverInfo.x"
              :y1="PAD.t" :y2="PAD.t + innerH"
              stroke="#cbd5e1" stroke-width="1" stroke-dasharray="3 3" opacity="0.6" />
        <!-- highlight для верхней/нижней границы CI -->
        <g v-if="hoverInfo.point_hi_y != null">
          <circle :cx="hoverInfo.x" :cy="hoverInfo.point_hi_y" r="3"
                  fill="#fb923c" opacity="0.55" />
          <circle :cx="hoverInfo.x" :cy="hoverInfo.point_lo_y" r="3"
                  fill="#fb923c" opacity="0.55" />
        </g>
        <!-- ema -->
        <circle v-if="hoverInfo.point_ema_y != null"
                :cx="hoverInfo.x" :cy="hoverInfo.point_ema_y" r="3"
                fill="#22c55e" opacity="0.85" />
        <!-- основной маркер -->
        <circle :cx="hoverInfo.x" :cy="hoverInfo.point_y" r="5"
                :fill="hoverInfo.isHist ? '#60a5fa' : '#fb923c'"
                stroke="#0f172a" stroke-width="2" class="fc-marker" />
      </g>

      <!-- HOVER tooltip -->
      <g v-if="hoverInfo" :transform="`translate(${hoverInfo.tooltipX}, ${hoverInfo.tooltipY})`"
         class="fc-tooltip" pointer-events="none">
        <rect x="0" y="0" :width="hoverInfo.tooltipW" :height="hoverInfo.isHist ? 64 : 92"
              rx="6" ry="6"
              fill="rgba(15, 23, 42, 0.96)" stroke="#334155" stroke-width="1" />
        <text x="10" y="18" fill="#e2e8f0" font-size="12" font-weight="600">
          {{ hoverInfo.period }}
          <tspan :fill="hoverInfo.isHist ? '#93c5fd' : '#fdba74'" font-size="10" font-weight="400">
            · {{ hoverInfo.isHist ? 'история' : 'прогноз' }}
          </tspan>
        </text>
        <!-- история / прогноз value -->
        <text x="10" y="38" font-size="11" fill="#cbd5e1">
          <tspan :fill="hoverInfo.isHist ? '#60a5fa' : '#fb923c'">●</tspan>
          <tspan dx="6">{{ hoverInfo.isHist ? 'Спрос' : 'Прогноз' }}:</tspan>
          <tspan dx="4" fill="#f1f5f9" font-weight="600">{{ fmtNum(hoverInfo.value) }}</tspan>
        </text>
        <!-- EMA для истории -->
        <text v-if="hoverInfo.isHist && hoverInfo.ema != null"
              x="10" y="56" font-size="11" fill="#cbd5e1">
          <tspan fill="#22c55e">●</tspan>
          <tspan dx="6">Тренд (EMA):</tspan>
          <tspan dx="4" fill="#f1f5f9">{{ fmtNum(hoverInfo.ema) }}</tspan>
        </text>
        <!-- CI для прогноза -->
        <template v-if="!hoverInfo.isHist">
          <text x="10" y="56" font-size="11" fill="#cbd5e1">
            <tspan fill="#fdba74">▲</tspan>
            <tspan dx="6">95% верх:</tspan>
            <tspan dx="4" fill="#f1f5f9">{{ fmtNum(hoverInfo.hi) }}</tspan>
          </text>
          <text x="10" y="74" font-size="11" fill="#cbd5e1">
            <tspan fill="#fdba74">▼</tspan>
            <tspan dx="6">95% низ:</tspan>
            <tspan dx="4" fill="#f1f5f9">{{ fmtNum(hoverInfo.lo) }}</tspan>
          </text>
        </template>
      </g>

      <!-- Легенда -->
      <g :transform="`translate(${PAD.l}, ${height - 12})`">
        <line x1="0" x2="14" y1="0" y2="0" stroke="#60a5fa" stroke-width="2"/>
        <text x="18" y="3" fill="#9ca3af" font-size="10">История</text>
        <line x1="80" x2="94" y1="0" y2="0" stroke="#fb923c" stroke-width="2" stroke-dasharray="4 3"/>
        <text x="98" y="3" fill="#9ca3af" font-size="10">Прогноз 12 мес</text>
        <line x1="195" x2="209" y1="0" y2="0" stroke="#22c55e" stroke-width="1.5" stroke-dasharray="2 2"/>
        <text x="213" y="3" fill="#9ca3af" font-size="10">Тренд (EMA)</text>
        <rect x="285" y="-5" width="14" height="10" fill="rgba(239,68,68,0.22)" stroke="rgba(239,68,68,0.55)" stroke-dasharray="2 2"/>
        <text x="303" y="3" fill="#9ca3af" font-size="10">Аномалии (спад)</text>
        <rect x="410" y="-5" width="14" height="10" fill="rgba(251,146,60,0.18)"/>
        <text x="428" y="3" fill="#9ca3af" font-size="10">95% доверительный интервал</text>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.fc-svg { cursor: crosshair; }

/* Плавная анимация «прорисовки» линий на mount.
   Используем большой dasharray-offset, анимируем offset → 0. */
@keyframes fc-draw {
  from { stroke-dashoffset: 2200; opacity: 0.0; }
  to   { stroke-dashoffset: 0;    opacity: 1.0; }
}
@keyframes fc-fade-in {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}

.fc-line {
  /* для draw-эффекта */
  stroke-dasharray: 2200;
  stroke-dashoffset: 2200;
  animation: fc-draw 900ms cubic-bezier(0.22, 0.61, 0.36, 1) forwards;
}
.fc-line-hist { animation-delay: 50ms; }
.fc-line-fc   { animation-delay: 350ms;
                /* сохраняем визуальный пунктир после анимации */
                stroke-dasharray: 6 4;
                stroke-dashoffset: 0;
                animation: fc-fade-in 700ms ease-out both; }
.fc-line-ema  { animation-delay: 200ms;
                stroke-dasharray: 2 2;
                stroke-dashoffset: 0;
                animation: fc-fade-in 700ms ease-out both; }

.fc-ci             { animation: fc-fade-in 800ms 200ms ease-out both; }
.fc-anomaly        { animation: fc-fade-in 600ms 100ms ease-out both; }
.fc-anomaly-label  { animation: fc-fade-in 600ms 250ms ease-out both; }

.fc-hover-layer line,
.fc-hover-layer circle,
.fc-tooltip rect,
.fc-tooltip text { transition: opacity 120ms ease-out; }

.fc-tooltip { animation: fc-fade-in 140ms ease-out; }
.fc-marker  { transition: r 120ms ease-out; }
.fc-marker:hover { r: 6; }
</style>
