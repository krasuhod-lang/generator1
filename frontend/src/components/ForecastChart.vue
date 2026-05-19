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
 */
import { computed } from 'vue';

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
</script>

<template>
  <div class="w-full overflow-x-auto">
    <svg :viewBox="`0 0 ${width} ${height}`" :width="width" :height="height"
         class="bg-gray-900 rounded-lg" preserveAspectRatio="xMidYMid meet" role="img"
         :aria-label="'Прогноз сезонного спроса'">
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
              :fill="r.fill" :stroke="r.stroke" stroke-dasharray="3 3" />
        <text v-for="(r, i) in anomalyRects" :key="'al'+i"
              :x="r.labelX" :y="PAD.t + 14" text-anchor="middle"
              fill="#fecaca" font-size="10" font-weight="600">⚠ {{ r.label }}</text>
      </g>

      <!-- CI band -->
      <path v-if="ciArea" :d="ciArea" fill="rgba(251, 146, 60, 0.18)" stroke="none" />

      <!-- Trend EMA (зелёная) -->
      <path v-if="emaPath" :d="emaPath" stroke="#22c55e" stroke-width="1.5"
            fill="none" stroke-dasharray="2 2" opacity="0.7" />

      <!-- Historical (синяя) -->
      <path v-if="histPath" :d="histPath" stroke="#60a5fa" stroke-width="2" fill="none" />

      <!-- Forecast (оранжевая, пунктир) -->
      <path v-if="fcPath" :d="fcPath" stroke="#fb923c" stroke-width="2"
            fill="none" stroke-dasharray="6 4" />

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
