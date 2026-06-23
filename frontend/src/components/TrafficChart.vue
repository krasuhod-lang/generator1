<script setup>
/**
 * TrafficChart.vue (PR-4) — главный график Executive Summary на Apache
 * ECharts. Принимает помесячный ряд («только полные месяцы», см. PR-1
 * periodResolver.splitSeriesIntoMonths + resolveCompletedMonths) и
 * показывает две оси:
 *   • clicks (столбцы)  — основной KPI;
 *   • impressions (линия) — показы как фон, во вторичной оси справа.
 *
 * Можно передать любую серию через prop `series`. Дефолт — clicks +
 * impressions, как это требует PR-4 (главный график трафика).
 *
 * Зависимости: используем module ESM-импорт echarts/core + минимально
 * нужные компоненты, чтобы не тянуть весь пакет в bundle. vue-echarts
 * предоставляет declarative-компонент <VChart>.
 */
import { computed, provide } from 'vue';
import { use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { BarChart, LineChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
} from 'echarts/components';
import VChart, { THEME_KEY } from 'vue-echarts';

use([CanvasRenderer, BarChart, LineChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent]);

// Тёмная тема под surface-токены PR-3.
provide(THEME_KEY, 'dark');

const props = defineProps({
  /**
   * Массив `monthly_periods` из snapshot, формат PR-1:
   *   { key:'YYYY-MM', from:'YYYY-MM-DD', to:'YYYY-MM-DD', complete:Boolean,
   *     totals:{ clicks, impressions, ctr, position } }
   * Только записи с complete === true участвуют в графике (правило ТЗ).
   */
  monthly:  { type: Array, default: () => [] },
  /**
   * Альтернативно — готовый series payload в форме ECharts. Если задан,
   * `monthly` игнорируется.
   */
  series:   { type: Array, default: null },
  xAxisData:{ type: Array, default: null },
  height:   { type: String, default: '320px' },
});

const completeMonths = computed(() =>
  (Array.isArray(props.monthly) ? props.monthly : []).filter((m) => m && m.complete)
);

const xAxisData = computed(() => {
  if (Array.isArray(props.xAxisData)) return props.xAxisData;
  return completeMonths.value.map((m) => m.key || '');
});

const clicksSeries = computed(() => completeMonths.value.map((m) => Number(m?.totals?.clicks || 0)));
const impressionsSeries = computed(() => completeMonths.value.map((m) => Number(m?.totals?.impressions || 0)));

const options = computed(() => {
  const series = Array.isArray(props.series) ? props.series : [
    {
      name: 'Клики',
      type: 'bar',
      data: clicksSeries.value,
      itemStyle: { color: '#6366f1', borderRadius: [6, 6, 0, 0] },
      emphasis:  { itemStyle: { color: '#818cf8' } },
      yAxisIndex: 0,
    },
    {
      name: 'Показы',
      type: 'line',
      data: impressionsSeries.value,
      smooth: true,
      symbol: 'circle',
      symbolSize: 6,
      lineStyle: { color: '#10B981', width: 2 },
      itemStyle: { color: '#10B981' },
      yAxisIndex: 1,
    },
  ];

  return {
    backgroundColor: 'transparent',
    grid: { left: 48, right: 56, top: 32, bottom: 36, containLabel: true },
    legend: {
      textStyle: { color: '#9CA3AF' },
      top: 0,
      icon: 'roundRect',
      itemWidth: 10,
      itemHeight: 10,
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#1e293b',
      borderColor: '#334155',
      textStyle: { color: '#E5E7EB' },
      axisPointer: { type: 'shadow' },
    },
    xAxis: {
      type: 'category',
      data: xAxisData.value,
      axisLabel: { color: '#9CA3AF' },
      axisLine:  { lineStyle: { color: '#334155' } },
      axisTick:  { show: false },
    },
    yAxis: [
      {
        type: 'value',
        name: 'Клики',
        nameTextStyle: { color: '#9CA3AF' },
        axisLabel: { color: '#9CA3AF' },
        splitLine: { lineStyle: { color: '#1f2937' } },
      },
      {
        type: 'value',
        name: 'Показы',
        nameTextStyle: { color: '#9CA3AF' },
        axisLabel: { color: '#9CA3AF' },
        splitLine: { show: false },
      },
    ],
    series,
  };
});

const isEmpty = computed(() => xAxisData.value.length === 0);
</script>

<template>
  <div class="rounded-xl border border-surface-muted bg-surface-raised p-4 shadow-lg shadow-black/20">
    <div v-if="isEmpty" class="flex flex-col items-center justify-center text-gray-500 text-sm py-12">
      <span class="text-2xl mb-2" aria-hidden="true">📉</span>
      <span>Нет данных по полным месяцам</span>
      <span class="text-xs text-gray-600 mt-1">График строится только по завершённым календарным месяцам (PR-1)</span>
    </div>
    <VChart
      v-else
      :option="options"
      :style="{ height }"
      autoresize
      :init-options="{ renderer: 'canvas' }"
    />
  </div>
</template>
