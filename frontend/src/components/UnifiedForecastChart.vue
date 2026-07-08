<script setup>
/**
 * UnifiedForecastChart.vue — главный график единой модели прогноза трафика.
 *
 * Показывает «по-человечески»:
 *   • Ретроданные (факт) — сплошная линия слева от «сегодня»,
 *   • Прогноз — сплошная линия справа + закрашенный коридор
 *     (пессимистичный ↔ оптимистичный сценарий),
 *   • Вертикальная отметка «Сегодня» с подписью,
 *   • Крупные подписи «РЕТРОДАННЫЕ» и «ПРОГНОЗ» над зонами графика.
 *
 * Всё оформлено для обывателя-бизнесмена: единица измерения — «визиты в месяц».
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
  const retro = Array.isArray(u.retro) ? u.retro : [];
  const fc = Array.isArray(u.forecast) ? u.forecast : [];

  // Общая ось X: периоды ретро + прогноза.
  const retroPeriods = retro.map((p) => p.period);
  const fcPeriods = fc.map((p) => p.period);
  const periods = [...retroPeriods, ...fcPeriods];
  const nRetro = retroPeriods.length;
  const todayPeriod = u.today_period || retroPeriods[nRetro - 1] || null;

  // Линия «Факт (ретро)» — только на исторической части, потом null.
  const retroLine = periods.map((_, i) => (i < nRetro ? Math.round(retro[i].traffic) : null));
  // Линия «Прогноз» — начинается со стыка (последняя ретро-точка), потом прогноз.
  const fcLine = periods.map((_, i) => {
    if (i === nRetro - 1) return Math.round(retro[nRetro - 1]?.traffic ?? 0); // стык
    if (i >= nRetro) return Math.round(fc[i - nRetro].value);
    return null;
  });
  // Коридор: нижняя граница (база стека) + ширина (upper − lower).
  const lowerLine = periods.map((_, i) => {
    if (i === nRetro - 1) return Math.round(retro[nRetro - 1]?.traffic ?? 0);
    if (i >= nRetro) return Math.round(fc[i - nRetro].lower);
    return null;
  });
  const bandLine = periods.map((_, i) => {
    if (i === nRetro - 1) return 0;
    if (i >= nRetro) return Math.max(0, Math.round(fc[i - nRetro].upper - fc[i - nRetro].lower));
    return null;
  });
  // Рыночный спрос (контекст) — тонкая линия на всём диапазоне.
  const demandLine = periods.map((_, i) => {
    if (i < nRetro) return Math.round(retro[i].demand);
    return Math.round(fc[i - nRetro].demand_potential || 0);
  });

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
        const isRetro = idx < nRetro;
        let html = `<div style="font-weight:600;margin-bottom:4px">${p0.axisValue} · ${isRetro ? 'факт' : 'прогноз'}</div>`;
        const pick = (name) => params.find((p) => p.seriesName === name);
        if (isRetro) {
          const rr = pick('Факт (ретроданные)');
          if (rr && rr.value != null) html += `<div>🔵 Ваш трафик: <b>${fmt(rr.value)}</b> визитов/мес</div>`;
        } else {
          const ff = pick('Прогноз трафика');
          const j = idx - nRetro;
          if (ff && ff.value != null) html += `<div>🟢 Прогноз: <b>${fmt(ff.value)}</b> визитов/мес</div>`;
          if (fc[j]) {
            html += `<div style="color:#94a3b8">↕ Коридор: ${fmt(fc[j].lower)} … ${fmt(fc[j].upper)}</div>`;
            html += `<div style="color:#94a3b8">Доля рынка: ${(fc[j].capture * 100).toFixed(2)}%</div>`;
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
      data: ['Факт (ретроданные)', 'Прогноз трафика', 'Коридор прогноза', 'Рыночный спрос'],
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
      // Факт (ретроданные) — синяя сплошная.
      {
        name: 'Факт (ретроданные)',
        type: 'line',
        data: retroLine,
        smooth: true,
        symbol: 'circle',
        symbolSize: 5,
        lineStyle: { width: 3, color: '#60a5fa' },
        itemStyle: { color: '#60a5fa' },
        z: 3,
      },
      // Прогноз — зелёная, пунктир, с отметкой «Сегодня».
      {
        name: 'Прогноз трафика',
        type: 'line',
        data: fcLine,
        smooth: true,
        symbol: 'circle',
        symbolSize: 5,
        lineStyle: { width: 3, color: '#22c55e', type: 'dashed' },
        itemStyle: { color: '#22c55e' },
        z: 3,
        markLine: todayPeriod ? {
          symbol: 'none',
          label: { formatter: 'Сегодня', color: '#e2e8f0', position: 'insideEndTop' },
          lineStyle: { color: '#64748b', type: 'solid', width: 1 },
          data: [{ xAxis: todayPeriod }],
        } : undefined,
      },
    ],
    graphic: buildZoneLabels(nRetro, periods.length),
  };
});

// Крупные подписи зон «РЕТРОДАННЫЕ» / «ПРОГНОЗ» над графиком.
function buildZoneLabels(nRetro, total) {
  if (!total) return [];
  const leftFrac = nRetro / total;
  return [
    {
      type: 'text', left: `${Math.max(4, leftFrac * 46)}%`, top: 30,
      style: { text: '◀ РЕТРОДАННЫЕ (факт)', fill: '#60a5fa', font: '600 11px sans-serif' },
    },
    {
      type: 'text', left: `${Math.min(92, (leftFrac + (1 - leftFrac) / 2) * 100)}%`, top: 30,
      style: { text: 'ПРОГНОЗ ▶', fill: '#22c55e', font: '600 11px sans-serif' },
    },
  ];
}

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
