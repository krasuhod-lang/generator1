<script setup>
/**
 * UnifiedForecastChart.vue — главный график единой модели прогноза трафика.
 *
 * Показывает ТОЛЬКО прогноз (ретроданные намеренно скрыты по требованию
 * продукта: «в график 🚀 Прогноз трафика ретроданные не нужны»). Оси —
 * будущие месяцы от «месяца старта работ» (u.start_period).
 *
 *   • Прогноз — сплошная зелёная линия,
 *   • Коридор — закрашенная зона (пессимистичный ↔ оптимистичный сценарий),
 *   • Вертикальная отметка «Старт работ» на первом месяце прогноза,
 *   • Рыночный спрос — тонкая фиолетовая линия-контекст.
 *
 * Единица измерения — «визиты в месяц». В тултипе — два множителя «спрос ×
 * позиции»: capture_growth и demand_yoy (для маркетолога).
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  GridComponent, LegendComponent, TooltipComponent,
  MarkLineComponent, MarkAreaComponent, GraphicComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  LineChart, GridComponent, LegendComponent, TooltipComponent,
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

  // По требованию продукта график «🚀 Прогноз трафика» показывает ТОЛЬКО
  // прогноз (без ретроданных). Ось X — исключительно будущие месяцы,
  // начиная с месяца старта работ (u.start_period) или следующего календарного
  // месяца после последней истории (совместимо с прежним поведением).
  const periods = fc.map((p) => p.period);
  const startPeriod = u.start_period || periods[0] || null;

  const fcLine   = fc.map((p) => Math.round(p.value));
  const lowerLine = fc.map((p) => Math.round(p.lower));
  const bandLine  = fc.map((p) => Math.max(0, Math.round(p.upper - p.lower)));
  const demandLine = fc.map((p) => Math.round(p.demand_potential || 0));

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
        let html = `<div style="font-weight:600;margin-bottom:4px">${p0.axisValue} · прогноз</div>`;
        const pick = (name) => params.find((p) => p.seriesName === name);
        const ff = pick('Прогноз трафика');
        if (ff && ff.value != null) html += `<div>🟢 Прогноз: <b>${fmt(ff.value)}</b> визитов/мес</div>`;
        if (fc[idx]) {
          html += `<div style="color:#94a3b8">↕ Коридор: ${fmt(fc[idx].lower)} … ${fmt(fc[idx].upper)}</div>`;
          html += `<div style="color:#94a3b8">Доля рынка: ${(fc[idx].capture * 100).toFixed(2)}%</div>`;
          // Два множителя (спрос × позиции) — прозрачность для маркетолога.
          if (fc[idx].capture_growth != null) {
            html += `<div style="color:#94a3b8">Позиции ×${fc[idx].capture_growth.toFixed(2)} к старту</div>`;
          }
          if (fc[idx].demand_yoy != null) {
            const dy = fc[idx].demand_yoy;
            const arrow = dy >= 1 ? '📈' : '📉';
            html += `<div style="color:#94a3b8">${arrow} Спрос YoY ×${dy.toFixed(2)}</div>`;
          }
        }
        const dd = pick('Рыночный спрос');
        if (dd && dd.value != null) html += `<div style="color:#a78bfa">🟣 Спрос (поисков): ${fmt(dd.value)}/мес</div>`;
        return html;
      },
    },
    legend: {
      top: 0,
      textStyle: { color: '#9ca3af' },
      data: ['Прогноз трафика', 'Коридор прогноза', 'Рыночный спрос'],
    },
    grid: { left: 58, right: 24, top: 58, bottom: 52 },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: periods,
      axisLabel: { color: '#9ca3af', rotate: 35 },
      axisLine: { lineStyle: { color: '#374151' } },
    },
    yAxis: {
      type: 'value',
      name: 'Визиты / мес',
      nameTextStyle: { color: '#9ca3af' },
      axisLabel: { color: '#9ca3af', formatter: (v) => (v >= 1000 ? (v / 1000) + 'k' : v) },
      splitLine: { lineStyle: { color: '#1f2937' } },
    },
    series: [
      // Рыночный спрос (контекст, тонкая фиолетовая).
      {
        name: 'Рыночный спрос',
        type: 'line',
        data: demandLine,
        smooth: true,
        symbol: 'none',
        lineStyle: { width: 1, color: '#a78bfa', type: 'dotted', opacity: 0.7 },
        z: 1,
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
      // Прогноз — зелёная сплошная линия с отметкой «Старт работ».
      {
        name: 'Прогноз трафика',
        type: 'line',
        data: fcLine,
        smooth: true,
        symbol: 'circle',
        symbolSize: 5,
        lineStyle: { width: 3, color: '#22c55e' },
        itemStyle: { color: '#22c55e' },
        z: 3,
        markLine: startPeriod ? {
          symbol: 'none',
          label: { formatter: 'Старт работ', color: '#e2e8f0', position: 'insideEndTop' },
          lineStyle: { color: '#64748b', type: 'solid', width: 1 },
          data: [{ xAxis: startPeriod }],
        } : undefined,
      },
    ],
    graphic: [{
      type: 'text', left: '50%', top: 30,
      style: { text: 'ПРОГНОЗ (с месяца старта работ)', fill: '#22c55e', font: '600 11px sans-serif', textAlign: 'center' },
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
       role="img" aria-label="Единый прогноз трафика: ретроданные и прогноз"></div>
</template>
