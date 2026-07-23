<script setup>
/**
 * RelevanceRadarChart.vue — лепестковая диаграмма (Radar) «наш сайт vs ТОП»
 * (ТЗ 23.07.2026 п.3.1). Заменяет скучную таблицу сравнения наглядным графиком.
 *
 * Серии (кольца): «Наш сайт», «Медиана ТОПа», «Лидер ТОПа».
 * Метрики (оси): Объём текста, BM25 Score, Плотность LSI, Охват важных лемм.
 * H2/H3 добавляется как отдельная ось, если данные доступны (comparison.summary
 * .our_h_count / median_h_count_top). Все значения нормируются к 0–100 внутри
 * оси (относительно максимума среди трёх серий), чтобы разномасштабные метрики
 * читались на одной диаграмме.
 *
 * Источник данных: comparison.competitor_table (per-doc) + comparison.summary.
 * Компонент graceful: при недостатке данных ничего не рендерит (v-if снаружи).
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts/core';
import { RadarChart } from 'echarts/charts';
import { LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([RadarChart, LegendComponent, TooltipComponent, CanvasRenderer]);

const props = defineProps({
  comparison: { type: Object, required: true },
  height:     { type: Number, default: 360 },
});

const chartEl = ref(null);
let chart = null;
let ro = null;

function _median(nums) {
  const arr = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!arr.length) return 0;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

// Три «сущности» для колец радара, собранные из competitor_table.
const entities = computed(() => {
  const rows = Array.isArray(props.comparison?.competitor_table)
    ? props.comparison.competitor_table : [];
  const ours = rows.find((r) => r && r.is_ours) || null;
  const comps = rows.filter((r) => r && !r.is_ours);
  if (!comps.length) return null;

  const medBm25   = _median(comps.map((c) => Number(c.bm25_score_norm) || 0));
  const medWords  = _median(comps.map((c) => Number(c.word_count) || 0));
  const medLsi    = _median(comps.map((c) => Number(c.lsi_coverage_pct) || 0));
  const medTokens = _median(comps.map((c) => Number(c.tokens) || 0));

  // Лидер: по позиции в SERP (1-я), иначе по bm25_score_norm.
  const leader = [...comps].sort((a, b) => {
    const ap = a.serp_position == null ? Infinity : Number(a.serp_position);
    const bp = b.serp_position == null ? Infinity : Number(b.serp_position);
    if (ap !== bp) return ap - bp;
    return (Number(b.bm25_score_norm) || 0) - (Number(a.bm25_score_norm) || 0);
  })[0];

  const sum = props.comparison?.summary || {};
  const ourH = Number(sum.our_h_count);
  const medH = Number(sum.median_h_count_top);
  const hasH = Number.isFinite(ourH) || Number.isFinite(medH);

  return {
    hasH,
    our: ours ? {
      bm25: Number(ours.bm25_score_norm) || 0,
      words: Number(ours.word_count) || 0,
      lsi: Number(ours.lsi_coverage_pct) || 0,
      tokens: Number(ours.tokens) || 0,
      h: Number.isFinite(ourH) ? ourH : 0,
    } : null,
    median: {
      bm25: medBm25, words: medWords, lsi: medLsi, tokens: medTokens,
      h: Number.isFinite(medH) ? medH : 0,
    },
    leader: {
      bm25: Number(leader?.bm25_score_norm) || 0,
      words: Number(leader?.word_count) || 0,
      lsi: Number(leader?.lsi_coverage_pct) || 0,
      tokens: Number(leader?.tokens) || 0,
      h: Number.isFinite(medH) ? medH : 0, // на уровне доков лидера H нет — берём медиану
    },
  };
});

const option = computed(() => {
  const e = entities.value;
  if (!e) return null;

  // Оси радара. Максимум по каждой оси — для нормировки в проценты.
  const metrics = [
    { key: 'words',  name: 'Объём текста' },
    { key: 'bm25',   name: 'BM25 Score' },
    { key: 'lsi',    name: 'Плотность LSI' },
    { key: 'tokens', name: 'Охват лемм' },
  ];
  if (e.hasH) metrics.push({ key: 'h', name: 'Кол-во H2/H3' });

  const series = [
    { name: 'Наш сайт',     data: e.our, color: '#6366F1' },
    { name: 'Медиана ТОПа', data: e.median, color: '#22C55E' },
    { name: 'Лидер ТОПа',   data: e.leader, color: '#F59E0B' },
  ].filter((s) => s.data);

  const indicator = metrics.map((m) => {
    const max = Math.max(...series.map((s) => Number(s.data[m.key]) || 0), 1);
    return { name: m.name, max: 100, _raw: m.key, _absMax: max };
  });

  const fmtRaw = (key, v) => {
    if (key === 'bm25') return (Number(v) * 100).toFixed(0) + '%';
    if (key === 'lsi') return Number(v).toFixed(1) + '%';
    return Number(v).toLocaleString('ru-RU');
  };

  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      backgroundColor: 'rgba(15,23,42,0.96)',
      borderColor: '#334155',
      textStyle: { color: '#e2e8f0' },
      formatter(p) {
        const s = series[p.seriesIndex] || series.find((x) => x.name === p.name);
        if (!s) return p.name;
        let html = `<div style="font-weight:600;margin-bottom:4px">${p.name}</div>`;
        metrics.forEach((m) => {
          html += `<div>${m.name}: <b>${fmtRaw(m.key, s.data[m.key])}</b></div>`;
        });
        return html;
      },
    },
    legend: {
      top: 0,
      textStyle: { color: '#9ca3af' },
      data: series.map((s) => s.name),
    },
    radar: {
      indicator,
      center: ['50%', '56%'],
      radius: '66%',
      axisName: { color: '#cbd5e1', fontSize: 11 },
      splitLine: { lineStyle: { color: '#334155' } },
      splitArea: { areaStyle: { color: ['rgba(30,41,59,0.35)', 'rgba(15,23,42,0.35)'] } },
      axisLine: { lineStyle: { color: '#334155' } },
    },
    series: [{
      type: 'radar',
      emphasis: { focus: 'series' },
      data: series.map((s) => ({
        name: s.name,
        value: indicator.map((ind) => {
          const raw = Number(s.data[ind._raw]) || 0;
          return ind._absMax > 0 ? Math.round((raw / ind._absMax) * 100) : 0;
        }),
        symbolSize: 4,
        lineStyle: { color: s.color, width: 2 },
        itemStyle: { color: s.color },
        areaStyle: { color: s.color, opacity: 0.12 },
      })),
    }],
  };
});

function render() {
  if (!chartEl.value || !option.value) return;
  if (!chart) chart = echarts.init(chartEl.value);
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
  <div ref="chartEl" class="w-full" :style="{ height: `${height}px` }"
       role="img" aria-label="Лепестковая диаграмма: наш сайт против медианы и лидера ТОПа"></div>
</template>
