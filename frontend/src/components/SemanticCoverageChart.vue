<script setup>
/**
 * SemanticCoverageChart.vue — граф охвата семантики (замена статичных
 * карточек ТОП-3/5/10). Комбинированный график ECharts:
 *
 *   • Stacked bars (левая ось): распределение ключей по ТОП-3 / ТОП-10 /
 *     ТОП-20 / вне топа по месяцам прогноза (кол-во или % — toggle),
 *   • Line (правая ось): прогнозный трафик — реалистичный (сплошная)
 *     и оптимистичный (пунктирная), toggle.
 *
 * Данные: forecaster_tasks.semantic_distribution
 * (buildSemanticDistribution в backend/src/services/forecaster/trafficModel.js).
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts/core';
import { LineChart, BarChart } from 'echarts/charts';
import {
  GridComponent, LegendComponent, TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  LineChart, BarChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer,
]);

const props = defineProps({
  distribution: { type: Array, required: true }, // semantic_distribution
  height:       { type: Number, default: 400 },
});

// Контролы: кол-во запросов / % охвата; реалистичный / оптимистичный.
const mode = ref('count');           // 'count' | 'percent'
const scenario = ref('realistic');   // 'realistic' | 'optimistic'

const chartEl = ref(null);
let chart = null;
let ro = null;

const COLORS = {
  top3:  '#22C55E',
  top10: '#3B82F6',
  top20: '#F59E0B',
  out:   '#E5E7EB',
  traffic: '#6366F1',
};

const rows = computed(() => (Array.isArray(props.distribution) ? props.distribution : []));

const totalKeywords = computed(() => {
  const d = rows.value[0]?.distribution;
  if (!d) return 0;
  return (d.top3?.count || 0) + (d.top10?.count || 0) + (d.top20?.count || 0) + (d.out?.count || 0);
});

const hasOptimistic = computed(() => rows.value.some((r) => r.traffic_optimistic != null));

const option = computed(() => {
  const data = rows.value;
  const total = totalKeywords.value || 1;
  const isPct = mode.value === 'percent';
  const fmt = (v) => Number(v || 0).toLocaleString('ru-RU');
  const bucketVal = (r, key) => {
    const c = r.distribution?.[key]?.count || 0;
    return isPct ? Math.round((c / total) * 1000) / 10 : c;
  };

  const xLabels = data.map((r) => r.month);
  const trafficRealistic = data.map((r) => r.traffic_realistic);
  const trafficOptimistic = data.map((r) => r.traffic_optimistic);
  const showOpt = scenario.value === 'optimistic' && hasOptimistic.value;

  const barSeries = [
    { key: 'top3',  name: 'ТОП-3',    color: COLORS.top3 },
    { key: 'top10', name: 'ТОП-10',   color: COLORS.top10 },
    { key: 'top20', name: 'ТОП-20',   color: COLORS.top20 },
    { key: 'out',   name: 'Вне топа', color: COLORS.out },
  ].map((s) => ({
    name: s.name,
    type: 'bar',
    stack: 'coverage',
    data: data.map((r) => bucketVal(r, s.key)),
    itemStyle: { color: s.color, opacity: s.key === 'out' ? 0.25 : 0.9 },
    emphasis: { focus: 'series' },
  }));

  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      backgroundColor: 'rgba(15,23,42,0.96)',
      borderColor: '#334155',
      textStyle: { color: '#e2e8f0' },
      formatter(params) {
        if (!params || !params.length) return '';
        const idx = params[0].dataIndex;
        const r = data[idx];
        if (!r) return '';
        const d = r.distribution || {};
        const pctOf = (c) => total > 0 ? Math.round((c / total) * 100) : 0;
        let html = `<div style="font-weight:600;margin-bottom:4px">${r.label || r.month}</div>`;
        html += `<div>🟢 ТОП-3: <b>${fmt(d.top3?.count)}</b> запросов (${pctOf(d.top3?.count || 0)}% семантики)</div>`;
        html += `<div>🔵 ТОП-10: <b>${fmt(d.top10?.count)}</b> запросов (${pctOf(d.top10?.count || 0)}% семантики)</div>`;
        html += `<div>🟠 ТОП-20: <b>${fmt(d.top20?.count)}</b> запросов (${pctOf(d.top20?.count || 0)}% семантики)</div>`;
        html += `<div style="color:#94a3b8">⚪ Вне топа: ${fmt(d.out?.count)} запросов</div>`;
        if (r.traffic_realistic != null) {
          html += `<div style="margin-top:4px">📈 Прогноз трафика: <b>${fmt(showOpt ? r.traffic_optimistic : r.traffic_realistic)}</b> визитов/мес` +
                  `${showOpt ? ' (оптимистичный)' : ''}</div>`;
        }
        return html;
      },
    },
    legend: {
      top: 0,
      textStyle: { color: '#9ca3af' },
      data: ['ТОП-3', 'ТОП-10', 'ТОП-20', 'Вне топа',
             showOpt ? 'Трафик (оптимистичный)' : 'Трафик (реалистичный)'],
    },
    grid: { left: 58, right: 64, top: 42, bottom: 36 },
    xAxis: {
      type: 'category',
      data: xLabels,
      axisLabel: { color: '#9ca3af' },
      axisLine: { lineStyle: { color: '#374151' } },
    },
    yAxis: [
      {
        type: 'value',
        name: isPct ? '% семантики' : 'Ключей',
        nameTextStyle: { color: '#9ca3af' },
        max: isPct ? 100 : null,
        axisLabel: {
          color: '#9ca3af',
          formatter: (v) => isPct ? v + '%' : (v >= 1000 ? (v / 1000) + 'k' : v),
        },
        splitLine: { lineStyle: { color: '#1f2937' } },
      },
      {
        type: 'value',
        name: 'Визиты/мес',
        nameTextStyle: { color: '#9ca3af' },
        axisLabel: { color: '#9ca3af', formatter: (v) => (v >= 1000 ? (v / 1000) + 'k' : v) },
        splitLine: { show: false },
      },
    ],
    series: [
      ...barSeries,
      {
        name: showOpt ? 'Трафик (оптимистичный)' : 'Трафик (реалистичный)',
        type: 'line',
        yAxisIndex: 1,
        data: showOpt ? trafficOptimistic : trafficRealistic,
        smooth: true,
        symbol: 'circle',
        symbolSize: 5,
        lineStyle: { width: 2.5, color: COLORS.traffic, type: showOpt ? 'dashed' : 'solid' },
        itemStyle: { color: COLORS.traffic },
        z: 5,
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
  <div>
    <!-- Контролы над графиком -->
    <div class="flex items-center gap-3 flex-wrap mb-2">
      <div class="inline-flex rounded border border-gray-700 overflow-hidden text-xs">
        <button @click="mode = 'count'"
                :class="mode === 'count' ? 'bg-indigo-600 text-white' : 'bg-gray-950 text-gray-400 hover:text-gray-200'"
                class="px-2.5 py-1 font-semibold transition">Кол-во запросов</button>
        <button @click="mode = 'percent'"
                :class="mode === 'percent' ? 'bg-indigo-600 text-white' : 'bg-gray-950 text-gray-400 hover:text-gray-200'"
                class="px-2.5 py-1 font-semibold transition">% охвата</button>
      </div>
      <div v-if="hasOptimistic" class="inline-flex rounded border border-gray-700 overflow-hidden text-xs">
        <button @click="scenario = 'realistic'"
                :class="scenario === 'realistic' ? 'bg-emerald-600 text-white' : 'bg-gray-950 text-gray-400 hover:text-gray-200'"
                class="px-2.5 py-1 font-semibold transition">Реалистичный</button>
        <button @click="scenario = 'optimistic'"
                :class="scenario === 'optimistic' ? 'bg-emerald-600 text-white' : 'bg-gray-950 text-gray-400 hover:text-gray-200'"
                class="px-2.5 py-1 font-semibold transition">Оптимистичный</button>
      </div>
      <span class="text-[11px] text-gray-500 ml-auto">
        {{ totalKeywords.toLocaleString('ru-RU') }} запросов в семантике
      </span>
    </div>
    <div ref="chartEl" class="w-full" :style="{ height: `${height}px` }"
         role="img" aria-label="Граф охвата семантики: распределение ключей по топам и прогнозный трафик"></div>
  </div>
</template>
