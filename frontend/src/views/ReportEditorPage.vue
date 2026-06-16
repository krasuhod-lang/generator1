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
  try { await store.fetchData(route.params.id); }
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
  });
  dirty.value = false;
  await refreshData();
}

async function generateSummary() {
  summaryStatus.value = { status: 'queued', error: null };
  await store.generateSummary(route.params.id);
  startPolling();
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

async function loadAutolog() {
  if (!route.params.id) return;
  try {
    const items = await store.listProjectTasks(route.params.id, false);
    if (data.value) data.value.tasks = { ...(data.value.tasks || {}), items };
  } catch { /* */ }
}

const sources = computed(() => {
  if (!data.value) return [];
  return [
    { key: 'gsc', label: 'Google Search Console', state: _stateOf(data.value.gsc) },
    { key: 'ywm', label: 'Яндекс.Вебмастер', state: _stateOf(data.value.ywm) },
    { key: 'keys_so', label: 'Keys.so', state: _stateOf(data.value.keys_so) },
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

          <div class="rep-card">
            <h3>Источники данных</h3>
            <ul class="src-list">
              <li v-for="s in sources" :key="s.key">
                <span class="src-label">{{ s.label }}</span>
                <span class="src-state" :data-tag="s.state.tag">{{ s.state.label }}</span>
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
        <main class="rep-main">
          <div v-if="dataLoading" class="rep-loading">Загрузка данных…</div>
          <ReportRenderer v-else-if="data"
            :data="data"
            :summary="{
              executive_summary: draft.llm_summary,
              highlights: draft.llm_highlights,
              growth_attribution: draft.llm_growth,
            }"
            :tasks-blocks="draft.tasks_blocks || []"
            :title="draft.title"
            :period="`${draft.date_from} — ${draft.date_to}`"
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
  </AppLayout>
</template>

<style scoped>
.rep-loading { padding: 60px; text-align: center; color: rgba(0,0,0,0.5); }
.rep-editor { padding: 16px; max-width: 1400px; margin: 0 auto; }
.rep-head { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
.back-btn { background: none; border: none; color: #0071e3; cursor: pointer; font-size: 14px; padding: 0; }
.rep-status-pill { padding: 2px 10px; border-radius: 12px; background: rgba(0,0,0,0.06); font-size: 12px; text-transform: uppercase; }
.rep-status-pill[data-status="published"] { background: rgba(0,150,80,0.12); color: #047b3a; }
.rep-project-info { color: rgba(0,0,0,0.55); font-size: 13px; }
.rep-grid { display: grid; grid-template-columns: 320px 1fr; gap: 16px; }
.rep-side { display: flex; flex-direction: column; gap: 12px; position: sticky; top: 16px; align-self: flex-start; max-height: calc(100vh - 32px); overflow-y: auto; }
.rep-card { background: #fff; padding: 14px; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); display: flex; flex-direction: column; gap: 8px; }
.rep-card h3 { margin: 0 0 4px; font-size: 14px; color: rgba(0,0,0,0.65); text-transform: uppercase; letter-spacing: 0.04em; }
.rep-card label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.rep-card input, .rep-card select { padding: 7px 10px; border: 1px solid rgba(0,0,0,0.12); border-radius: 6px; font-size: 13px; }
.btn { padding: 8px 14px; border-radius: 8px; font-size: 13px; cursor: pointer; border: 1px solid transparent; text-align: center; }
.btn-primary { background: #0071e3; color: #fff; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-secondary { background: #f5f5f7; color: #1d1d1f; }
.src-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
.src-list li { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; }
.src-label { color: rgba(0,0,0,0.7); }
.src-state { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: rgba(0,0,0,0.06); }
.src-state[data-tag="ok"] { background: rgba(0,150,80,0.12); color: #047b3a; }
.src-state[data-tag="err"] { background: rgba(220,40,40,0.12); color: #b00020; }
.src-state[data-tag="off"] { background: rgba(0,0,0,0.06); color: rgba(0,0,0,0.5); }
.src-state[data-tag="empty"] { background: rgba(255,180,0,0.15); color: #876200; }
.src-hint { margin: 0; font-size: 12px; color: rgba(0,0,0,0.55); }
.src-hint.err { color: #b00020; }
.src-err { color: #b00020; font-size: 12px; }
.modal-back { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal { background: #fff; padding: 24px; border-radius: 12px; min-width: 380px; max-width: 480px; display: flex; flex-direction: column; gap: 12px; }
.modal h2 { margin: 0; font-size: 18px; }
.modal label { display: flex; flex-direction: column; gap: 4px; }
.lbl { font-size: 12px; color: rgba(0,0,0,0.55); }
.modal input, .modal select { padding: 8px 10px; border: 1px solid rgba(0,0,0,0.15); border-radius: 6px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }

@media (max-width: 900px) {
  .rep-grid { grid-template-columns: 1fr; }
  .rep-side { position: static; max-height: none; }
}
</style>
