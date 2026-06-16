<script setup>
/**
 * PositionTrackerPage — список проектов отслеживания позиций.
 *
 * UI: список карточек проектов + форма создания нового проекта (имя/домен/
 * движок/гео/устройство/расписание). По клику на проект — переход в
 * /position-tracker/:id.
 */
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import { usePositionTrackerStore } from '../stores/positionTracker.js';
import { YANDEX_REGIONS } from '../data/yandex-regions.js';

const router = useRouter();
const store = usePositionTrackerStore();

const form = ref({
  name: '',
  domain: '',
  engine: 'yandex',
  geo_lr: '213',
  geo_loc: '',
  device: 'desktop',
  schedule: 'manual',
});
const submitting = ref(false);
const formError = ref(null);
const showForm = ref(false);

onMounted(() => store.fetchProjects());

async function submit() {
  formError.value = null;
  if (!form.value.domain.trim()) {
    formError.value = 'Укажите домен';
    return;
  }
  submitting.value = true;
  try {
    const project = await store.createProject({ ...form.value });
    if (project?.id) {
      router.push(`/position-tracker/${project.id}`);
    }
  } catch (err) {
    formError.value = err.response?.data?.error || err.message || 'Ошибка создания';
  } finally {
    submitting.value = false;
  }
}

async function removeProject(id) {
  if (!confirm('Удалить проект и всю историю позиций?')) return;
  try { await store.deleteProject(id); } catch (e) { alert(e.message); }
}

function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }); }
  catch (_) { return String(d); }
}
</script>

<template>
  <AppLayout>
    <div class="tracker-stage">
    <div class="max-w-6xl mx-auto px-4 py-6">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="page-title">Съём позиций</h1>
          <p class="page-sub mt-1">
            Регулярное снятие позиций сайта в Яндексе и Google через XMLStock — с гео, графиками динамики и анализом «выросло/упало».
          </p>
        </div>
        <button class="btn-primary" @click="showForm = !showForm">
          {{ showForm ? 'Закрыть' : '+ Новый проект' }}
        </button>
      </div>

      <!-- Форма создания -->
      <div v-if="showForm" class="card mb-6">
        <h2 class="text-lg font-medium mb-4">Создать проект отслеживания</h2>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label class="block">
            <span class="text-sm text-gray-700">Название</span>
            <input v-model="form.name" type="text" class="input" placeholder="Мой интернет-магазин" />
          </label>
          <label class="block">
            <span class="text-sm text-gray-700">Домен <span class="text-red-500">*</span></span>
            <input v-model="form.domain" type="text" class="input" placeholder="example.com" />
          </label>
          <label class="block">
            <span class="text-sm text-gray-700">Поисковик</span>
            <select v-model="form.engine" class="input">
              <option value="yandex">Яндекс</option>
              <option value="google">Google</option>
              <option value="both">Яндекс и Google</option>
            </select>
          </label>
          <label class="block">
            <span class="text-sm text-gray-700">Регион Яндекса (lr)</span>
            <select v-model="form.geo_lr" class="input">
              <option v-for="r in YANDEX_REGIONS" :key="r.value" :value="r.value">{{ r.label }}</option>
            </select>
          </label>
          <label class="block">
            <span class="text-sm text-gray-700">Гео для Google (loc)</span>
            <input v-model="form.geo_loc" type="text" class="input" placeholder="Moscow,Moscow,Russia" />
          </label>
          <label class="block">
            <span class="text-sm text-gray-700">Устройство</span>
            <select v-model="form.device" class="input">
              <option value="desktop">Десктоп</option>
              <option value="mobile">Мобильные</option>
            </select>
          </label>
          <label class="block">
            <span class="text-sm text-gray-700">Расписание авто-съёма</span>
            <select v-model="form.schedule" class="input">
              <option value="manual">Только вручную</option>
              <option value="daily">Ежедневно</option>
              <option value="weekly">Еженедельно</option>
            </select>
          </label>
        </div>
        <div v-if="formError" class="mt-3 text-sm text-red-600">{{ formError }}</div>
        <div class="mt-4 flex gap-2">
          <button class="btn-primary" :disabled="submitting" @click="submit">
            {{ submitting ? 'Создаём…' : 'Создать проект' }}
          </button>
          <button class="btn-secondary" @click="showForm = false">Отмена</button>
        </div>
      </div>

      <!-- Список проектов -->
      <div v-if="store.loading" class="text-gray-500 text-sm">Загрузка…</div>
      <div v-else-if="!store.projects.length" class="empty">
        У вас пока нет проектов отслеживания. Создайте первый, чтобы начать собирать позиции.
      </div>
      <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div v-for="p in store.projects" :key="p.id" class="card hover:shadow-md transition cursor-pointer"
             @click="router.push(`/position-tracker/${p.id}`)">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h3 class="font-medium text-gray-900 truncate">{{ p.name || p.domain }}</h3>
              <div class="text-sm text-gray-500 truncate">{{ p.domain }}</div>
            </div>
            <button class="text-gray-400 hover:text-red-500 text-sm" @click.stop="removeProject(p.id)">✕</button>
          </div>
          <div class="mt-3 flex flex-wrap gap-2 text-xs">
            <span class="badge">{{
              p.engine === 'both' ? 'Яндекс + Google' : p.engine === 'yandex' ? 'Яндекс' : 'Google'
            }}</span>
            <span v-if="p.geo_lr" class="badge">lr={{ p.geo_lr }}</span>
            <span v-if="p.geo_loc" class="badge">{{ p.geo_loc }}</span>
            <span class="badge">{{ p.device === 'mobile' ? 'Mobile' : 'Desktop' }}</span>
            <span class="badge">{{
              p.schedule === 'daily' ? 'Ежедневно' :
              p.schedule === 'weekly' ? 'Еженедельно' : 'Вручную'
            }}</span>
            <span class="badge">Запросов: {{ p.keywords_active || 0 }}</span>
          </div>
          <div class="mt-3 text-xs text-gray-500">
            Последний съём: {{ fmtDate(p.last_run_at) }}
          </div>
        </div>
      </div>
    </div>
    </div>
  </AppLayout>
</template>

<style scoped>
/* Apple-style «сцена» — единый стиль со страницей отчётов (см. ReportEditorPage),
 * чтобы «съём позиций» и «отчёты» отображались одинаково и читались на светлом фоне. */
.tracker-stage {
  background: #f5f5f7;
  color-scheme: light;
  color: #1d1d1f;
  border-radius: 22px;
  padding: 12px;
  margin: -8px -8px 0;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", "Segoe UI", Roboto, Inter, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  letter-spacing: -0.01em;
}
.tracker-stage :deep(h2), .tracker-stage :deep(h3) { color: #1d1d1f; }
.page-title { font-size: 24px; font-weight: 700; color: #1d1d1f; letter-spacing: -0.02em; }
.page-sub { font-size: 13px; color: #6e6e73; }
.card {
  background: #fff; border: 1px solid rgba(60,60,67,0.12); border-radius: 16px; padding: 18px;
  color: #1d1d1f;
  box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 6px 18px rgba(0,0,0,0.04);
}
.input {
  width: 100%; padding: 9px 12px; border: 1px solid rgba(60,60,67,0.18); border-radius: 10px;
  font-size: 14px; background: #fff; color: #1d1d1f;
}
.input:focus { outline: none; border-color: #0a84ff; box-shadow: 0 0 0 3px rgba(10,132,255,0.15); }
.btn-primary { background: #0a84ff; color: #fff; padding: 9px 16px; border-radius: 10px; font-size: 14px; font-weight: 500; border: none; cursor: pointer; }
.btn-primary:hover { background: #0071e3; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-secondary { background: rgba(60,60,67,0.06); color: #1d1d1f; padding: 9px 16px; border-radius: 10px; font-size: 14px; font-weight: 500; border: none; cursor: pointer; }
.btn-secondary:hover { background: rgba(60,60,67,0.10); }
.badge { background: rgba(60,60,67,0.06); color: #424245; border-radius: 999px; padding: 3px 9px; font-size: 11px; font-weight: 500; }
.empty { background: #fff; border: 1px dashed rgba(60,60,67,0.18); border-radius: 16px; padding: 48px; text-align: center; color: #6e6e73; }
</style>
