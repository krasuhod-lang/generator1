<script setup>
/**
 * UnifiedForecastChart.vue — единый график прогноза «трафик + показы + лиды».
 *
 * Объединяет прежние два графика (🚀 Прогноз трафика и 📈 SOV) в один.
 * Показывает динамику от СТАРТОВОГО значения трафика (u.start — точка t=0,
 * ровно введённый пользователем текущий трафик) по будущим месяцам:
 *
 *   • Трафик (визиты) — основная зелёная линия,
 *   • Показы — фиолетовая линия (объём видимости в выдаче),
 *   • Лиды — столбцы по правой оси,
 *   • Коридор — закрашенная зона (пессимистичный ↔ оптимистичный сценарий),
 *   • Вертикальная отметка «Старт работ» на первом месяце прогноза,
 *   • Доля рынка (SOV/capture) — в тултипе.
 *
 * Единица измерения — «в месяц». Учитывает конверсии между этапами
 * (показы → визиты → лиды) по среднестатистическим коэффициентам.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts/core';
import { LineChart, BarChart } from 'echarts/charts';
import {
  GridComponent, LegendComponent, TooltipComponent,
  MarkLineComponent, MarkAreaComponent, GraphicComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  LineChart, BarChart, GridComponent, LegendComponent, TooltipComponent,
  MarkLineComponent, MarkAreaComponent, GraphicComponent, CanvasRenderer,
]);

const props = defineProps({
  unified: { type: Object, required: true },
  height:  { type: Number, default: 380 },
});

const chartEl = ref(null);
let chart = null;
let ro = null;

const model = computed(() => props.unified || {});

const option = computed(() => {
  const u = model.value;
  const fc = Array.isArray(u.forecast) ? u.forecast : [];
  const start = u.start || u.summary?.start || null;

  // Ось X начинается со СТАРТОВОЙ точки (t=0) — ровно текущий трафик, от него
  // строится вся динамика. Далее — будущие месяцы прогноза.
  const fcPeriods = fc.map((p) => p.period);
  const startPeriod = (start && start.period) || u.start_period || fcPeriods[0] || null;
  const periods = start && start.period ? [start.period, ...fcPeriods] : fcPeriods;
  // Отметка «Старт работ» ставится на первый месяц прогноза (после старта).
  const startMarkPeriod = u.start_period || fcPeriods[0] || null;

  const prepend = (headVal, arr) => (start && start.period ? [headVal, ...arr] : arr);

  const trafficLine    = prepend(start ? Math.round(start.traffic) : null, fc.map((p) => Math.round(p.value)));
  const impressionsLine = prepend(start ? Math.round(start.impressions || 0) : null, fc.map((p) => Math.round(p.impressions || 0)));
  const leadsBars      = prepend(start && start.leads != null ? start.leads : null, fc.map((p) => (p.leads != null ? p.leads : null)));
  const lowerLine      = prepend(start ? Math.round(start.traffic) : null, fc.map((p) => Math.round(p.lower)));
  const bandLine       = prepend(0, fc.map((p) => Math.max(0, Math.round(p.upper - p.lower))));

  const hasLeads = leadsBars.some((v) => v != null && v > 0);

  const fmt = (v) => Number(v || 0).toLocaleString('ru-RU');

  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross', label: { backgroundColor: '#334155' } },
      backgroundColor: 'rgba(15,23,42,0.96)',
      borderColor: '#334155',
      textStyle: { color: '#e2e8f0' },
      formatter(params) {
        if (!params || !params.length) return '';
        const p0 = params[0];
        const idx = p0.dataIndex;
        const isStart = start && start.period && idx === 0;
        const point = isStart ? start : fc[start && start.period ? idx - 1 : idx];
        const title = isStart ? `${p0.axisValue} · старт` : `${p0.axisValue} · прогноз`;
        let html = `<div style="font-weight:600;margin-bottom:4px">${title}</div>`;
        const pick = (name) => params.find((p) => p.seriesName === name);
        const ff = pick('Трафик (визиты)');
        if (ff && ff.value != null) html += `<div>🟢 Визиты: <b>${fmt(ff.value)}</b>/мес</div>`;
        const imp = pick('Показы');
        if (imp && imp.value != null) html += `<div>🟣 Показы: <b>${fmt(imp.value)}</b>/мес</div>`;
        const ld = pick('Лиды');
        if (ld && ld.value != null) html += `<div>🟦 Лиды: <b>${fmt(ld.value)}</b>/мес</div>`;
        if (point) {
          if (!isStart && point.lower != null && point.upper != null) {
            html += `<div style="color:#94a3b8">↕ Коридор: ${fmt(point.lower)} … ${fmt(point.upper)}</div>`;
          }
          if (point.capture != null) {
            html += `<div style="color:#94a3b8">Доля рынка (SOV): ${(point.capture * 100).toFixed(2)}%</div>`;
          }
          if (point.demand != null) {
            html += `<div style="color:#a78bfa">Спрос (поисков): ${fmt(point.demand)}/мес</div>`;
          }
          if (point.capture_growth != null) {
            html += `<div style="color:#94a3b8">Позиции ×${point.capture_growth.toFixed(2)} к старту</div>`;
          }
          if (point.demand_yoy != null) {
            const dy = point.demand_yoy;
            html += `<div style="color:#94a3b8">${dy >= 1 ? '📈' : '📉'} Спрос YoY ×${dy.toFixed(2)}</div>`;
          }
        }
        return html;
      },
    },
    legend: {
      top: 0,
      textStyle: { color: '#9ca3af' },
      data: ['Показы', 'Трафик (визиты)', 'Коридор прогноза', ...(hasLeads ? ['Лиды'] : [])],
    },
    grid: { left: 58, right: hasLeads ? 58 : 24, top: 58, bottom: 52 },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: periods,
      axisLabel: { color: '#9ca3af', rotate: 35 },
      axisLine: { lineStyle: { color: '#374151' } },
    },
    yAxis: [
      {
        type: 'value',
        name: 'В месяц',
        nameTextStyle: { color: '#9ca3af' },
        axisLabel: { color: '#9ca3af', formatter: (v) => (v >= 1000 ? (v / 1000) + 'k' : v) },
        splitLine: { lineStyle: { color: '#1f2937' } },
      },
      {
        type: 'value',
        name: 'Лиды',
        nameTextStyle: { color: '#9ca3af' },
        axisLabel: { color: '#9ca3af' },
        splitLine: { show: false },
      },
    ],
    series: [
      // Показы (объём видимости в выдаче).
      {
        name: 'Показы',
        type: 'line',
        data: impressionsLine,
        smooth: true,
        symbol: 'none',
        lineStyle: { width: 1.5, color: '#a78bfa', type: 'dashed', opacity: 0.85 },
        areaStyle: { color: 'rgba(167,139,250,0.06)' },
        z: 2,
      },
      // Нижняя граница коридора (невидимая база стека).
      {
        name: 'Нижняя граница',
        type: 'line',
        data: lowerLine,
        stack: 'band',
        symbol: 'none',
        lineStyle: { opacity: 0 },
        areaStyle: { opacity: 0 },
        emphasis: { disabled: true },
        tooltip: { show: false },
        z: 1,
      },
      // Ширина коридора (закрашенная зона).
      {
        name: 'Коридор прогноза',
        type: 'line',
        data: bandLine,
        stack: 'band',
        symbol: 'none',
        lineStyle: { opacity: 0 },
        areaStyle: { color: 'rgba(34,197,94,0.16)' },
        emphasis: { disabled: true },
        z: 1,
      },
      // Трафик (визиты) — зелёная сплошная линия с отметкой «Старт работ».
      {
        name: 'Трафик (визиты)',
        type: 'line',
        data: trafficLine,
        smooth: true,
        symbol: 'circle',
        symbolSize: 5,
        lineStyle: { width: 3, color: '#22c55e' },
        itemStyle: { color: '#22c55e' },
        z: 4,
        markLine: startMarkPeriod ? {
          symbol: 'none',
          label: { formatter: 'Старт работ', color: '#e2e8f0', position: 'insideEndTop' },
          lineStyle: { color: '#64748b', type: 'solid', width: 1 },
          data: [{ xAxis: startMarkPeriod }],
        } : undefined,
      },
      // Лиды — столбцы по правой оси.
      ...(hasLeads ? [{
        name: 'Лиды',
        type: 'bar',
        yAxisIndex: 1,
        data: leadsBars,
        itemStyle: { color: 'rgba(56,189,248,0.45)', borderColor: 'rgba(56,189,248,0.75)' },
        z: 3,
      }] : []),
    ],
    graphic: [{
      type: 'text', left: '50%', top: 30,
      style: { text: 'ТРАФИК · ПОКАЗЫ · ЛИДЫ (с месяца старта работ)', fill: '#22c55e', font: '600 11px sans-serif', textAlign: 'center' },
    }],
  };
});

function render() {
  if (!chartEl.value) return;
  if (!chart) chart = echarts.init(chartEl.value);
  chart.setOption(option.value, true);
}

onMounted(() => {
  render();
  ro = new ResizeObserver(() => chart?.resize());
  ro.observe(chartEl.value);
});
watch(option, render, { deep: true });
onBeforeUnmount(() => {
  ro?.disconnect();
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <div ref="chartEl" class="w-full" :style="{ height: `${height}px` }"
       role="img" aria-label="Единый прогноз: трафик, показы и лиды"></div>
</template>

