<script setup>
/**
 * RelevanceHeatmap.vue — тепловая карта переспама/недоспама (ТЗ 23.07.2026 п.3.2).
 * Наглядно показывает копирайтеру директивы «наш сайт vs ТОП»:
 *   • красная зона — переспам (over / over_top3),
 *   • синяя зона   — недоспам (under / missing),
 *   • зелёная зона — норма (ok).
 * При клике на ячейку показывается точная рекомендация (directive.text).
 *
 * Значение ячейки = delta (насколько отклонились от медианы ТОПа):
 *   delta > 0 — нужно добавить (недоспам), delta < 0 — сократить (переспам).
 * Источник данных: comparison.directives (+ per_term для статуса ok).
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts/core';
import { HeatmapChart } from 'echarts/charts';
import {
  GridComponent, TooltipComponent, VisualMapComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([HeatmapChart, GridComponent, TooltipComponent, VisualMapComponent, CanvasRenderer]);

const props = defineProps({
  directives: { type: Array, default: () => [] },
  perColumn:  { type: Number, default: 12 }, // лемм в строке (сетка)
  height:     { type: Number, default: 320 },
});

const emit = defineEmits(['cell-click']);

const chartEl = ref(null);
let chart = null;
let ro = null;

const selected = ref(null); // выбранная директива (для карточки под графиком)

// Готовим ячейки сетки: каждая лемма → {x, y, delta, directive}.
const cells = computed(() => {
  const dirs = Array.isArray(props.directives) ? props.directives.filter((d) => d && d.lemma) : [];
  const cols = Math.max(1, props.perColumn);
  return dirs.map((d, i) => ({
    x: i % cols,
    y: Math.floor(i / cols),
    delta: Number(d.delta) || 0,
    directive: d,
  }));
});

const gridRows = computed(() => {
  if (!cells.value.length) return 1;
  return Math.max(...cells.value.map((c) => c.y)) + 1;
});

const option = computed(() => {
  const data = cells.value;
  if (!data.length) return null;
  const cols = Math.max(1, props.perColumn);
  const maxAbs = Math.max(...data.map((c) => Math.abs(c.delta)), 1);

  return {
    backgroundColor: 'transparent',
    tooltip: {
      position: 'top',
      backgroundColor: 'rgba(15,23,42,0.96)',
      borderColor: '#334155',
      textStyle: { color: '#e2e8f0' },
      formatter(p) {
        const d = p.data?.directive;
        if (!d) return '';
        const zone = d.delta > 0 ? '🔵 Недоспам' : (d.delta < 0 ? '🔴 Переспам' : '🟢 Норма');
        return `<div style="font-weight:600;margin-bottom:2px">«${d.lemma}» — ${zone}</div>`
             + `<div style="max-width:280px;white-space:normal">${d.text || ''}</div>`;
      },
    },
    grid: { left: 8, right: 8, top: 8, bottom: 28, containLabel: false },
    xAxis: {
      type: 'category',
      data: Array.from({ length: cols }, (_, i) => i),
      show: false,
      splitArea: { show: true },
    },
    yAxis: {
      type: 'category',
      data: Array.from({ length: gridRows.value }, (_, i) => i),
      show: false,
      inverse: true,
      splitArea: { show: true },
    },
    visualMap: {
      min: -maxAbs,
      max: maxAbs,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      dimension: 2,
      textStyle: { color: '#9ca3af', fontSize: 10 },
      text: ['Недоспам (+)', 'Переспам (−)'],
      inRange: {
        // синий (недоспам, delta>0) ← зелёный (норма ~0) → красный (переспам, delta<0)
        color: ['#DC2626', '#F59E0B', '#22C55E', '#3B82F6', '#2563EB'],
      },
    },
    series: [{
      type: 'heatmap',
      data: data.map((c) => ({
        value: [c.x, c.y, c.delta],
        directive: c.directive,
      })),
      label: {
        show: true,
        color: '#0b1020',
        fontSize: 10,
        fontWeight: 600,
        formatter: (p) => p.data?.directive?.lemma || '',
      },
      itemStyle: { borderColor: '#0b1020', borderWidth: 1, borderRadius: 3 },
      emphasis: { itemStyle: { shadowBlur: 8, shadowColor: 'rgba(0,0,0,0.5)' } },
    }],
  };
});

function render() {
  if (!chartEl.value || !option.value) return;
  if (!chart) {
    chart = echarts.init(chartEl.value);
    chart.on('click', (p) => {
      const d = p.data?.directive;
      if (d) {
        selected.value = d;
        emit('cell-click', d);
      }
    });
  }
  chart.setOption(option.value, true);
}

onMounted(() => {
  render();
  ro = new ResizeObserver(() => chart?.resize());
  if (chartEl.value) ro.observe(chartEl.value);
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
    <div ref="chartEl" class="w-full" :style="{ height: `${height}px` }"
         role="img" aria-label="Тепловая карта переспама и недоспама лемм"></div>
    <div v-if="selected"
         class="mt-2 text-xs rounded border px-3 py-2"
         :class="selected.delta > 0
           ? 'border-blue-700/60 bg-blue-900/20 text-blue-100'
           : (selected.delta < 0 ? 'border-red-700/60 bg-red-900/20 text-red-100'
                                 : 'border-emerald-700/60 bg-emerald-900/20 text-emerald-100')">
      <span class="font-semibold">«{{ selected.lemma }}»:</span> {{ selected.text }}
    </div>
    <div v-else class="mt-2 text-[11px] text-gray-500 italic">
      Кликните по ячейке, чтобы увидеть точную рекомендацию.
    </div>
  </div>
</template>
