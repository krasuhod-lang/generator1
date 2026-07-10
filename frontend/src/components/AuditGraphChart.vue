<script setup>
/**
 * AuditGraphChart.vue — force-graph структуры сайта из отчёта аудита (ТЗ 7.2
 * «Граф»). Узел = страница, цвет = глубина краулинга, красный = есть ошибки,
 * размер = число входящих ссылок. Клик по узлу — emit('select', url).
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts/core';
import { GraphChart } from 'echarts/charts';
import { LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([GraphChart, LegendComponent, TooltipComponent, CanvasRenderer]);

const props = defineProps({
  graph:  { type: Object, required: true },  // { nodes: [{id,depth,issues,inlinks,status_code}], edges: [[s,t]] }
  height: { type: Number, default: 560 },
});
const emit = defineEmits(['select']);

const chartEl = ref(null);
let chart = null;
let ro = null;

const DEPTH_COLORS = ['#2563eb', '#0ea5e9', '#10b981', '#f59e0b', '#a855f7', '#64748b'];

function _shortLabel(url) {
  try {
    const u = new URL(url);
    return u.pathname === '/' ? u.hostname : u.pathname.slice(0, 40);
  } catch (_) { return url.slice(0, 40); }
}

const option = computed(() => {
  const g = props.graph || {};
  const nodes = (g.nodes || []).map((n) => ({
    id: n.id,
    name: _shortLabel(n.id),
    value: n.id,
    symbolSize: Math.min(10 + Math.sqrt(Number(n.inlinks) || 0) * 3, 34),
    category: n.issues > 0 ? DEPTH_COLORS.length : Math.min(Number(n.depth) || 0, DEPTH_COLORS.length - 1),
    depth: n.depth,
    issues: n.issues,
    status_code: n.status_code,
  }));
  const links = (g.edges || []).map(([s, t]) => ({ source: s, target: t }));
  const categories = DEPTH_COLORS.map((c, i) => ({
    name: i === DEPTH_COLORS.length - 1 ? `Глубина ${i}+` : `Глубина ${i}`,
    itemStyle: { color: c },
  }));
  categories.push({ name: 'С ошибками', itemStyle: { color: '#dc2626' } });

  return {
    backgroundColor: 'transparent',
    tooltip: {
      formatter: (p) => {
        if (p.dataType === 'edge') return `${p.data.source} → ${p.data.target}`;
        const d = p.data || {};
        return `<b>${d.value}</b><br/>Глубина: ${d.depth}<br/>Ошибок: ${d.issues}<br/>Статус: ${d.status_code || '—'}`;
      },
    },
    legend: { top: 0, textStyle: { fontSize: 11 } },
    series: [{
      type: 'graph',
      layout: 'force',
      roam: true,
      data: nodes,
      links,
      categories,
      force: { repulsion: 90, edgeLength: [30, 90], gravity: 0.12, friction: 0.2 },
      lineStyle: { color: '#cbd5e1', opacity: 0.6, curveness: 0.05 },
      label: { show: false },
      emphasis: { focus: 'adjacency', label: { show: true, fontSize: 10 } },
      scaleLimit: { min: 0.3, max: 6 },
    }],
  };
});

function render() {
  if (!chart && chartEl.value) chart = echarts.init(chartEl.value);
  if (chart) chart.setOption(option.value, true);
}

onMounted(() => {
  render();
  if (chart) {
    chart.on('click', (p) => {
      if (p.dataType === 'node' && p.data && p.data.value) emit('select', p.data.value);
    });
  }
  ro = new ResizeObserver(() => chart && chart.resize());
  if (chartEl.value) ro.observe(chartEl.value);
});
watch(option, render);
onBeforeUnmount(() => {
  if (ro) ro.disconnect();
  if (chart) { chart.dispose(); chart = null; }
});
</script>

<template>
  <div ref="chartEl" :style="{ width: '100%', height: height + 'px' }"></div>
</template>
