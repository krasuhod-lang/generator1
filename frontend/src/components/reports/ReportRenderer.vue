<script setup>
import { computed } from 'vue';
import DOMPurify from 'dompurify';
import ReportTrendChart from './ReportTrendChart.vue';
import PositionChart from '../PositionChart.vue';

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

const accent = computed(() => props.project?.color_accent || '#0a84ff');
const accentBg = computed(() => `${accent.value}15`);

const gscChart = computed(() => {
  const series = props.data?.gsc?.series || [];
  if (!series.length) return null;
  return {
    labels: series.map((r) => r.date),
    datasets: [
      { label: 'Клики', color: accent.value, data: series.map((r) => Number(r.clicks) || 0) },
      { label: 'Показы', color: '#8b95a7', data: series.map((r) => Number(r.impressions) || 0) },
      { label: 'CTR', color: '#10b981', data: series.map((r) => Number(r.ctr) || 0), yAxisID: 'y2' },
    ],
    annotations: props.data?.tasks?.annotations || [],
    showSecondAxis: true,
  };
});

const ywmChart = computed(() => {
  const series = props.data?.ywm?.series || [];
  if (!series.length) return null;
  return {
    labels: series.map((r) => r.date),
    datasets: [
      { label: 'Клики (Яндекс)', color: '#ff5a3c', data: series.map((r) => Number(r.clicks) || 0) },
      { label: 'Показы (Яндекс)', color: '#ffb38a', data: series.map((r) => Number(r.impressions) || 0) },
      { label: 'CTR', color: '#ef4444', data: series.map((r) => Number(r.ctr) || 0), yAxisID: 'y2' },
    ],
    annotations: props.data?.tasks?.annotations || [],
    showSecondAxis: true,
  };
});

const keysChart = computed(() => {
  const series = props.data?.keys_so?.series || [];
  if (!series.length) return null;
  return {
    labels: series.map((r) => r.date),
    datasets: [
      { label: 'Видимость', color: '#6e5dc6', data: series.map((r) => Number(r.visibility) || 0), yAxisID: 'y2' },
      { label: 'ТОП-10', color: '#2563eb', data: series.map((r) => Number(r.keywords_top10) || 0) },
      { label: 'ТОП-50', color: '#f59e0b', data: series.map((r) => Number(r.keywords_top50) || 0) },
    ],
    annotations: props.data?.tasks?.annotations || [],
    showSecondAxis: true,
  };
});

const totals = computed(() => {
  const out = [];
  const g = props.data?.gsc?.totals;
  if (g) {
    out.push({ label: 'Google клики', value: Number(g.clicks || 0).toLocaleString('ru-RU') });
    out.push({ label: 'Google показы', value: Number(g.impressions || 0).toLocaleString('ru-RU') });
    out.push({ label: 'Google CTR', value: g.ctr != null ? `${(Number(g.ctr) * 100).toFixed(2)}%` : '—' });
    out.push({ label: 'Ср. позиция', value: g.position != null ? Number(g.position).toFixed(1) : '—' });
  }
  const k = props.data?.keys_so?.current;
  if (k) {
    out.push({ label: 'Видимость Keys.so', value: k.visibility != null ? Number(k.visibility).toFixed(2) : '—' });
    out.push({ label: 'ТОП-10', value: Number(k.top10 || 0).toLocaleString('ru-RU') });
    out.push({ label: 'ТОП-50', value: Number(k.top50 || 0).toLocaleString('ru-RU') });
  }
  const p = props.data?.position?.summary;
  if (p) {
    out.push({ label: 'Средняя позиция', value: p.avg_position != null ? Number(p.avg_position).toFixed(1) : '—' });
    out.push({ label: 'Запросов в ТОП-10', value: Number(p.top10 || 0).toLocaleString('ru-RU') });
  }
  return out;
});

const growthItems = computed(() => {
  const raw = props.summary?.growth_attribution;
  if (!raw) return [];
  if (typeof raw === 'string') return [{ metric: 'Общая динамика', attribution: raw, conclusion: '', forecast: '', weak_zones: '' }];
  if (!Array.isArray(raw)) return [];
  return raw.map((g) => ({
    metric: String(g?.metric || '').trim(),
    attribution: String(g?.attribution || '').trim(),
    conclusion: String(g?.conclusion || '').trim(),
    forecast: String(g?.forecast || '').trim(),
    weak_zones: String(g?.weak_zones || '').trim(),
  })).filter((g) => g.metric || g.attribution || g.conclusion || g.forecast || g.weak_zones);
});

const quickWinsItems = computed(() => (
  Array.isArray(props.summary?.quick_wins) && props.summary.quick_wins.length
    ? props.summary.quick_wins
    : (props.data?.position?.quick_wins || [])
));

const normalizedTasks = computed(() => normalizeBlocks(props.tasksBlocks));

function normalizeBlocks(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) return [];
  if (blocks[0]?.month && Array.isArray(blocks[0]?.sections)) return blocks;
  return [{
    month: 'Выполненные работы',
    sections: blocks.map((block) => ({
      title: block.section || 'Раздел',
      tasks: (block.items || []).map((item) => ({ title: String(item || ''), description_html: '' })),
    })),
  }];
}

function updateBlocks(next) {
  emit('update:tasksBlocks', next);
}
function cloneBlocks() {
  return JSON.parse(JSON.stringify(normalizedTasks.value));
}
function addMonth() {
  const next = cloneBlocks();
  next.push({ month: new Date().toISOString().slice(0, 7), sections: [] });
  updateBlocks(next);
}
function removeMonth(i) {
  const next = cloneBlocks();
  next.splice(i, 1);
  updateBlocks(next);
}
function addSection(i) {
  const next = cloneBlocks();
  next[i].sections.push({ title: 'Новый раздел', tasks: [] });
  updateBlocks(next);
}
function addTask(i, j) {
  const next = cloneBlocks();
  next[i].sections[j].tasks.push({ title: 'Новая задача', description_html: '' });
  updateBlocks(next);
}
function updateMonth(i, value) {
  const next = cloneBlocks();
  next[i].month = value;
  updateBlocks(next);
}
function updateSection(i, j, value) {
  const next = cloneBlocks();
  next[i].sections[j].title = value;
  updateBlocks(next);
}
function updateTask(i, j, k, key, value) {
  const next = cloneBlocks();
  next[i].sections[j].tasks[k][key] = value;
  updateBlocks(next);
}
function removeSection(i, j) {
  const next = cloneBlocks();
  next[i].sections.splice(j, 1);
  updateBlocks(next);
}
function removeTask(i, j, k) {
  const next = cloneBlocks();
  next[i].sections[j].tasks.splice(k, 1);
  updateBlocks(next);
}

function safeHtml(value) {
  return DOMPurify.sanitize(value || '', {
    ALLOWED_TAGS: ['a', 'p', 'br', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i'],
    ALLOWED_ATTR: ['href', 'target', 'rel'],
  });
}

function formatDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('ru-RU');
}
</script>

<template>
  <div class="report-renderer" :style="{ '--accent': accent, '--accent-bg': accentBg }">
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
        <span v-if="mode === 'live'" class="live-badge">Live</span>
        <span v-else-if="capturedAt" class="snap-badge">Снимок · {{ formatDateTime(capturedAt) }}</span>
      </div>
    </section>

    <section v-if="summary?.executive_summary" class="rblk">
      <h2>Executive Summary</h2>
      <p class="summary-text">{{ summary.executive_summary }}</p>
    </section>

    <section v-if="summary?.traffic_value || data?.traffic_value?.label" class="rblk savings-card">
      <h2>SEO Traffic Value</h2>
      <p>{{ summary?.traffic_value || data?.traffic_value?.label }}</p>
    </section>

    <section v-if="totals.length" class="rblk">
      <h2>Ключевые показатели</h2>
      <div class="totals-grid">
        <div v-for="(t, i) in totals" :key="i" class="total-card">
          <div class="t-label">{{ t.label }}</div>
          <div class="t-value">{{ t.value }}</div>
        </div>
      </div>
    </section>

    <section v-if="summary?.highlights?.length" class="rblk">
      <h2>Главные достижения</h2>
      <ul class="list">
        <li v-for="(item, idx) in summary.highlights" :key="idx">{{ typeof item === 'string' ? item : `${item.title || ''} ${item.detail || ''}`.trim() }}</li>
      </ul>
    </section>

    <section v-if="gscChart" class="rblk" data-report-chart="gsc" data-report-chart-title="Google Search Console">
      <h2>Google Search Console</h2>
      <ReportTrendChart :labels="gscChart.labels" :datasets="gscChart.datasets" :annotations="gscChart.annotations" :show-second-axis="gscChart.showSecondAxis" />
    </section>

    <section v-if="ywmChart" class="rblk" data-report-chart="ywm" data-report-chart-title="Яндекс.Вебмастер">
      <h2>Яндекс.Вебмастер</h2>
      <ReportTrendChart :labels="ywmChart.labels" :datasets="ywmChart.datasets" :annotations="ywmChart.annotations" :show-second-axis="ywmChart.showSecondAxis" />
    </section>

    <section v-if="keysChart" class="rblk" data-report-chart="keys" data-report-chart-title="Видимость Keys.so">
      <h2>Видимость в поиске (Keys.so)</h2>
      <ReportTrendChart :labels="keysChart.labels" :datasets="keysChart.datasets" :annotations="keysChart.annotations" :show-second-axis="keysChart.showSecondAxis" />
    </section>

    <section v-if="data?.position?.connected && data?.position?.series?.length" class="rblk" data-report-chart="position" data-report-chart-title="Динамика позиций">
      <h2>Динамика позиций</h2>
      <PositionChart :series="data.position.series" mode="position" />
    </section>

    <section v-if="growthItems.length" class="rblk">
      <h2>Анализ показателей</h2>
      <div class="growth-grid">
        <article v-for="(item, idx) in growthItems" :key="idx" class="growth-card">
          <h3>{{ item.metric || 'Метрика' }}</h3>
          <p v-if="item.attribution">{{ item.attribution }}</p>
          <p v-if="item.conclusion"><strong>Вывод:</strong> {{ item.conclusion }}</p>
          <p v-if="item.forecast"><strong>Прогноз:</strong> {{ item.forecast }}</p>
          <p v-if="item.weak_zones"><strong>Точки роста:</strong> {{ item.weak_zones }}</p>
        </article>
      </div>
    </section>

    <section v-if="quickWinsItems.length" class="rblk">
      <h2>Quick Wins</h2>
      <ul class="list">
        <li v-for="(item, idx) in quickWinsItems" :key="idx">
          <strong>{{ item.query }}</strong>
          <span v-if="item.position != null"> · позиция {{ item.position }}</span>
          <span v-if="item.plan"> — {{ item.plan }}</span>
        </li>
      </ul>
    </section>

    <section v-if="summary?.vulnerabilities?.length" class="rblk">
      <h2>Уязвимые места</h2>
      <ul class="list">
        <li v-for="(item, idx) in summary.vulnerabilities" :key="idx">{{ item }}</li>
      </ul>
    </section>

    <section v-if="summary?.roadmap?.length" class="rblk">
      <h2>Roadmap</h2>
      <ol class="list ordered">
        <li v-for="(item, idx) in summary.roadmap" :key="idx">{{ item }}</li>
      </ol>
    </section>

    <section class="rblk">
      <div class="tasks-head">
        <h2>Выполненные работы</h2>
        <button v-if="!readonly" class="small-btn" @click="addMonth">+ Месяц</button>
      </div>
      <div v-if="!normalizedTasks.length" class="empty">Пока нет блоков работ.</div>
      <div v-for="(monthBlock, i) in normalizedTasks" :key="i" class="month-card">
        <div class="month-head">
          <input v-if="!readonly" :value="monthBlock.month" class="text-input month-input" @input="updateMonth(i, $event.target.value)" />
          <h3 v-else>{{ monthBlock.month }}</h3>
          <div v-if="!readonly" class="actions-inline">
            <button class="small-btn" @click="addSection(i)">+ Раздел</button>
            <button class="small-btn danger" @click="removeMonth(i)">Удалить</button>
          </div>
        </div>

        <div v-for="(section, j) in monthBlock.sections" :key="j" class="section-card">
          <div class="month-head">
            <input v-if="!readonly" :value="section.title" class="text-input" @input="updateSection(i, j, $event.target.value)" />
            <h4 v-else>{{ section.title }}</h4>
            <div v-if="!readonly" class="actions-inline">
              <button class="small-btn" @click="addTask(i, j)">+ Задача</button>
              <button class="small-btn danger" @click="removeSection(i, j)">Удалить раздел</button>
            </div>
          </div>

          <div v-for="(task, k) in section.tasks" :key="k" class="task-card">
            <div v-if="readonly">
              <div class="task-title">{{ task.title }}</div>
              <div v-if="task.description_html" class="task-html" v-html="safeHtml(task.description_html)"></div>
            </div>
            <div v-else class="editor-grid">
              <input :value="task.title" class="text-input" placeholder="Название задачи" @input="updateTask(i, j, k, 'title', $event.target.value)" />
              <textarea :value="task.description_html" class="text-area" rows="4" placeholder="HTML / текст описания. Ссылки вида <a href=&quot;...&quot; target=&quot;_blank&quot;>..." @input="updateTask(i, j, k, 'description_html', $event.target.value)"></textarea>
              <div class="task-preview" v-if="task.description_html" v-html="safeHtml(task.description_html)"></div>
              <div class="actions-inline">
                <button class="small-btn danger" @click="removeTask(i, j, k)">Удалить задачу</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.report-renderer {
  display: flex;
  flex-direction: column;
  gap: 16px;
  color: #1d1d1f;
}
.rblk {
  background: #fff;
  border: 1px solid rgba(60,60,67,0.12);
  border-radius: 20px;
  padding: 20px;
  box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.04);
}
.header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}
.header-main { display: flex; gap: 16px; align-items: center; }
.logo { width: 52px; height: 52px; border-radius: 14px; object-fit: cover; }
.brand { color: #6e6e73; font-size: 13px; }
.brand-url { color: #86868b; }
.rep-title { margin: 4px 0 8px; font-size: 30px; line-height: 1.1; }
.rep-period { color: #424245; }
.live-badge, .snap-badge {
  display: inline-flex; padding: 6px 12px; border-radius: 999px; background: var(--accent-bg); color: var(--accent);
  font-size: 12px; font-weight: 600;
}
.summary-text { white-space: pre-wrap; line-height: 1.7; }
.totals-grid, .growth-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}
.total-card, .growth-card, .month-card, .section-card, .task-card {
  border: 1px solid rgba(60,60,67,0.1);
  border-radius: 16px;
  background: #fbfbfd;
}
.total-card { padding: 14px; }
.t-label { color: #6e6e73; font-size: 12px; margin-bottom: 6px; }
.t-value { font-size: 20px; font-weight: 700; }
.growth-card { padding: 16px; }
.list { margin: 0; padding-left: 18px; line-height: 1.7; }
.ordered { padding-left: 22px; }
.savings-card { background: linear-gradient(135deg, #fff8e8 0%, #ffffff 100%); }
.tasks-head, .month-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.month-card { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.section-card { padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.task-card { padding: 12px; background: #fff; }
.task-title { font-weight: 600; margin-bottom: 6px; }
.task-html :deep(a), .task-preview :deep(a) { color: var(--accent); text-decoration: underline; }
.editor-grid { display: flex; flex-direction: column; gap: 10px; }
.text-input, .text-area {
  width: 100%;
  border: 1px solid rgba(60,60,67,0.18);
  border-radius: 12px;
  padding: 10px 12px;
  font: inherit;
  background: #fff;
}
.month-input { max-width: 220px; }
.text-area { resize: vertical; min-height: 110px; }
.small-btn {
  border: 0;
  border-radius: 10px;
  padding: 8px 10px;
  background: rgba(10,132,255,0.08);
  color: var(--accent);
  cursor: pointer;
}
.small-btn.danger { background: rgba(255,59,48,0.08); color: #d70015; }
.actions-inline { display: flex; gap: 8px; flex-wrap: wrap; }
.empty { color: #6e6e73; }
@media (max-width: 720px) {
  .header, .header-main, .month-head, .tasks-head { flex-direction: column; align-items: flex-start; }
  .rep-title { font-size: 24px; }
}
</style>
