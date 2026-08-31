<script setup>
/**
 * AuditGraphChart.vue — force-graph структуры сайта из отчёта аудита (ТЗ 7.2
 * «Граф»). Узел = страница, цвет = максимальная критичность,
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

const SEVERITY_COLORS = {
  none: '#64748b',
  info: '#38bdf8',
  low: '#94a3b8',
  medium: '#f59e0b',
  high: '#f97316',
  critical: '#ef4444',
  blocked: '#475569',
};
const SEVERITY_LABELS = {
  none: 'Без ошибок', info: 'Информация', low: 'Low', medium: 'Medium',
  high: 'High', critical: 'Critical', blocked: 'Закрыто robots.txt',
};
const CATEGORY_KEYS = Object.keys(SEVERITY_COLORS);

function _shortLabel(url) {
  try {
    const u = new URL(url);
    return u.pathname === '/' ? u.hostname : u.pathname.slice(0, 40);
  } catch (_) { return url.slice(0, 40); }
}

const option = computed(() => {
  const g = props.graph || {};
  const nodes = (g.nodes || []).map((n) => {
    const severity = n.severity || (n.issues > 0 ? 'medium' : 'none');
    return {
      id: n.id,
      name: _shortLabel(n.id),
      value: n.id,
      symbolSize: Math.min(10 + Math.sqrt(Number(n.inlinks) || 0) * 3, 34),
      category: Math.max(0, CATEGORY_KEYS.indexOf(severity)),
      depth: n.depth,
      issues: n.issue_count ?? n.issues ?? 0,
      issue_types: n.issue_types ?? 0,
      severity,
      status_code: n.status_code,
    };
  });
  const links = (g.edges || []).map(([s, t]) => ({ source: s, target: t }));
  const categories = Object.entries(SEVERITY_COLORS).map(([key, color]) => ({
    name: SEVERITY_LABELS[key],
    itemStyle: { color },
  }));

  return {
    backgroundColor: 'transparent',
    tooltip: {
      formatter: (p) => {
        if (p.dataType === 'edge') return `${p.data.source} → ${p.data.target}`;
        const d = p.data || {};
        const sev = d.severity || 'none';
        return `<b>${d.value}</b><br/>Критичность: ${SEVERITY_LABELS[sev] || sev}<br/>Правил: ${d.issue_types || 0}<br/>Фактов: ${d.issues || 0}<br/>Глубина: ${d.depth}<br/>Статус: ${d.status_code || '—'}`;
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
      force: { repulsion: 120, edgeLength: [45, 120], gravity: 0.12, friction: 0.2 },
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
