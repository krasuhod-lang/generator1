<script setup>
/**
 * ReportRenderer — отвечает за визуализацию всех блоков отчёта
 * (header, summary, highlights, charts, forecast, tasks).
 *
 * Используется и в редакторе (readonly=false: можно редактировать tasks-блоки),
 * и в публичной странице (readonly=true).
 *
 * Props:
 *   data    — payload агрегатора (см. dataAggregator.aggregateForDraft).
 *   summary — { executive_summary, highlights[], growth_attribution[] }
 *   tasksBlocks — Array<{ section, items: string[] }>
 *   title, period, project
 *   mode: 'live' | 'snapshot'
 *   capturedAt: ISO string (для snapshot — момент заморозки)
 *   readonly: boolean
 */
import { computed } from 'vue';
import ReportTrendChart from './ReportTrendChart.vue';

const props = defineProps({
  data:        { type: Object, default: () => ({}) },
  summary:     { type: Object, default: () => ({}) },
  tasksBlocks: { type: Array,  default: () => [] },
  title:       { type: String, default: '' },
  period:      { type: String, default: '' },
  project:     { type: Object, default: () => ({}) },
  mode:        { type: String, default: 'live' },
  capturedAt:  { type: String, default: null },
  readonly:    { type: Boolean, default: true },
});
const emit = defineEmits(['update:tasksBlocks']);

const accent = computed(() => props.project?.color_accent || '#0071e3');
const accentBg = computed(() => `${accent.value}1A`); // 10% opacity hex

// ─── GSC chart ───────────────────────────────────────────────────────────
const gscChart = computed(() => {
  const series = props.data?.gsc?.series || [];
  const fc = props.data?.forecast?.gsc_clicks?.forecast || [];
  if (!series.length) return null;
  const labels = [...series.map((r) => r.date)];
  // Прогноз — добавляем будущие месяцы.
  const lastDate = series[series.length - 1].date;
  for (let i = 1; i <= fc.length; i++) {
    labels.push(_addMonths(lastDate, i));
  }
  const histClicks = series.map((r) => Number(r.clicks) || 0);
  const histImpr = series.map((r) => Number(r.impressions) || 0);
  // Заполняем будущие позиции nulls для исторических.
  for (let i = 0; i < fc.length; i++) { histClicks.push(null); histImpr.push(null); }
  // Прогноз: nulls для прошлого, потом значения.
  const fcClicks = series.map(() => null);
  fcClicks.push(...fc.map((v) => Math.round(v)));

  return {
    labels,
    datasets: [
      { label: 'Клики', color: accent.value, data: histClicks },
      { label: 'Показы', color: '#a2a2a8', data: histImpr },
      ...(fc.length ? [{ label: 'Прогноз кликов', color: '#ff7a00', data: fcClicks, dashed: true, fill: true }] : []),
    ],
  };
});

const ywmChart = computed(() => {
  const series = props.data?.ywm?.series || [];
  if (!series.length) return null;
  const labels = series.map((r) => r.date);
  return {
    labels,
    datasets: [
      { label: 'Клики (Я)', color: '#ff5a3c', data: series.map((r) => Number(r.clicks) || 0) },
      { label: 'Показы (Я)', color: '#ffb38a', data: series.map((r) => Number(r.impressions) || 0) },
    ],
  };
});

const keysChart = computed(() => {
  const series = props.data?.keys_so?.series || [];
  const fc = props.data?.forecast?.keys_visibility?.forecast || [];
  if (!series.length) return null;
  const labels = [...series.map((r) => r.date)];
  const lastDate = series[series.length - 1].date;
  for (let i = 1; i <= fc.length; i++) labels.push(_addMonths(lastDate, i));
  const visibility = series.map((r) => (r.visibility != null ? Number(r.visibility) : null));
  for (let i = 0; i < fc.length; i++) visibility.push(null);
  const fcVis = series.map(() => null);
  fcVis.push(...fc.map((v) => Math.round(v * 10000) / 10000));

  return {
    labels,
    datasets: [
      { label: 'Видимость Keys.so', color: '#6e5dc6', data: visibility, yAxisID: 'y2' },
      ...(fc.length ? [{ label: 'Прогноз видимости', color: '#ff7a00', data: fcVis, dashed: true, yAxisID: 'y2' }] : []),
    ],
    showSecondAxis: true,
  };
});

function _addMonths(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

// ─── Totals card ────────────────────────────────────────────────────────
const totals = computed(() => {
  const out = [];
  const g = props.data?.gsc?.totals;
  if (g) {
    out.push({ label: 'Клики Google', value: g.clicks });
    out.push({ label: 'Показы Google', value: g.impressions });
    out.push({ label: 'CTR', value: g.ctr != null ? `${(g.ctr * 100).toFixed(2)}%` : '—' });
    out.push({ label: 'Ср. позиция', value: g.position != null ? g.position.toFixed(1) : '—' });
  }
  const y = props.data?.ywm?.totals;
  if (y) {
    out.push({ label: 'Клики Яндекс', value: y.clicks });
  }
  const k = props.data?.keys_so?.current;
  if (k) {
    out.push({ label: 'Запросы в ТОП-10', value: k.top10 || 0 });
  }
  return out;
});

// ─── Tasks blocks editing ───────────────────────────────────────────────
function addSection() {
  const next = [...(props.tasksBlocks || []), { section: 'Новый раздел', items: [] }];
  emit('update:tasksBlocks', next);
}
function removeSection(i) {
  const next = (props.tasksBlocks || []).slice();
  next.splice(i, 1);
  emit('update:tasksBlocks', next);
}
function addItem(i) {
  const next = (props.tasksBlocks || []).map((b, idx) => idx === i ? { ...b, items: [...b.items, ''] } : b);
  emit('update:tasksBlocks', next);
}
function updateSection(i, key, value) {
  const next = (props.tasksBlocks || []).map((b, idx) => idx === i ? { ...b, [key]: value } : b);
  emit('update:tasksBlocks', next);
}
function updateItem(i, j, value) {
  const next = (props.tasksBlocks || []).map((b, idx) => {
    if (idx !== i) return b;
    const items = b.items.slice();
    items[j] = value;
    return { ...b, items };
  });
  emit('update:tasksBlocks', next);
}
function removeItem(i, j) {
  const next = (props.tasksBlocks || []).map((b, idx) => {
    if (idx !== i) return b;
    const items = b.items.slice();
    items.splice(j, 1);
    return { ...b, items };
  });
  emit('update:tasksBlocks', next);
}

function formatDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('ru-RU');
}
function _minutesAgo(iso) {
  if (!iso) return '';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 60) return `${m} мин назад`;
  return `${Math.round(m / 60)} ч назад`;
}
</script>

<template>
  <div class="report-renderer" :style="{ '--accent': accent, '--accent-bg': accentBg }">
    <!-- HEADER -->
    <section class="rblk header">
      <div class="header-main">
        <img v-if="project?.logo_url" :src="project.logo_url" :alt="project.name" class="logo" />
        <div>
          <div class="brand">{{ project?.name }}<span v-if="project?.url" class="brand-url"> · {{ project.url }}</span></div>
          <h1 class="rep-title">{{ title }}</h1>
          <div class="rep-period">{{ period }}</div>
        </div>
      </div>
      <div class="header-meta">
        <span v-if="mode === 'live'" class="live-badge">🔴 Live</span>
        <span v-else-if="capturedAt" class="snap-badge">Снимок · {{ formatDateTime(capturedAt) }}</span>
      </div>
    </section>

    <!-- SUMMARY (AI) -->
    <section v-if="summary?.executive_summary" class="rblk">
      <h2>Резюме</h2>
      <p class="summary-text">{{ summary.executive_summary }}</p>
    </section>

    <!-- TOTALS -->
    <section v-if="totals.length" class="rblk">
      <h2>Ключевые показатели</h2>
      <div class="totals-grid">
        <div v-for="(t, i) in totals" :key="i" class="total-card">
          <div class="t-label">{{ t.label }}</div>
          <div class="t-value">{{ t.value }}</div>
        </div>
      </div>
    </section>

    <!-- HIGHLIGHTS -->
    <section v-if="summary?.highlights?.length" class="rblk">
      <h2>Главные достижения</h2>
      <ul class="highlights-list">
        <li v-for="(h, i) in summary.highlights" :key="i">
          <strong v-if="h.title">{{ h.title }}.</strong>
          <span v-if="h.detail"> {{ h.detail }}</span>
          <span v-else-if="typeof h === 'string'">{{ h }}</span>
        </li>
      </ul>
    </section>

    <!-- GSC CHART -->
    <section v-if="gscChart" class="rblk">
      <h2>Google Search Console</h2>
      <ReportTrendChart :labels="gscChart.labels" :datasets="gscChart.datasets" />
    </section>

    <!-- YWM CHART -->
    <section v-if="ywmChart" class="rblk">
      <h2>Яндекс.Вебмастер</h2>
      <ReportTrendChart :labels="ywmChart.labels" :datasets="ywmChart.datasets" />
    </section>

    <!-- KEYS.SO CHART -->
    <section v-if="keysChart" class="rblk">
      <h2>Видимость в поиске (Keys.so)</h2>
      <ReportTrendChart
        :labels="keysChart.labels"
        :datasets="keysChart.datasets"
        :show-second-axis="true" />
      <div v-if="data?.keys_so?.current" class="keys-current">
        Текущая видимость: <strong>{{ (Number(data.keys_so.current.visibility) * 100).toFixed(2) }}%</strong>,
        ТОП-10: <strong>{{ data.keys_so.current.top10 || 0 }}</strong>,
        всего ключей: <strong>{{ data.keys_so.current.total || 0 }}</strong>
      </div>
    </section>

    <!-- GROWTH ATTRIBUTION -->
    <section v-if="summary?.growth_attribution?.length" class="rblk">
      <h2>Что повлияло на рост</h2>
      <ul class="highlights-list">
        <li v-for="(g, i) in summary.growth_attribution" :key="i">
          <strong v-if="g.metric">{{ g.metric }}:</strong>
          <span v-if="g.attribution"> {{ g.attribution }}</span>
          <span v-else-if="typeof g === 'string'">{{ g }}</span>
        </li>
      </ul>
    </section>

    <!-- TASKS BLOCKS -->
    <section v-if="tasksBlocks.length || !readonly" class="rblk">
      <div class="section-head">
        <h2>Выполненные работы</h2>
        <button v-if="!readonly" class="btn-link" @click="addSection">+ Раздел</button>
      </div>
      <div v-if="!tasksBlocks.length && readonly" class="muted">Нет добавленных работ.</div>
      <div v-for="(block, i) in tasksBlocks" :key="i" class="tasks-block">
        <div class="tb-head">
          <input v-if="!readonly"
                 class="tb-section-input"
                 :value="block.section"
                 @input="updateSection(i, 'section', $event.target.value)" />
          <h3 v-else>{{ block.section }}</h3>
          <button v-if="!readonly" class="btn-link danger" @click="removeSection(i)">Удалить</button>
        </div>
        <ul class="tb-items">
          <li v-for="(item, j) in block.items" :key="j">
            <input v-if="!readonly" :value="item" @input="updateItem(i, j, $event.target.value)" />
            <span v-else>{{ item }}</span>
            <button v-if="!readonly" class="btn-link danger" @click="removeItem(i, j)">×</button>
          </li>
        </ul>
        <button v-if="!readonly" class="btn-link" @click="addItem(i)">+ Пункт</button>
      </div>
    </section>

    <!-- TASKS AUTOLOG (informational) -->
    <section v-if="data?.tasks?.items?.length" class="rblk">
      <h2>Автозалог работ платформы</h2>
      <ul class="autolog-list">
        <li v-for="t in data.tasks.items.slice(0, 30)" :key="t.id">
          <span class="task-date">{{ String(t.performed_at).slice(0, 10) }}</span>
          <span class="task-type">{{ t.task_type }}</span>
          <span class="task-title">{{ t.title }}</span>
        </li>
      </ul>
    </section>

    <footer class="rblk footer">
      <span v-if="capturedAt && mode === 'snapshot'">Данные на: {{ formatDateTime(capturedAt) }}</span>
      <span v-else-if="data?.generated_at">Обновлено {{ _minutesAgo(data.generated_at) }}</span>
    </footer>
  </div>
</template>

<style scoped>
.report-renderer {
  --accent: #0071e3;
  --accent-bg: rgba(0,113,227,0.1);
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.rblk {
  background: #fff;
  border-radius: 12px;
  padding: 20px 24px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
}
.rblk h2 {
  font-size: 18px; margin: 0 0 12px;
  color: var(--accent);
}
.rblk h3 { font-size: 15px; margin: 0; }
.section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.header { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; background: linear-gradient(135deg, var(--accent-bg), #fff); border-left: 4px solid var(--accent); }
.header-main { display: flex; gap: 16px; align-items: center; }
.logo { width: 56px; height: 56px; object-fit: contain; border-radius: 8px; background: #fff; padding: 4px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
.brand { font-size: 13px; color: rgba(0,0,0,0.55); }
.brand-url { color: rgba(0,0,0,0.4); }
.rep-title { font-size: 22px; margin: 4px 0 2px; }
.rep-period { font-size: 13px; color: rgba(0,0,0,0.55); }
.live-badge { background: rgba(220,40,40,0.12); color: #b00020; padding: 4px 10px; border-radius: 16px; font-size: 12px; font-weight: 500; }
.snap-badge { color: rgba(0,0,0,0.55); font-size: 12px; }
.summary-text { white-space: pre-wrap; line-height: 1.6; color: rgba(0,0,0,0.8); margin: 0; }
.totals-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.total-card { padding: 14px; background: var(--accent-bg); border-radius: 10px; border-left: 3px solid var(--accent); }
.t-label { font-size: 12px; color: rgba(0,0,0,0.55); margin-bottom: 4px; }
.t-value { font-size: 22px; font-weight: 600; color: rgba(0,0,0,0.85); }
.highlights-list, .autolog-list { padding-left: 18px; margin: 0; line-height: 1.7; }
.highlights-list strong { color: var(--accent); }
.tasks-block { padding: 12px 0; border-top: 1px solid rgba(0,0,0,0.06); }
.tasks-block:first-of-type { border-top: 0; }
.tb-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.tb-section-input { font-size: 15px; font-weight: 600; padding: 6px 8px; border: 1px solid rgba(0,0,0,0.12); border-radius: 6px; flex: 1; }
.tb-items { list-style: disc; padding-left: 22px; margin: 6px 0; }
.tb-items li { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
.tb-items li input { flex: 1; padding: 5px 8px; border: 1px solid rgba(0,0,0,0.12); border-radius: 6px; font-size: 14px; }
.autolog-list { list-style: none; padding-left: 0; }
.autolog-list li { display: grid; grid-template-columns: 90px 130px 1fr; gap: 8px; padding: 4px 0; border-bottom: 1px solid rgba(0,0,0,0.04); font-size: 13px; }
.task-date { color: rgba(0,0,0,0.5); }
.task-type { color: var(--accent); font-weight: 500; }
.keys-current { margin-top: 10px; font-size: 13px; color: rgba(0,0,0,0.65); }
.muted { color: rgba(0,0,0,0.45); font-style: italic; }
.btn-link { background: none; border: none; color: var(--accent); cursor: pointer; font-size: 13px; padding: 4px 6px; }
.btn-link.danger { color: #b00020; }
.footer { background: transparent; box-shadow: none; padding: 8px 0; text-align: right; font-size: 12px; color: rgba(0,0,0,0.45); }

@media (max-width: 600px) {
  .rblk { padding: 16px; }
  .rep-title { font-size: 18px; }
  .totals-grid { grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); }
  .autolog-list li { grid-template-columns: 1fr; gap: 2px; }
}
</style>
