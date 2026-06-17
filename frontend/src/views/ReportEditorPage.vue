<script setup>
/**
 * ReportEditorPage — редактор черновика отчёта.
 *
 * Левая панель: статус источников, кнопки «Обновить данные» / «AI-резюме»,
 *               редактирование заголовка и периода, публикация.
 * Правая панель: live-preview (ReportRenderer, не readonly).
 */
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import ReportRenderer from '../components/reports/ReportRenderer.vue';
import { useReportsStore } from '../stores/reports.js';
import { collectReportChartImages, downloadBlob } from '../utils/reportExport.js';

const route = useRoute();
const router = useRouter();
const store = useReportsStore();

const draft = computed(() => store.current);
const data = computed(() => store.currentData);

const dataLoading = ref(false);
const dataError = ref(null);
const summaryStatus = ref(null); // {status, error}
const publishOpen = ref(false);
const published = ref(null); // {public_url, mode, expires_at, ...}
const publishForm = ref({ mode: 'snapshot', password: '', expires_in_days: '' });
const publishError = ref(null);
const previewRef = ref(null);
const viewRange = ref({ from: '', to: '', granularity: 'month' });
const exporting = ref(false);

let pollTimer = null;

onMounted(async () => {
  await load();
});
onBeforeUnmount(() => stopPolling());

async function load() {
  await store.fetchDraft(route.params.id);
  await refreshData();
  if (draft.value?.llm_status === 'running' || draft.value?.llm_status === 'queued') {
    startPolling();
  } else {
    summaryStatus.value = draft.value
      ? { status: draft.value.llm_status || 'idle', error: draft.value.llm_error || null }
      : null;
  }
}

async function refreshData() {
  if (!route.params.id) return;
  dataLoading.value = true; dataError.value = null;
  try { await store.fetchData(route.params.id, viewRange.value); }
  catch (err) {
    dataError.value = err.response?.data?.error || err.message || 'Ошибка загрузки данных';
  } finally { dataLoading.value = false; }
}

const titleEdit = ref('');
const dateFromEdit = ref('');
const dateToEdit = ref('');
const dirty = ref(false);
let initial = false;

watch(draft, (d) => {
  if (!d) return;
  titleEdit.value = d.title;
  dateFromEdit.value = d.date_from;
  dateToEdit.value = d.date_to;
  viewRange.value = { from: d.date_from, to: d.date_to, granularity: d.config?.granularity || 'month' };
  initial = true;
  // mark not dirty
  setTimeout(() => { dirty.value = false; }, 0);
});

watch([titleEdit, dateFromEdit, dateToEdit], () => {
  if (initial) dirty.value = true;
});

async function saveMeta() {
  await store.updateDraft(route.params.id, {
    title: titleEdit.value,
    date_from: dateFromEdit.value,
    date_to: dateToEdit.value,
    config: { ...(draft.value?.config || {}), granularity: viewRange.value.granularity },
  });
  dirty.value = false;
  await refreshData();
}

async function generateSummary() {
  summaryStatus.value = { status: 'queued', error: null };
  try {
    await store.generateSummary(route.params.id, viewRange.value);
    startPolling();
  } catch (err) {
    summaryStatus.value = {
      status: 'error',
      error: err.response?.data?.error || err.message || 'Ошибка генерации',
    };
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    const s = await store.getSummaryStatus(route.params.id);
    summaryStatus.value = { status: s.status, error: s.error };
    if (s.status === 'done' || s.status === 'error') {
      stopPolling();
      await store.fetchDraft(route.params.id);
    }
  }, 2000);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function onTasksBlocksUpdate(next) {
  // Локальный апдейт + persist в БД.
  if (store.current) store.current.tasks_blocks = next;
  await store.updateTasksBlocks(route.params.id, next);
}

async function publish() {
  publishError.value = null;
  try {
    const payload = {
      mode: publishForm.value.mode,
      password: publishForm.value.password || undefined,
      expires_in_days: publishForm.value.expires_in_days || undefined,
    };
    const result = await store.publishDraft(route.params.id, payload);
    published.value = result;
    publishOpen.value = false;
    await store.fetchDraft(route.params.id);
  } catch (err) {
    publishError.value = err.response?.data?.error || err.message || 'Ошибка публикации';
  }
}

async function exportDocx() {
  if (!route.params.id || !previewRef.value) return;
  exporting.value = true;
  try {
    const chartImages = await collectReportChartImages(previewRef.value);
    const blob = await store.exportDocx(route.params.id, {
      ...viewRange.value,
      chart_images: chartImages,
    });
    downloadBlob(blob, `${(draft.value?.title || 'report').replace(/[^\wа-яё-]+/gi, '_')}.docx`);
  } finally {
    exporting.value = false;
  }
}

async function loadAutolog() {
  if (!route.params.id) return;
  try {
    const items = await store.listProjectTasks(route.params.id, false);
    if (data.value) data.value.tasks = { ...(data.value.tasks || {}), items };
  } catch { /* */ }
}

const sources = computed(() => {
  if (!data.value) return [];
  const projId = draft.value?.project_id || route.params.projectId || '';
  return [
    { key: 'gsc', label: 'Google Search Console', state: _stateOf(data.value.gsc), connect: projId ? `/projects/${projId}` : null },
    { key: 'ywm', label: 'Яндекс.Вебмастер', state: _stateOf(data.value.ywm), connect: projId ? `/projects/${projId}` : null },
    { key: 'keys_so', label: 'Keys.so', state: _stateOf(data.value.keys_so), connect: projId ? `/projects/${projId}` : null },
  ];
});

function _stateOf(section) {
  if (!section || section.connected === false) return { tag: 'off', label: 'Не подключен' };
  if (section.error) return { tag: 'err', label: 'Ошибка: ' + section.error };
  if (!section.series?.length) return { tag: 'empty', label: 'Нет данных' };
  return { tag: 'ok', label: `${section.series.length} мес.` };
}
</script>

<template>
  <AppLayout>
    <div class="rep-stage">
    <div v-if="store.loading && !draft" class="rep-loading">Загрузка…</div>
    <div v-else-if="!draft" class="rep-loading">Отчёт не найден.</div>
    <div v-else class="rep-editor">
      <header class="rep-head">
        <button class="back-btn" @click="router.push('/reports')">← К списку</button>
        <div class="rep-status-line">
          <span class="rep-status-pill" :data-status="draft.status">{{ draft.status }}</span>
          <span class="rep-project-info">{{ draft.project_name }}</span>
        </div>
      </header>

      <div class="rep-grid">
        <!-- LEFT PANEL -->
        <aside class="rep-side">
          <div class="rep-card">
            <h3>Параметры</h3>
            <label>Заголовок<input v-model="titleEdit" /></label>
            <label>С<input type="date" v-model="dateFromEdit" /></label>
            <label>По<input type="date" v-model="dateToEdit" /></label>
            <button class="btn btn-primary" :disabled="!dirty || store.saving" @click="saveMeta">
              {{ store.saving ? 'Сохранение…' : 'Сохранить' }}
            </button>
          </div>

          <div class="rep-card sticky-card">
            <h3>Интерактивный диапазон</h3>
            <label>С<input type="date" v-model="viewRange.from" /></label>
            <label>По<input type="date" v-model="viewRange.to" /></label>
            <div class="seg">
              <button class="seg-btn" :class="{ active: viewRange.granularity === 'day' }" @click="viewRange.granularity = 'day'">Дни</button>
              <button class="seg-btn" :class="{ active: viewRange.granularity === 'week' }" @click="viewRange.granularity = 'week'">Недели</button>
              <button class="seg-btn" :class="{ active: viewRange.granularity === 'month' }" @click="viewRange.granularity = 'month'">Месяцы</button>
            </div>
            <button class="btn btn-secondary" :disabled="dataLoading" @click="refreshData">
              {{ dataLoading ? 'Обновление…' : 'Применить диапазон' }}
            </button>
            <button class="btn btn-secondary" :disabled="exporting" @click="exportDocx">
              {{ exporting ? 'Экспорт…' : 'Скачать .docx' }}
            </button>
          </div>

          <div class="rep-card">
            <h3>Источники данных</h3>
            <ul class="src-list">
              <li v-for="s in sources" :key="s.key">
                <span class="src-label">{{ s.label }}</span>
                <span class="src-row-right">
                  <a v-if="s.state.tag === 'off' && s.connect" :href="s.connect" class="src-connect">Подключить →</a>
                  <span class="src-state" :data-tag="s.state.tag">{{ s.state.label }}</span>
                </span>
              </li>
            </ul>
            <button class="btn btn-secondary" :disabled="dataLoading" @click="refreshData">
              {{ dataLoading ? 'Обновление…' : 'Обновить данные' }}
            </button>
            <button class="btn btn-secondary" @click="loadAutolog">Подтянуть работы</button>
            <div v-if="dataError" class="src-err">{{ dataError }}</div>
          </div>

          <div class="rep-card">
            <h3>AI-резюме</h3>
            <p class="src-hint" v-if="summaryStatus?.status === 'done'">
              ✓ Готово {{ draft.llm_generated_at ? new Date(draft.llm_generated_at).toLocaleString('ru-RU') : '' }}
            </p>
            <p class="src-hint" v-else-if="summaryStatus?.status === 'running' || summaryStatus?.status === 'queued'">
              ⏳ Генерация…
            </p>
            <p class="src-hint err" v-else-if="summaryStatus?.status === 'error'">
              Ошибка: {{ summaryStatus.error }}
            </p>
            <button class="btn btn-primary"
                    :disabled="summaryStatus?.status === 'running' || summaryStatus?.status === 'queued'"
                    @click="generateSummary">
              Сгенерировать
            </button>
          </div>

          <div class="rep-card">
            <h3>Публикация</h3>
            <button class="btn btn-primary" @click="publishOpen = true">Опубликовать</button>
            <p v-if="published?.public_url" class="src-hint">
              <a :href="published.public_url" target="_blank">{{ published.public_url }}</a>
            </p>
          </div>
        </aside>

        <!-- RIGHT: PREVIEW -->
        <main ref="previewRef" class="rep-main">
          <div v-if="dataLoading" class="rep-loading">Загрузка данных…</div>
          <ReportRenderer v-else-if="data"
            :data="data"
            :summary="{
              executive_summary: draft.llm_summary,
              highlights: draft.llm_highlights,
              growth_attribution: draft.llm_growth,
              quick_wins: draft.llm_quick_wins,
              vulnerabilities: draft.llm_vulnerabilities,
              roadmap: draft.llm_roadmap,
              traffic_value: draft.llm_traffic_value,
            }"
            :tasks-blocks="draft.tasks_blocks || []"
            :title="draft.title"
            :period="`${viewRange.from} — ${viewRange.to}`"
            :project="{
              name: draft.project_name,
              url: draft.project_url,
              logo_url: draft.logo_url,
              color_accent: draft.color_accent,
            }"
            mode="live"
            :readonly="false"
            @update:tasksBlocks="onTasksBlocksUpdate" />
        </main>
      </div>

      <!-- PUBLISH MODAL -->
      <div v-if="publishOpen" class="modal-back" @click.self="publishOpen = false">
        <div class="modal">
          <h2>Опубликовать отчёт</h2>
          <label>
            <span class="lbl">Режим</span>
            <select v-model="publishForm.mode">
              <option value="snapshot">Snapshot — данные заморожены</option>
              <option value="live">Live — обновляются при открытии</option>
            </select>
          </label>
          <label>
            <span class="lbl">PIN-код (4–8 цифр, опционально)</span>
            <input v-model="publishForm.password" type="text" maxlength="8" inputmode="numeric" pattern="\d*" />
          </label>
          <label>
            <span class="lbl">Срок действия, дней (пусто = бессрочно)</span>
            <input v-model="publishForm.expires_in_days" type="number" min="1" max="365" />
          </label>
          <div v-if="publishError" class="src-err">{{ publishError }}</div>
          <div class="modal-actions">
            <button class="btn btn-secondary" @click="publishOpen = false">Отмена</button>
            <button class="btn btn-primary" @click="publish">Опубликовать</button>
          </div>
        </div>
      </div>
    </div>
    </div>
  </AppLayout>
</template>

<style scoped>
/* Apple-style stage: фиксированный светлый фон поверх AppLayout, чтобы
 * не было «тёмные буквы на тёмном фоне» в любой системной теме. */
.rep-stage {
  background: #f5f5f7;
  color-scheme: light;
  color: #1d1d1f;
  border-radius: 22px;
  padding: 20px;
  margin: -8px -8px 0;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", "Segoe UI", Roboto, Inter, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  letter-spacing: -0.01em;
}
.rep-loading { padding: 60px; text-align: center; color: #6e6e73; }
.rep-editor { max-width: 1400px; margin: 0 auto; }
.rep-head { display: flex; align-items: center; gap: 16px; margin-bottom: 18px; flex-wrap: wrap; }
.back-btn { background: none; border: none; color: #0071e3; cursor: pointer; font-size: 14px; padding: 0; font-weight: 500; }
.back-btn:hover { color: #0a84ff; }
.rep-status-line { display: flex; align-items: center; gap: 10px; }
.rep-status-pill {
  padding: 4px 12px; border-radius: 999px; background: rgba(60,60,67,0.08);
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600;
  color: #424245;
}
.rep-status-pill[data-status="published"] { background: rgba(48,209,88,0.15); color: #03762d; }
.rep-project-info { color: #6e6e73; font-size: 13px; }
.rep-grid { display: grid; grid-template-columns: 320px 1fr; gap: 18px; }
.rep-side { display: flex; flex-direction: column; gap: 14px; position: sticky; top: 16px; align-self: flex-start; max-height: calc(100vh - 32px); overflow-y: auto; }
.rep-card {
  background: #fff; padding: 18px; border-radius: 16px;
  border: 1px solid rgba(60,60,67,0.12);
  box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 6px 18px rgba(0,0,0,0.04);
  display: flex; flex-direction: column; gap: 10px;
}
.rep-card h3 { margin: 0 0 6px; font-size: 12px; color: #6e6e73; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; }
.rep-card label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: #424245; }
.rep-card input, .rep-card select {
  padding: 9px 12px; border: 1px solid rgba(60,60,67,0.18); border-radius: 10px;
  font-size: 13px; background: #fff; color: #1d1d1f;
}
.rep-card input:focus, .rep-card select:focus { outline: none; border-color: #0a84ff; box-shadow: 0 0 0 3px rgba(10,132,255,0.15); }
.sticky-card { position: sticky; top: 0; z-index: 1; }
.seg { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.seg-btn {
  border: 1px solid rgba(60,60,67,0.14);
  background: #fff;
  color: #424245;
  border-radius: 10px;
  padding: 8px 10px;
  cursor: pointer;
  font-size: 12px;
}
.seg-btn.active { background: rgba(10,132,255,0.08); color: #0a84ff; border-color: rgba(10,132,255,0.24); }
.btn { padding: 9px 16px; border-radius: 10px; font-size: 13px; cursor: pointer; border: 1px solid transparent; text-align: center; font-weight: 500; transition: background 0.15s, transform 0.05s; }
.btn:active { transform: scale(0.98); }
.btn-primary { background: #0a84ff; color: #fff; }
.btn-primary:hover { background: #0071e3; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-secondary { background: rgba(60,60,67,0.06); color: #1d1d1f; }
.btn-secondary:hover { background: rgba(60,60,67,0.10); }
.src-row-right { display: inline-flex; align-items: center; gap: 8px; }
.src-connect { color: #0a84ff; font-size: 12px; font-weight: 500; text-decoration: none; }
.src-connect:hover { color: #0071e3; text-decoration: underline; }
.src-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
.src-list li { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; align-items: center; }
.src-label { color: #424245; font-weight: 500; }
.src-state { font-size: 11px; padding: 3px 9px; border-radius: 999px; background: rgba(60,60,67,0.08); color: #424245; font-weight: 500; }
.src-state[data-tag="ok"] { background: rgba(48,209,88,0.15); color: #03762d; }
.src-state[data-tag="err"] { background: rgba(255,59,48,0.12); color: #d70015; }
.src-state[data-tag="off"] { background: rgba(60,60,67,0.08); color: #6e6e73; }
.src-state[data-tag="empty"] { background: rgba(255,159,10,0.18); color: #8e5500; }
.src-hint { margin: 0; font-size: 12px; color: #6e6e73; }
.src-hint.err { color: #d70015; }
.src-hint a { color: #0a84ff; }
.src-err { color: #d70015; font-size: 12px; }
.modal-back { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 1000; backdrop-filter: blur(8px); }
.modal {
  background: #fff; padding: 28px; border-radius: 18px;
  min-width: 380px; max-width: 480px; display: flex; flex-direction: column; gap: 14px;
  color: #1d1d1f;
  box-shadow: 0 8px 30px rgba(0,0,0,0.18);
}
.modal h2 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.02em; }
.modal label { display: flex; flex-direction: column; gap: 6px; }
.lbl { font-size: 12px; color: #6e6e73; font-weight: 500; }
.modal input, .modal select {
  padding: 10px 12px; border: 1px solid rgba(60,60,67,0.18); border-radius: 10px;
  background: #fff; color: #1d1d1f; font-size: 14px;
}
.modal input:focus, .modal select:focus { outline: none; border-color: #0a84ff; box-shadow: 0 0 0 3px rgba(10,132,255,0.15); }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }

@media (max-width: 900px) {
  .rep-grid { grid-template-columns: 1fr; }
  .rep-side { position: static; max-height: none; }
  .rep-stage { border-radius: 14px; padding: 14px; margin: 0; }
}
</style>
