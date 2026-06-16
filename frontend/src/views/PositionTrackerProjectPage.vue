<script setup>
/**
 * PositionTrackerProjectPage — детальная страница проекта отслеживания.
 *
 * Содержит:
 *   • заголовок проекта + кнопка «Запустить съём» с прогрессом активного run.
 *   • KPI-карточки (средняя позиция, ТОП-3 / ТОП-10 / ТОП-30, выросло/упало).
 *   • переключатель день/неделя/месяц + SVG-график динамики.
 *   • таблицу запросов с дельтами и блок «Выросло / Упало» за период.
 *   • ввод новых запросов и их удаление.
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import PositionChart from '../components/PositionChart.vue';
import { usePositionTrackerStore } from '../stores/positionTracker.js';

const route = useRoute();
const router = useRouter();
const store = usePositionTrackerStore();
const projectId = route.params.id;

const project   = ref(null);
const keywords  = ref([]);
const summary   = ref(null);
const series    = ref([]);
const table     = ref([]);
const moversUp  = ref([]);
const moversDown = ref([]);
const runs      = ref([]);

const granularity = ref('day');     // 'day' | 'week' | 'month'
const period      = ref('week');    // 'week' | 'month' (для KPI/movers)
const chartMode   = ref('position');// 'position' | 'top'

const newQuery = ref('');
const adding = ref(false);
const startingRun = ref(false);

let pollTimer = null;

async function loadProject() {
  const data = await store.getProject(projectId);
  if (!data?.project) { router.push('/position-tracker'); return; }
  project.value = data.project;
  keywords.value = data.keywords || [];
}

async function loadAnalytics() {
  if (!project.value) return;
  const [sum, ser, tbl, mu, md, rns] = await Promise.all([
    store.getSummary(projectId, period.value),
    store.getProjectSeries(projectId, granularity.value),
    store.getKeywordsTable(projectId, period.value),
    store.getMovers(projectId, 'up', period.value, null),
    store.getMovers(projectId, 'down', period.value, null),
    store.getRuns(projectId),
  ]);
  summary.value = sum;
  series.value = ser;
  table.value = tbl;
  moversUp.value = mu;
  moversDown.value = md;
  runs.value = rns;
}

const activeRun = computed(() =>
  runs.value.find((r) => r.status === 'queued' || r.status === 'processing') || null,
);
const progressPct = computed(() => {
  const r = activeRun.value;
  if (!r || !r.keywords_total) return 0;
  return Math.min(100, Math.round((r.keywords_done / r.keywords_total) * 100));
});

async function startRun() {
  startingRun.value = true;
  try {
    await store.startRun(projectId);
    setTimeout(loadAnalytics, 1500);
    startPolling();
  } catch (err) {
    alert(err.response?.data?.error || err.message);
  } finally { startingRun.value = false; }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      runs.value = await store.getRuns(projectId);
      if (!activeRun.value) {
        await loadAnalytics();
        stopPolling();
      }
    } catch (_) { /* nop */ }
  }, 3000);
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

async function addKeyword() {
  const q = newQuery.value.trim();
  if (!q) return;
  adding.value = true;
  try {
    // Поддерживаем массовый ввод через перевод строки или ;
    const queries = q.split(/[\n;]/).map((s) => s.trim()).filter(Boolean);
    await store.addKeywords(projectId, queries);
    newQuery.value = '';
    await loadProject();
  } catch (err) {
    alert(err.response?.data?.error || err.message);
  } finally { adding.value = false; }
}

async function removeKeyword(kwId) {
  if (!confirm('Удалить запрос и его историю?')) return;
  try {
    await store.deleteKeyword(projectId, kwId);
    keywords.value = keywords.value.filter((k) => k.id !== kwId);
    await loadAnalytics();
  } catch (e) { alert(e.message); }
}

function changeGran(g) { granularity.value = g; loadAnalytics(); }
function changePeriod(p) { period.value = p; loadAnalytics(); }

function fmtPosition(p) {
  if (p == null) return '—';
  return String(Math.round(p));
}
function fmtDelta(d) {
  if (d == null) return '';
  if (d === 0) return '0';
  const arrow = d < 0 ? '▲' : '▼';
  return `${arrow} ${Math.abs(d)}`;
}
function deltaClass(d) {
  if (d == null) return 'text-gray-400';
  if (d < 0) return 'text-emerald-600 font-medium';
  if (d > 0) return 'text-red-500 font-medium';
  return 'text-gray-400';
}

const periodLabel = computed(() => period.value === 'month' ? 'за месяц' : 'за неделю');
const summaryDelta = computed(() => {
  if (!summary.value || summary.value.avg_position == null || summary.value.avg_position_prev == null) return null;
  return +(summary.value.avg_position - summary.value.avg_position_prev).toFixed(2);
});

onMounted(async () => {
  await loadProject();
  await loadAnalytics();
  if (activeRun.value) startPolling();
});
onBeforeUnmount(stopPolling);
</script>

<template>
  <AppLayout>
    <div class="max-w-7xl mx-auto px-4 py-6">
      <div class="flex items-start justify-between gap-4 mb-6">
        <div class="min-w-0">
          <button class="text-sm text-gray-500 hover:text-gray-700 mb-2"
                  @click="router.push('/position-tracker')">← Все проекты</button>
          <h1 class="text-2xl font-semibold text-gray-900 truncate">
            {{ project?.name || project?.domain || '…' }}
          </h1>
          <div class="text-sm text-gray-500 mt-1">
            {{ project?.domain }} ·
            {{ project?.engine === 'both' ? 'Яндекс + Google' : project?.engine === 'google' ? 'Google' : 'Яндекс' }}
            <span v-if="project?.geo_lr"> · lr={{ project.geo_lr }}</span>
            <span v-if="project?.geo_loc"> · {{ project.geo_loc }}</span>
            · {{ project?.device === 'mobile' ? 'Mobile' : 'Desktop' }}
          </div>
        </div>
        <div class="text-right">
          <button class="btn-primary" :disabled="!!activeRun || startingRun" @click="startRun">
            {{ activeRun ? 'Идёт съём…' : startingRun ? 'Запускаем…' : 'Запустить съём сейчас' }}
          </button>
          <div v-if="activeRun" class="mt-2 text-xs text-gray-500">
            {{ activeRun.keywords_done }}/{{ activeRun.keywords_total }}
            <div class="progress mt-1">
              <div class="progress-bar" :style="{ width: progressPct + '%' }"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- KPI-карточки -->
      <div v-if="summary" class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <div class="kpi">
          <div class="kpi-label">Средняя позиция</div>
          <div class="kpi-value">{{ summary.avg_position == null ? '—' : summary.avg_position }}</div>
          <div v-if="summaryDelta != null" :class="deltaClass(summaryDelta)" class="kpi-delta">
            {{ fmtDelta(summaryDelta) }} {{ periodLabel }}
          </div>
        </div>
        <div class="kpi">
          <div class="kpi-label">ТОП-3</div>
          <div class="kpi-value">{{ summary.top3 }} <span class="kpi-suffix">/ {{ summary.keywords_total }}</span></div>
          <div :class="deltaClass(summary.top3 - summary.top3_prev > 0 ? -1 : (summary.top3 - summary.top3_prev < 0 ? 1 : 0))"
               class="kpi-delta">
            {{ summary.top3 - summary.top3_prev > 0 ? '+' : '' }}{{ summary.top3 - summary.top3_prev }} {{ periodLabel }}
          </div>
        </div>
        <div class="kpi">
          <div class="kpi-label">ТОП-10</div>
          <div class="kpi-value">{{ summary.top10 }} <span class="kpi-suffix">/ {{ summary.keywords_total }}</span></div>
          <div :class="deltaClass(summary.top10 - summary.top10_prev > 0 ? -1 : (summary.top10 - summary.top10_prev < 0 ? 1 : 0))"
               class="kpi-delta">
            {{ summary.top10 - summary.top10_prev > 0 ? '+' : '' }}{{ summary.top10 - summary.top10_prev }} {{ periodLabel }}
          </div>
        </div>
        <div class="kpi">
          <div class="kpi-label">ТОП-30</div>
          <div class="kpi-value">{{ summary.top30 }} <span class="kpi-suffix">/ {{ summary.keywords_total }}</span></div>
          <div :class="deltaClass(summary.top30 - summary.top30_prev > 0 ? -1 : (summary.top30 - summary.top30_prev < 0 ? 1 : 0))"
               class="kpi-delta">
            {{ summary.top30 - summary.top30_prev > 0 ? '+' : '' }}{{ summary.top30 - summary.top30_prev }} {{ periodLabel }}
          </div>
        </div>
        <div class="kpi">
          <div class="kpi-label">Динамика</div>
          <div class="text-sm font-medium space-x-2">
            <span class="text-emerald-600">▲ {{ summary.up }}</span>
            <span class="text-red-500">▼ {{ summary.down }}</span>
            <span class="text-gray-400">= {{ summary.flat }}</span>
          </div>
          <div class="kpi-delta">{{ periodLabel }}</div>
        </div>
      </div>

      <!-- Период (для KPI и movers) -->
      <div class="mb-3 flex items-center gap-2 text-sm">
        <span class="text-gray-500">Период:</span>
        <button :class="['tab', period === 'week' ? 'tab-active' : '']" @click="changePeriod('week')">Неделя</button>
        <button :class="['tab', period === 'month' ? 'tab-active' : '']" @click="changePeriod('month')">Месяц</button>
      </div>

      <!-- График динамики -->
      <div class="card mb-6">
        <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h2 class="text-lg font-medium">Динамика позиций</h2>
          <div class="flex items-center gap-3 text-sm">
            <div class="flex items-center gap-1">
              <span class="text-gray-500">Метрика:</span>
              <button :class="['tab', chartMode === 'position' ? 'tab-active' : '']" @click="chartMode = 'position'">Средняя позиция</button>
              <button :class="['tab', chartMode === 'top' ? 'tab-active' : '']" @click="chartMode = 'top'">Доли ТОП-N</button>
            </div>
            <div class="flex items-center gap-1">
              <span class="text-gray-500">Гранулярность:</span>
              <button :class="['tab', granularity === 'day' ? 'tab-active' : '']" @click="changeGran('day')">День</button>
              <button :class="['tab', granularity === 'week' ? 'tab-active' : '']" @click="changeGran('week')">Неделя</button>
              <button :class="['tab', granularity === 'month' ? 'tab-active' : '']" @click="changeGran('month')">Месяц</button>
            </div>
          </div>
        </div>
        <PositionChart :series="series" :mode="chartMode" />
      </div>

      <!-- Movers -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div class="card">
          <h3 class="text-base font-medium mb-3 text-emerald-600">▲ Выросло {{ periodLabel }}</h3>
          <div v-if="!moversUp.length" class="text-sm text-gray-400">Нет роста за период.</div>
          <ul v-else class="space-y-1.5 text-sm">
            <li v-for="m in moversUp" :key="m.keyword_id" class="flex items-center justify-between gap-3">
              <span class="truncate">{{ m.query }}</span>
              <span class="whitespace-nowrap">
                <span class="text-gray-400">{{ fmtPosition(m.prev) }} →</span>
                <span class="font-medium ml-1">{{ fmtPosition(m.curr) }}</span>
                <span class="ml-2 text-emerald-600 font-medium">{{ fmtDelta(m.delta) }}</span>
              </span>
            </li>
          </ul>
        </div>
        <div class="card">
          <h3 class="text-base font-medium mb-3 text-red-500">▼ Упало {{ periodLabel }}</h3>
          <div v-if="!moversDown.length" class="text-sm text-gray-400">Нет падений за период.</div>
          <ul v-else class="space-y-1.5 text-sm">
            <li v-for="m in moversDown" :key="m.keyword_id" class="flex items-center justify-between gap-3">
              <span class="truncate">{{ m.query }}</span>
              <span class="whitespace-nowrap">
                <span class="text-gray-400">{{ fmtPosition(m.prev) }} →</span>
                <span class="font-medium ml-1">{{ fmtPosition(m.curr) }}</span>
                <span class="ml-2 text-red-500 font-medium">{{ fmtDelta(m.delta) }}</span>
              </span>
            </li>
          </ul>
        </div>
      </div>

      <!-- Запросы -->
      <div class="card">
        <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h2 class="text-lg font-medium">Запросы ({{ keywords.length }})</h2>
        </div>

        <!-- Добавление -->
        <div class="mb-4">
          <textarea v-model="newQuery" rows="3" class="input"
                    placeholder="Добавьте запросы — по одному в строке или через ;"></textarea>
          <div class="mt-2 text-right">
            <button class="btn-primary" :disabled="adding || !newQuery.trim()" @click="addKeyword">
              {{ adding ? 'Добавляем…' : 'Добавить запросы' }}
            </button>
          </div>
        </div>

        <!-- Таблица -->
        <div v-if="!table.length" class="text-sm text-gray-400 py-4">
          Запросов пока нет. Добавьте список выше и запустите первый съём.
        </div>
        <div v-else class="table-wrap">
          <table class="kw-table">
            <thead>
              <tr>
                <th>Запрос</th>
                <th class="text-center">Позиция</th>
                <th class="text-center">Δ</th>
                <th>URL в выдаче</th>
                <th class="text-center">Действия</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="k in table" :key="k.keyword_id">
                <td class="font-medium">{{ k.query }}</td>
                <td class="text-center">{{ fmtPosition(k.position) }}</td>
                <td :class="['text-center', deltaClass(k.delta)]">{{ fmtDelta(k.delta) }}</td>
                <td class="truncate max-w-[280px]">
                  <a v-if="k.found_url" :href="k.found_url" target="_blank" rel="noopener" class="text-indigo-600 hover:underline">
                    {{ k.found_url }}
                  </a>
                  <span v-else class="text-gray-400">не в ТОП-100</span>
                </td>
                <td class="text-center">
                  <button class="text-gray-400 hover:text-red-500" @click="removeKeyword(k.keyword_id)">✕</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </AppLayout>
</template>

<style scoped>
.card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; }
.kpi { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 12px 14px; }
.kpi-label { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.04em; }
.kpi-value { font-size: 22px; font-weight: 600; color: #111827; margin-top: 4px; }
.kpi-suffix { font-size: 13px; color: #9ca3af; font-weight: 400; }
.kpi-delta { font-size: 11px; color: #6b7280; margin-top: 4px; }
.input { width: 100%; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; }
.btn-primary { background: #0071e3; color: #fff; padding: 8px 16px; border-radius: 8px; font-size: 14px; font-weight: 500; }
.btn-primary:hover { background: #0058b8; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.tab { padding: 4px 10px; border-radius: 6px; background: #f3f4f6; color: #374151; font-size: 13px; }
.tab-active { background: #111827; color: #fff; }
.progress { width: 200px; height: 4px; background: #e5e7eb; border-radius: 4px; overflow: hidden; }
.progress-bar { height: 100%; background: #0071e3; transition: width .3s; }
.table-wrap { overflow-x: auto; }
.kw-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.kw-table th { text-align: left; font-weight: 500; color: #6b7280; padding: 8px 10px; border-bottom: 1px solid #e5e7eb; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
.kw-table td { padding: 8px 10px; border-bottom: 1px solid #f3f4f6; vertical-align: middle; }
.kw-table tr:hover { background: #fafafa; }
</style>
