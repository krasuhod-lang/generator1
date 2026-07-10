<script setup>
/**
 * AuditsPage — раздел «Аудиты»: запуск технического и SEO-аудита сайта.
 *
 * Форма запуска (URL + collapsible настройки), список аудитов пользователя,
 * переход на дашборд отчёта /audits/:taskId. Старый «Парсер сайта»
 * (структура URL / дерево / каннибализация) остаётся доступен по ссылке.
 *
 * Бэкенд: /api/audit/* (Node — роутер, краулинг в Python-микросервисе audit/).
 */
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import api from '../api.js';

const router = useRouter();

const form = ref({
  url: '',
  max_pages: 500,
  max_depth: 4,
  check_images: true,
  use_playwright: false,
});
const showSettings = ref(false);
const loading = ref(false);
const error = ref(null);
const tasks = ref([]);
const pollHandle = ref(null);

const _msg = (e) => e?.response?.data?.error || e?.message || 'Ошибка';

const statusLabel = (s) => ({
  pending: 'в очереди', running: 'идёт аудит', done: 'готово',
  failed: 'ошибка', cancelled: 'отменено',
}[s] || s || '—');

function scoreColor(score) {
  if (score == null) return '#6b7280';
  if (score >= 80) return '#16a34a';
  if (score >= 50) return '#d97706';
  return '#dc2626';
}

async function fetchTasks() {
  try {
    const { data } = await api.get('/audit/tasks');
    tasks.value = data.tasks || [];
    // Пока есть running-задачи — поллим статус (обновляет прогресс в БД)
    const running = tasks.value.filter((t) => ['pending', 'running'].includes(t.status));
    for (const t of running) {
      try { await api.get(`/audit/status/${t.id}`); } catch (_) { /* ignore */ }
    }
    if (!running.length) stopPolling();
  } catch (e) { /* тихо: список обновится на следующем тике */ }
}

function startPolling() {
  stopPolling();
  pollHandle.value = setInterval(fetchTasks, 3000);
}
function stopPolling() {
  if (pollHandle.value) { clearInterval(pollHandle.value); pollHandle.value = null; }
}

async function startAudit() {
  error.value = null;
  const url = String(form.value.url || '').trim();
  if (!url) { error.value = 'Укажите URL сайта'; return; }
  loading.value = true;
  try {
    const { data } = await api.post('/audit/start', {
      url,
      max_pages: Number(form.value.max_pages) || 500,
      max_depth: Number(form.value.max_depth) || 4,
      check_images: !!form.value.check_images,
      use_playwright: !!form.value.use_playwright,
    });
    await fetchTasks();
    startPolling();
    router.push(`/audits/${data.task_id}`);
  } catch (e) {
    error.value = _msg(e);
  } finally {
    loading.value = false;
  }
}

async function deleteTask(id) {
  if (!confirm('Удалить аудит и его отчёт?')) return;
  try {
    await api.delete(`/audit/${id}`);
    tasks.value = tasks.value.filter((t) => t.id !== id);
  } catch (e) { error.value = _msg(e); }
}

function progressPct(t) {
  const p = t.progress || {};
  const total = Number(p.total_found) || 0;
  const crawled = Number(p.crawled) || 0;
  if (!total) return 0;
  return Math.min(100, Math.round((crawled / total) * 100));
}

onMounted(async () => {
  await fetchTasks();
  if (tasks.value.some((t) => ['pending', 'running'].includes(t.status))) startPolling();
});
onUnmounted(stopPolling);
</script>

<template>
  <AppLayout>
    <div class="audits-page">
      <div class="page-head">
        <div>
          <h1>Аудиты</h1>
          <p class="hint">Технический и SEO-аудит сайта: краулинг, 23 типа ошибок,
            Health Score, дубликаты, страницы-сироты, битые изображения.</p>
        </div>
        <router-link class="link-secondary" to="/site-crawler">🕷️ Парсер структуры сайта →</router-link>
      </div>

      <section class="card">
        <h2>Запустить аудит</h2>
        <div class="start-row">
          <input v-model="form.url" class="url-input" placeholder="https://example.com"
                 @keydown.enter="startAudit" />
          <button class="primary" :disabled="loading" @click="startAudit">
            {{ loading ? 'Запускаем…' : 'Запустить аудит' }}
          </button>
          <button class="ghost" @click="showSettings = !showSettings">
            ⚙️ Настройки {{ showSettings ? '▴' : '▾' }}
          </button>
        </div>
        <div v-if="showSettings" class="settings-grid">
          <label>Макс. страниц
            <input type="number" min="1" max="5000" v-model.number="form.max_pages" />
          </label>
          <label>Макс. глубина
            <input type="number" min="0" max="10" v-model.number="form.max_depth" />
          </label>
          <label class="checkbox">
            <input type="checkbox" v-model="form.check_images" /> Проверять изображения (HEAD)
          </label>
          <label class="checkbox" title="Всегда рендерить страницы в headless-браузере (медленнее; для SPA)">
            <input type="checkbox" v-model="form.use_playwright" /> Всегда headless (SPA)
          </label>
        </div>
        <div v-if="error" class="error">{{ error }}</div>
      </section>

      <section class="card">
        <h2>Мои аудиты</h2>
        <table class="tbl">
          <thead>
            <tr><th>URL</th><th>Статус</th><th>Прогресс</th><th>Health Score</th>
              <th>Ошибки</th><th>Создан</th><th class="actions-col"></th></tr>
          </thead>
          <tbody>
            <tr v-for="t in tasks" :key="t.id">
              <td class="ellipsis">
                <router-link :to="`/audits/${t.id}`">{{ t.url }}</router-link>
              </td>
              <td><span :class="'badge badge-' + t.status">{{ statusLabel(t.status) }}</span></td>
              <td class="progress-cell">
                <template v-if="['pending','running'].includes(t.status)">
                  <div class="pbar"><div class="pbar-fill" :style="{ width: progressPct(t) + '%' }"></div></div>
                  <span class="muted small-meta">{{ (t.progress && t.progress.crawled) || 0 }} /
                    {{ (t.progress && t.progress.total_found) || '?' }}</span>
                </template>
                <template v-else>{{ (t.summary && t.summary.total_pages) || '—' }} стр.</template>
              </td>
              <td>
                <span v-if="t.status === 'done' && t.summary" class="score-pill"
                      :style="{ background: scoreColor(t.summary.health_score) }">
                  {{ t.summary.health_score }}
                </span>
                <span v-else class="muted">—</span>
              </td>
              <td>
                <template v-if="t.status === 'done' && t.summary">
                  <span class="sev sev-critical" title="Critical">{{ t.summary.issues_critical }}</span>
                  <span class="sev sev-high" title="High">{{ t.summary.issues_high }}</span>
                  <span class="sev sev-medium" title="Medium">{{ t.summary.issues_medium }}</span>
                  <span class="sev sev-low" title="Low">{{ t.summary.issues_low }}</span>
                </template>
                <span v-else class="muted">—</span>
              </td>
              <td>{{ new Date(t.created_at).toLocaleString() }}</td>
              <td class="actions-col">
                <div class="row-actions">
                  <router-link class="btn-open" :to="`/audits/${t.id}`">Открыть</router-link>
                  <button class="danger small" @click="deleteTask(t.id)" title="Удалить">×</button>
                </div>
              </td>
            </tr>
            <tr v-if="!tasks.length"><td colspan="7" class="muted">Аудитов пока нет — запустите первый.</td></tr>
          </tbody>
        </table>
      </section>
    </div>
  </AppLayout>
</template>

<style scoped>
.audits-page { padding: 1.25rem; max-width: 1400px; margin: 0 auto; color: #1f2937; }
.audits-page h1 { color: #111827; margin-bottom: .5rem; }
.audits-page h2 { color: #111827; font-size: 1.05rem; margin: 0 0 .6rem; }
.page-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; }
.hint  { color: #374151; margin-bottom: 1rem; }
.link-secondary { color: #1d4ed8; text-decoration: none; font-size: .9rem; white-space: nowrap; margin-top: .4rem; }
.link-secondary:hover { text-decoration: underline; }
.card  { background: #fff; border-radius: 8px; padding: 1rem; margin-bottom: 1rem;
         box-shadow: 0 1px 3px rgba(0,0,0,.06); border: 1px solid #e5e7eb; }
.start-row { display: flex; gap: .5rem; flex-wrap: wrap; }
.url-input { flex: 1; min-width: 260px; padding: .55rem .7rem; border: 1px solid #cbd5e1;
             border-radius: 6px; color: #111827; background: #fff; font-size: .95rem; }
.settings-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
                 gap: .75rem; margin-top: .75rem; padding-top: .75rem; border-top: 1px dashed #e5e7eb; }
.settings-grid label { display: flex; flex-direction: column; font-size: .85rem; color: #374151; gap: .25rem; }
.settings-grid input[type="number"] { padding: .4rem; border: 1px solid #cbd5e1; border-radius: 4px; }
.checkbox { flex-direction: row !important; align-items: center; gap: .35rem; }
button { padding: .5rem .9rem; border: 1px solid #cbd5e1; background: #f3f4f6; color: #111827;
         border-radius: 6px; cursor: pointer; }
button:hover:not(:disabled) { background: #e5e7eb; }
button.primary { background: #2b7cff; color: #fff; border-color: #2b7cff; }
button.primary:hover:not(:disabled) { background: #1f6ae0; }
button.ghost   { background: #fff; }
button.danger  { background: #fff; color: #c33; border-color: #c33; }
button.small   { padding: .15rem .4rem; font-size: .8rem; }
.btn-open { padding: .2rem .55rem; border: 1px solid #2b7cff; color: #2b7cff; border-radius: 4px;
            text-decoration: none; font-size: .8rem; }
.btn-open:hover { background: #eef5ff; }
.error { color: #b91c1c; margin-top: .5rem; }
.muted { color: #6b7280; }
.small-meta { font-size: .8rem; }
.tbl { width: 100%; border-collapse: separate; border-spacing: 0; margin-top: .5rem;
       background: #fff; border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden; }
.tbl th, .tbl td { padding: .55rem .7rem; font-size: .88rem; text-align: left; vertical-align: middle;
                   color: #111827; border-bottom: 1px solid #eef2f7; }
.tbl th { background: #f8fafc; color: #1e293b; font-weight: 600; font-size: .8rem;
          text-transform: uppercase; letter-spacing: .02em; }
.tbl tbody tr:hover td { background: #eef5ff; }
.tbl td a { color: #1d4ed8; text-decoration: none; }
.tbl td a:hover { text-decoration: underline; }
.ellipsis { max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.actions-col { width: 1%; white-space: nowrap; }
.row-actions { display: flex; gap: .35rem; align-items: center; }
.badge { display: inline-block; padding: .1rem .5rem; border-radius: 10px; font-size: .75rem; font-weight: 600; }
.badge-running { background: #cfe2ff; color: #084298; }
.badge-pending { background: #e2e3e5; color: #41464b; }
.badge-done    { background: #d4edda; color: #155724; }
.badge-failed  { background: #f8d7da; color: #721c24; }
.badge-cancelled { background: #e2e3e5; color: #41464b; }
.pbar { width: 120px; height: 8px; background: #e5e7eb; border-radius: 4px; overflow: hidden;
        display: inline-block; vertical-align: middle; margin-right: .4rem; }
.pbar-fill { height: 100%; background: #2b7cff; transition: width .4s ease; }
.score-pill { display: inline-block; color: #fff; font-weight: 700; padding: .15rem .6rem;
              border-radius: 12px; font-size: .85rem; }
.sev { display: inline-block; min-width: 1.6rem; text-align: center; font-size: .75rem; font-weight: 700;
       border-radius: 8px; padding: .05rem .3rem; margin-right: .2rem; }
.sev-critical { background: #fecaca; color: #7f1d1d; }
.sev-high     { background: #fed7aa; color: #7c2d12; }
.sev-medium   { background: #fef08a; color: #713f12; }
.sev-low      { background: #e5e7eb; color: #374151; }
</style>
