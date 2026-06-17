<script setup>
/**
 * ReportNewPage — мастер «Создать отчёт»: выбираем проект, период, заголовок.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import { useReportsStore } from '../stores/reports.js';
import { useProjectsStore } from '../stores/projects.js';

const router = useRouter();
const route = useRoute();
const reports = useReportsStore();
const projects = useProjectsStore();

const projectId = ref('');
const title = ref('');
const dateFrom = ref('');
const dateTo = ref('');
const error = ref(null);

function _firstDayOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function _lastDayOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}
function _ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

onMounted(async () => {
  if (!projects.projects.length) await projects.fetchProjects();
  if (route.query.projectId) projectId.value = String(route.query.projectId);
  // По умолчанию — прошлый полный месяц.
  const now = new Date();
  const prevMonthLast = new Date(now.getFullYear(), now.getMonth(), 0);
  dateFrom.value = _ymd(_firstDayOfMonth(prevMonthLast));
  dateTo.value = _ymd(_lastDayOfMonth(prevMonthLast));
});

const selectedProject = computed(() => projects.projects.find((p) => p.id === projectId.value) || null);

watch([selectedProject, dateFrom], () => {
  if (selectedProject.value && !title.value.trim()) {
    const months = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
      'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
    const d = dateFrom.value ? new Date(dateFrom.value) : new Date();
    title.value = `Отчёт ${selectedProject.value.name} · ${months[d.getMonth()]} ${d.getFullYear()}`;
  }
});

async function submit() {
  error.value = null;
  if (!projectId.value || !title.value.trim() || !dateFrom.value || !dateTo.value) {
    error.value = 'Заполните все поля.';
    return;
  }
  if (dateFrom.value > dateTo.value) {
    error.value = 'Начальная дата не может быть позже конечной.';
    return;
  }
  try {
    const draft = await reports.createDraft({
      project_id: projectId.value,
      title: title.value.trim(),
      date_from: dateFrom.value,
      date_to: dateTo.value,
    });
    if (draft?.id) router.push(`/reports/${draft.id}/edit`);
    else error.value = 'Не удалось создать отчёт.';
  } catch (e) {
    error.value = e.response?.data?.error || e.message || 'Ошибка';
  }
}
</script>

<template>
  <AppLayout>
    <div class="rnp">
      <header class="rnp-head">
        <button class="back-btn" @click="router.push('/reports')">← Назад к списку</button>
        <h1>Новый отчёт</h1>
      </header>

      <form class="rnp-form" @submit.prevent="submit">
        <label>
          <span class="lbl">Проект</span>
          <select v-model="projectId" required>
            <option value="" disabled>— выберите проект —</option>
            <option v-for="p in projects.projects" :key="p.id" :value="p.id">
              {{ p.name }} ({{ p.url }})
            </option>
          </select>
        </label>

        <label>
          <span class="lbl">Заголовок отчёта</span>
          <input v-model="title" type="text" required maxlength="500" placeholder="Отчёт для ИК · Июнь 2026" />
        </label>

        <div class="row">
          <label>
            <span class="lbl">Период с</span>
            <input v-model="dateFrom" type="date" required />
          </label>
          <label>
            <span class="lbl">По</span>
            <input v-model="dateTo" type="date" required />
          </label>
        </div>

        <div v-if="error" class="rnp-error">{{ error }}</div>

        <div class="rnp-actions">
          <button type="button" class="btn btn-secondary" @click="router.push('/reports')">Отмена</button>
          <button type="submit" class="btn btn-primary" :disabled="reports.saving">
            {{ reports.saving ? 'Создание…' : 'Создать и открыть' }}
          </button>
        </div>
      </form>
    </div>
  </AppLayout>
</template>

<style scoped>
.rnp {
  max-width: 640px; margin: -8px auto 0; padding: 28px;
  background: #f5f5f7; color: #1d1d1f; color-scheme: light;
  border-radius: 22px;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", "Segoe UI", Roboto, Inter, Arial, sans-serif;
  -webkit-font-smoothing: antialiased; letter-spacing: -0.01em;
}
.rnp-head { margin-bottom: 24px; }
.rnp-head h1 { margin: 10px 0 0; font-size: 28px; font-weight: 700; letter-spacing: -0.03em; color: #1d1d1f; }
.back-btn { background: none; border: none; color: #0a84ff; cursor: pointer; font-size: 14px; padding: 0; font-weight: 500; }
.back-btn:hover { color: #0071e3; }
.rnp-form {
  display: flex; flex-direction: column; gap: 18px;
  background: #fff; padding: 28px; border-radius: 18px;
  border: 1px solid rgba(60,60,67,0.10);
  box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.04);
}
.rnp-form label { display: flex; flex-direction: column; gap: 6px; color: #424245; }
.lbl { font-size: 12px; color: #6e6e73; font-weight: 500; }
.rnp-form input, .rnp-form select {
  padding: 11px 13px; border: 1px solid rgba(60,60,67,0.18); border-radius: 10px;
  font-size: 14px; background: #fff; color: #1d1d1f;
}
.rnp-form input:focus, .rnp-form select:focus { outline: none; border-color: #0a84ff; box-shadow: 0 0 0 3px rgba(10,132,255,0.15); }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.rnp-error { color: #d70015; font-size: 13px; padding: 10px 14px; background: rgba(255,59,48,0.08); border-radius: 10px; }
.rnp-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.btn { padding: 10px 18px; border-radius: 10px; font-size: 14px; cursor: pointer; border: 1px solid transparent; font-weight: 500; transition: background 0.15s, transform 0.05s; }
.btn:active { transform: scale(0.98); }
.btn-primary { background: #0a84ff; color: #fff; }
.btn-primary:hover { background: #0071e3; }
.btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }
.btn-secondary { background: rgba(60,60,67,0.06); color: #1d1d1f; border-color: transparent; }
.btn-secondary:hover { background: rgba(60,60,67,0.10); }
</style>
