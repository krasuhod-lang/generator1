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
    <div class="max-w-6xl mx-auto px-4 py-6">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-semibold text-gray-900">Съём позиций</h1>
          <p class="text-sm text-gray-500 mt-1">
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
  </AppLayout>
</template>

<style scoped>
.card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; }
.input { width: 100%; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; }
.input:focus { outline: 2px solid #6366f1; outline-offset: -1px; border-color: #6366f1; }
.btn-primary { background: #0071e3; color: #fff; padding: 8px 16px; border-radius: 8px; font-size: 14px; font-weight: 500; }
.btn-primary:hover { background: #0058b8; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-secondary { background: #f3f4f6; color: #374151; padding: 8px 16px; border-radius: 8px; font-size: 14px; font-weight: 500; }
.btn-secondary:hover { background: #e5e7eb; }
.badge { background: #f3f4f6; color: #374151; border-radius: 999px; padding: 2px 8px; font-size: 11px; }
.empty { background: #f9fafb; border: 1px dashed #e5e7eb; border-radius: 12px; padding: 48px; text-align: center; color: #6b7280; }
</style>
