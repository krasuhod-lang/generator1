<script setup>
/**
 * SovForecastChart.vue — комбинированный echarts-график SOV-прогноза.
 * Показывает коридор трафика (пессимистичный→оптимистичный), реалистичную
 * линию и лиды по правой оси.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts/core';
import { LineChart, BarChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([LineChart, BarChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

const props = defineProps({
  sovForecast: { type: Object, required: true },
  height:      { type: Number, default: 360 },
});

const chartEl = ref(null);
let chart = null;
let ro = null;

const option = computed(() => {
  const sov = props.sovForecast || {};
  const periods = sov.periods || [];
  const pess = sov.scenarios?.pessimistic?.traffic || [];
  const realTraffic = sov.scenarios?.realistic?.traffic || [];
  const opt = sov.scenarios?.optimistic?.traffic || [];
  const realLeads = sov.scenarios?.realistic?.leads || [];
  const corridor = opt.map((v, i) => Math.max(0, Number(v || 0) - Number(pess[i] || 0)));

  return {
    backgroundColor: 'transparent',
    color: ['#38bdf8', 'rgba(14,165,233,0.20)', '#22c55e'],
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross' },
      valueFormatter: (value) => Number(value || 0).toLocaleString('ru-RU'),
    },
    legend: {
      top: 0,
      textStyle: { color: '#9ca3af' },
      data: ['Коридор трафика', 'Трафик (реалистично)', 'Лиды (реалистично)'],
    },
    grid: { left: 54, right: 58, top: 42, bottom: 48 },
    xAxis: {
      type: 'category',
      data: periods,
      axisLabel: { color: '#9ca3af', rotate: 35 },
      axisLine: { lineStyle: { color: '#374151' } },
    },
    yAxis: [
      {
        type: 'value',
        name: 'Трафик',
        nameTextStyle: { color: '#9ca3af' },
        axisLabel: { color: '#9ca3af' },
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
      {
        name: 'Нижняя граница',
        type: 'line',
        data: pess,
        stack: 'corridor',
        lineStyle: { opacity: 0 },
        symbol: 'none',
        areaStyle: { opacity: 0 },
        emphasis: { disabled: true },
        tooltip: { show: false },
      },
      {
        name: 'Коридор трафика',
        type: 'line',
        data: corridor,
        stack: 'corridor',
        symbol: 'none',
        lineStyle: { opacity: 0 },
        areaStyle: { color: 'rgba(56, 189, 248, 0.18)' },
      },
      {
        name: 'Трафик (реалистично)',
        type: 'line',
        data: realTraffic,
        smooth: true,
        symbolSize: 6,
        lineStyle: { width: 3, color: '#38bdf8' },
      },
      {
        name: 'Лиды (реалистично)',
        type: 'bar',
        yAxisIndex: 1,
        data: realLeads,
        itemStyle: { color: 'rgba(34, 197, 94, 0.45)', borderColor: 'rgba(34,197,94,0.75)' },
      },
    ],
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
  <div ref="chartEl" class="w-full" :style="{ height: `${height}px` }" role="img" aria-label="Прогноз доли рынка SOV"></div>
</template>
