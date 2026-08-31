<script setup>
import { ref, onMounted, onUnmounted, computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { useTasksStore } from '../stores/tasks.js';
import ResultModal from '../components/ResultModal.vue';
import AppLayout from '../components/AppLayout.vue';
import ToolHelp from '../components/ToolHelp.vue';
import AppPageHeader from '../components/AppPageHeader.vue';

const router = useRouter();
const auth = useAuthStore();
const store = useTasksStore();

const showResult = ref(false);
const resultTaskId = ref(null);
const centerTasks = computed(() => store.allTasks);
const centerLoading = ref(false);
const centerPage = ref(1);
const centerError = ref(null);
const errorMsg = ref(null);
const search = ref('');
const statusFilter = ref('all');
const typeFilter = ref('all');
const periodFilter = ref('all');
const sortBy = ref('newest');
const groupBy = ref('day');
const page = ref(1);
const pageSize = 20;
let pollTimer = null;
let errorTimer = null;

const RESULT_ROUTES = Object.freeze({
  meta_tag: (id) => `/meta-tags/${id}`,
  info_article: (id) => ({ path: '/info-article', query: { open: String(id) } }),
  link_article: (id) => ({ path: '/link-article', query: { open: String(id) } }),
  relevance: (id) => `/relevance/${id}`,
  forecaster: (id) => `/forecaster/${id}`,
  category_lead: (id) => `/category-lead/${id}`,
});

function isLegacySeoTask(task) {
  return String(task?.source || '') === 'seo';
}

function canOpenResult(task) {
  return isLegacySeoTask(task) || typeof RESULT_ROUTES[task?.source] === 'function';
}

function openResult(task) {
  if (isLegacySeoTask(task)) {
    resultTaskId.value = String(task.id);
    showResult.value = true;
    return;
  }
  const to = RESULT_ROUTES[task?.source]?.(task.id);
  if (to) router.push(to);
}

async function refreshCenterTasks({ preserveLoaded = false } = {}) {
  centerLoading.value = true;
  centerError.value = null;
  if (!preserveLoaded) centerPage.value = 1;
  await store.fetchAllTasks({
    limit: 200,
    page: 1,
    append: preserveLoaded && centerTasks.value.length > 0,
  });
  if (store.error) centerError.value = 'Не удалось обновить Центр задач. Попробуйте ещё раз.';
  centerLoading.value = false;
}

async function loadMoreCenterTasks() {
  if (centerLoading.value || !store.allTasksHasMore) return;
  centerLoading.value = true;
  centerError.value = null;
  centerPage.value += 1;
  await store.fetchAllTasks({ limit: 200, page: centerPage.value, append: true });
  if (store.error) centerError.value = 'Не удалось загрузить следующую страницу задач.';
  centerLoading.value = false;
}

function closeResult() {
  showResult.value = false;
  resultTaskId.value = null;
}

function showError(msg) {
  errorMsg.value = msg;
  if (errorTimer) clearTimeout(errorTimer);
  errorTimer = setTimeout(() => { errorMsg.value = null; }, 6000);
}

onMounted(async () => {
  await refreshCenterTasks();
  pollTimer = setInterval(() => refreshCenterTasks({ preserveLoaded: true }), 5000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
  if (errorTimer) clearTimeout(errorTimer);
});

watch([search, statusFilter, typeFilter, periodFilter, sortBy, groupBy], () => {
  page.value = 1;
});

async function handleStart(task) {
  if (!isLegacySeoTask(task)) return;
  try {
    await store.startTask(task.id);
    router.push(`/tasks/${task.id}/monitor`);
  } catch (e) {
    showError(e.response?.data?.error || 'Ошибка запуска задачи');
  }
}

async function handleDelete(task) {
  if (!isLegacySeoTask(task)) {
    showError('Архивирование этого типа задачи выполняется в его исходном разделе.');
    return;
  }
  if (!confirm(`Переместить задачу «${task.title || task.input_target_service || 'без названия'}» в архив? Результат и история сохранятся.`)) return;
  try {
    await store.deleteTask(task.id);
  } catch (e) {
    showError(e.response?.data?.error || 'Ошибка архивирования');
  }
}

const STATUS_META = {
  draft: { label: 'Черновик', cls: 'bg-gray-700 text-gray-300' },
  queued: { label: 'В очереди', cls: 'bg-yellow-900 text-yellow-300' },
  processing: { label: 'Выполняется', cls: 'bg-indigo-900 text-indigo-300' },
  completed: { label: 'Завершена', cls: 'bg-green-900 text-green-300' },
  failed: { label: 'Ошибка', cls: 'bg-red-900 text-red-300' },
  paused: { label: 'Пауза', cls: 'bg-orange-900 text-orange-300' },
  cancelled: { label: 'Отменена', cls: 'bg-gray-700 text-gray-400' },
};

function statusMeta(status) {
  return STATUS_META[status] || { label: status || 'Неизвестно', cls: 'bg-gray-700 text-gray-400' };
}

function fmtDate(dt) {
  if (!dt) return '—';
  const date = new Date(dt);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  });
}

function taskDateValue(task) {
  const status = String(task?.status || '').toLowerCase();
  // Для написанного SEO-текста бизнес-дата — фактическое завершение.
  // Для черновика/очереди updated_at не используется: heartbeat и autosave
  // не должны переносить задачу в другой день.
  return ['completed', 'failed', 'cancelled'].includes(status)
    ? (task?.completed_at || task?.created_at)
    : (task?.created_at || task?.updated_at);
}

function dateKey(dt) {
  if (!dt) return 'unknown';
  const date = new Date(dt);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toISOString().slice(0, 10);
}

function taskDateLabel(task) {
  return String(task?.status || '').toLowerCase() === 'completed' ? 'Выполнена' : 'Создана';
}

function statusMetaForTask(task) {
  if (task?.archived_at) return { label: 'Архив', cls: 'bg-gray-700 text-gray-400' };
  return statusMeta(task?.status);
}

function dateLabel(key) {
  if (key === 'unknown') return 'Дата не указана';
  const date = new Date(`${key}T12:00:00`);
  return date.toLocaleDateString('ru-RU', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
}

function fmtCost(usd) {
  if (usd == null || usd === '') return '—';
  const value = Number(usd);
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '$0.0000';
  if (Math.abs(value) < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4)}`;
}

function taskTitle(task) {
  return task.title || task.input_target_service || task.topic || task.name || task.query || task.url || 'Задача без названия';
}

function taskType(task) {
  if (task?.source_label) return task.source_label;
  const raw = String(task.task_type || task.type || task.module || task.source || '').toLowerCase();
  if (raw.includes('meta')) return 'Мета-теги';
  if (raw.includes('link')) return 'Ссылочная статья';
  if (raw.includes('info') || raw.includes('blog')) return 'Статья для блога';
  if (raw.includes('parser')) return 'Парсер';
  if (raw.includes('relevance')) return 'Релевантность';
  if (raw.includes('serp')) return 'SERP B2B';
  if (raw.includes('topic')) return 'Темы статей';
  return 'SEO-текст';
}

function isInPeriod(task) {
  if (periodFilter.value === 'all') return true;
  const raw = taskDateValue(task);
  const date = raw ? new Date(raw) : null;
  if (!date || Number.isNaN(date.getTime())) return false;
  const now = new Date();
  const start = new Date(now);
  if (periodFilter.value === 'today') start.setHours(0, 0, 0, 0);
  if (periodFilter.value === 'week') start.setDate(now.getDate() - 7);
  if (periodFilter.value === 'month') start.setDate(now.getDate() - 30);
  return date >= start;
}

const allTasks = computed(() => Array.isArray(centerTasks.value) ? centerTasks.value : []);
const typeOptions = computed(() => {
  const values = new Set(allTasks.value.map(taskType));
  return Array.from(values).sort((a, b) => a.localeCompare(b, 'ru'));
});
const statusCounts = computed(() => allTasks.value.reduce((acc, task) => {
  const key = task.status || 'unknown';
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {}));
const activeCount = computed(() => (statusCounts.value.processing || 0) + (statusCounts.value.queued || 0));
const access = computed(() => auth.user?.entitlements || null);
const isClient = computed(() => !auth.user || String(auth.user.role || '').toLowerCase() === 'client');
const roleLabel = computed(() => ({ admin: 'Администратор', employee: 'Сотрудник', client: 'Клиент' }[auth.user?.role] || 'Пользователь'));
const planLabel = computed(() => auth.user?.plan_name || auth.user?.plan || 'Бесплатный доступ');
const accessPeriodLabel = computed(() => {
  const end = auth.user?.access_period_end;
  if (!end) return auth.user?.plan === 'trial' ? 'Пять генераций статей без срока действия' : 'Без ограничения периода';
  return `до ${new Date(end).toLocaleDateString('ru-RU')}`;
});
const accessRows = computed(() => {
  const rows = auth.user?.plan === 'trial'
    ? [['article_generations', 'Бесплатные генерации'], ['meta_categories', 'Мета-категории'], ['relevance_runs', 'Релевантность'], ['article_topics', 'Темы статей']]
    : [['seo_articles', 'SEO-тексты'], ['blog_articles', 'Блог'], ['link_articles', 'Ссылочные статьи'], ['meta_categories', 'Мета-категории'], ['relevance_runs', 'Релевантность'], ['article_topics', 'Темы статей']];
  return rows.map(([key, label]) => ({
  key, label,
  remaining: access.value?.remaining?.[key],
    limit: access.value?.limits?.[key],
  }));
});
function displayAccessLimit(value) {
  return value == null ? 'безлимитно' : String(value);
}

const filteredTasks = computed(() => {
  const needle = search.value.trim().toLowerCase();
  const list = allTasks.value.filter((task) => {
    const haystack = [taskTitle(task), task.input_brand_name, task.input_target_service, task.id]
      .filter(Boolean).join(' ').toLowerCase();
    const matchesSearch = !needle || haystack.includes(needle);
    const matchesStatus = statusFilter.value === 'all' || task.status === statusFilter.value;
    const matchesType = typeFilter.value === 'all' || taskType(task) === typeFilter.value;
    return matchesSearch && matchesStatus && matchesType && isInPeriod(task);
  });

  return list.sort((a, b) => {
    const aTime = new Date(taskDateValue(a) || 0).getTime() || 0;
    const bTime = new Date(taskDateValue(b) || 0).getTime() || 0;
    if (sortBy.value === 'oldest') return aTime - bTime;
    if (sortBy.value === 'cost') return (Number(b.total_cost_usd) || 0) - (Number(a.total_cost_usd) || 0);
    if (sortBy.value === 'title') return taskTitle(a).localeCompare(taskTitle(b), 'ru');
    return bTime - aTime;
  });
});

const pageCount = computed(() => Math.max(1, Math.ceil(filteredTasks.value.length / pageSize)));
const pagedTasks = computed(() => filteredTasks.value.slice((page.value - 1) * pageSize, page.value * pageSize));
const groupedTasks = computed(() => {
  if (groupBy.value === 'none') return [{ key: 'all', label: '', tasks: pagedTasks.value }];
  const groups = new Map();
  for (const task of pagedTasks.value) {
    const key = groupBy.value === 'month' ? dateKey(taskDateValue(task)).slice(0, 7) : dateKey(taskDateValue(task));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }
  return Array.from(groups.entries()).map(([key, tasks]) => ({
    key,
    label: groupBy.value === 'month' ? key === 'unknown' ? 'Дата не указана' : new Date(`${key}-15T12:00:00`).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }) : dateLabel(key),
    tasks,
  }));
});

function clearFilters() {
  search.value = '';
  statusFilter.value = 'all';
  typeFilter.value = 'all';
  periodFilter.value = 'all';
  sortBy.value = 'newest';
  page.value = 1;
}

function goPage(next) {
  page.value = Math.min(pageCount.value, Math.max(1, next));
}
</script>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 0.25s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
.task-toolbar { background: rgba(17, 24, 39, 0.55); border: 1px solid rgba(55, 65, 81, 0.8); }
.filter-chip { transition: background-color 0.15s ease, color 0.15s ease; }
.filter-chip.active { background: rgba(79, 70, 229, 0.25); color: #c7d2fe; border-color: rgba(99, 102, 241, 0.6); }
</style>

<template>
  <AppLayout>
    <transition name="fade">
      <div v-if="errorMsg" class="app-alert-container">
        <div class="flex items-start gap-3 bg-red-950/70 border border-red-800 text-red-300 rounded-lg px-4 py-3 text-sm">
          <span class="flex-1">{{ errorMsg }}</span>
          <button class="text-red-500 hover:text-red-300 ml-2" @click="errorMsg = null" aria-label="Закрыть">×</button>
        </div>
      </div>
    </transition>

    <div class="app-page">
      <AppPageHeader
        eyebrow="Рабочая область"
        title="Центр задач"
        description="Все генерации в одном месте: статьи, SEO-тексты, мета-теги, темы, релевантность, прогнозы и сканирования."
      >
        <template #title-suffix>
          <ToolHelp title="Центр задач" text="Здесь собраны все ваши генерации. Статус показывает состояние задачи, а кнопка «Результат» открывает готовый материал." />
        </template>
        <template #actions>
          <div class="text-xs text-gray-500 mr-1">
            {{ filteredTasks.length }} из {{ allTasks.length }} загруженных задач
            <span v-if="store.allTasksTotal > allTasks.length" class="text-gray-600"> · всего {{ store.allTasksTotal }}</span>
            <span v-if="activeCount" class="text-indigo-300"> · {{ activeCount }} активных</span>
          </div>
          <button class="btn-ghost text-xs" :disabled="centerLoading" @click="refreshCenterTasks">
            {{ centerLoading ? 'Обновление…' : 'Обновить' }}
          </button>
          <RouterLink to="/tasks/new" class="btn-primary inline-flex items-center gap-2">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>
            Создать задачу
          </RouterLink>
        </template>
      </AppPageHeader>

      <section v-if="access" class="card mb-5 border border-indigo-900/60 bg-indigo-950/20">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p class="text-xs uppercase tracking-wide text-indigo-300">Доступ аккаунта</p>
            <h2 class="text-lg font-semibold text-white mt-1">{{ planLabel }}</h2>
            <p class="text-xs text-gray-400 mt-1">{{ roleLabel }} · {{ accessPeriodLabel }}</p>
          </div>
          <span class="rounded-full bg-indigo-900/60 px-3 py-1 text-xs text-indigo-200">{{ auth.user?.access_status === 'active' ? 'Активен' : 'Ограничен' }}</span>
        </div>
        <div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mt-4">
          <div v-for="row in accessRows" :key="row.key" class="rounded-lg bg-gray-950/40 border border-gray-800 px-3 py-2">
            <p class="text-[11px] text-gray-500 truncate">{{ row.label }}</p>
            <p class="text-sm font-semibold text-white mt-1">{{ displayAccessLimit(row.remaining) }}</p>
            <p class="text-[10px] text-gray-600">из {{ displayAccessLimit(row.limit) }}</p>
          </div>
        </div>
      </section>

      <section class="task-toolbar rounded-xl p-4 mb-5 space-y-4">
        <div class="flex flex-col lg:flex-row gap-3">
          <label class="relative flex-1">
            <span class="sr-only">Поиск задач</span>
            <svg class="absolute left-3 top-2.5 w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path stroke-linecap="round" d="m20 20-4-4"/></svg>
            <input v-model="search" type="search" placeholder="Поиск по названию, услуге или ID…" class="w-full bg-gray-950/60 border border-gray-700 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-gray-600 focus:border-indigo-500 focus:outline-none" />
          </label>
          <select v-model="typeFilter" class="bg-gray-950/60 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 focus:border-indigo-500 focus:outline-none">
            <option value="all">Все типы</option>
            <option v-for="type in typeOptions" :key="type" :value="type">{{ type }}</option>
          </select>
          <select v-model="periodFilter" class="bg-gray-950/60 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 focus:border-indigo-500 focus:outline-none">
            <option value="all">За всё время</option>
            <option value="today">Сегодня</option>
            <option value="week">Последние 7 дней</option>
            <option value="month">Последние 30 дней</option>
          </select>
          <select v-model="sortBy" class="bg-gray-950/60 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 focus:border-indigo-500 focus:outline-none">
            <option value="newest">Сначала новые</option>
            <option value="oldest">Сначала старые</option>
              <option v-if="!isClient" value="cost">По стоимости</option>
            <option value="title">По названию</option>
          </select>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <span class="text-xs text-gray-500 mr-1">Статус:</span>
          <button v-for="item in [{key:'all',label:'Все'}, {key:'processing',label:'Выполняются'}, {key:'queued',label:'В очереди'}, {key:'completed',label:'Завершены'}, {key:'failed',label:'С ошибкой'}, {key:'draft',label:'Черновики'}]" :key="item.key" class="filter-chip border border-gray-700 rounded-full px-3 py-1 text-xs text-gray-400" :class="{ active: statusFilter === item.key }" @click="statusFilter = item.key">
            {{ item.label }} <span class="text-gray-600">{{ item.key === 'all' ? allTasks.length : (statusCounts[item.key] || 0) }}</span>
          </button>
          <button v-if="search || statusFilter !== 'all' || typeFilter !== 'all' || periodFilter !== 'all'" class="text-xs text-indigo-300 hover:text-indigo-200 ml-auto" @click="clearFilters">Сбросить фильтры</button>
        </div>

        <div class="flex flex-wrap items-center gap-3 text-xs text-gray-500">
          <label class="flex items-center gap-2">Группировка
            <select v-model="groupBy" class="bg-gray-950/60 border border-gray-700 rounded px-2 py-1 text-gray-300"><option value="day">По дням</option><option value="month">По месяцам</option><option value="none">Без группировки</option></select>
          </label>
          <span class="ml-auto">Локальная страница {{ page }} из {{ pageCount }}</span>
        </div>
      </section>

      <div v-if="centerError" class="card mb-5 border border-red-900/60 text-red-300 text-sm">{{ centerError }}</div>
      <div v-if="centerLoading && !allTasks.length" class="flex items-center justify-center py-20 text-gray-500">Загрузка всех задач…</div>
      <div v-else-if="!allTasks.length" class="card text-center py-16">
        <div class="text-4xl mb-4">—</div>
        <p class="text-gray-400 text-lg font-medium">Задач пока нет</p>
        <p class="text-gray-600 text-sm mt-1 mb-5">Создайте первую задачу и запустите генерацию SEO-контента</p>
        <RouterLink to="/tasks/new" class="btn-primary inline-flex">Создать задачу</RouterLink>
      </div>
      <div v-else-if="!filteredTasks.length" class="card text-center py-14">
        <p class="text-gray-400 font-medium">По выбранным фильтрам задач нет</p>
        <button class="text-indigo-300 text-sm mt-3 hover:text-indigo-200" @click="clearFilters">Сбросить фильтры</button>
      </div>
      <div v-else class="card overflow-hidden p-0">
        <div class="overflow-x-auto">
        <table class="w-full min-w-[760px] text-sm">
          <thead><tr class="border-b border-gray-800 text-left"><th class="px-5 py-3 text-gray-500 font-medium w-10">#</th><th class="px-5 py-3 text-gray-500 font-medium">Задача</th><th class="px-5 py-3 text-gray-500 font-medium">Тип</th><th class="px-5 py-3 text-gray-500 font-medium">Статус</th><th class="px-5 py-3 text-gray-500 font-medium">Дата</th><th v-if="!isClient" class="px-5 py-3 text-gray-500 font-medium">Стоимость</th><th class="px-5 py-3 text-gray-500 font-medium text-right">Действия</th></tr></thead>
          <tbody>
            <template v-for="group in groupedTasks" :key="group.key">
              <tr v-if="group.label" class="bg-gray-900/80"><td :colspan="isClient ? 6 : 7" class="px-5 py-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{{ group.label }}</td></tr>
              <tr v-for="(task, idx) in group.tasks" :key="task.id" class="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                <td class="px-5 py-3.5 text-gray-600">{{ (page - 1) * pageSize + idx + 1 }}</td>
                <td class="px-5 py-3.5 max-w-sm"><p class="text-white font-medium truncate">{{ taskTitle(task) }}</p><p v-if="task.lsi_coverage != null || task.eeat_score != null" class="text-xs text-gray-500 mt-0.5">LSI {{ task.lsi_coverage ?? '—' }}% · E‑E‑A‑T {{ task.eeat_score ?? '—' }}</p><p class="text-xs text-gray-600 mt-0.5 font-mono truncate">{{ String(task.id).slice(0, 16) }}<span v-if="String(task.id).length > 16">…</span></p></td>
                <td class="px-5 py-3.5"><span class="text-xs text-gray-400">{{ taskType(task) }}</span></td>
                <td class="px-5 py-3.5"><span :class="['badge', statusMetaForTask(task).cls]">{{ statusMetaForTask(task).label }}</span></td>
                <td class="px-5 py-3.5 text-gray-400 whitespace-nowrap"><span class="block text-[11px] text-gray-600">{{ taskDateLabel(task) }}</span>{{ fmtDate(taskDateValue(task)) }}</td>
                <td v-if="!isClient" class="px-5 py-3.5 font-mono text-indigo-400">{{ fmtCost(task.total_cost_usd) }}</td>
                <td class="px-5 py-3.5"><div class="flex items-center gap-1.5 justify-end flex-wrap"><button v-if="isLegacySeoTask(task) && !task.archived_at && (task.status === 'draft' || task.status === 'failed')" @click="handleStart(task)" class="btn-primary text-xs px-3 py-1.5">Запустить</button><RouterLink v-if="isLegacySeoTask(task) && !isClient && !task.archived_at && (task.status === 'queued' || task.status === 'processing')" :to="`/tasks/${task.id}/monitor`" class="btn-secondary text-xs px-3 py-1.5">Мониторинг</RouterLink><button v-if="task.status === 'completed' && canOpenResult(task)" @click="openResult(task)" class="btn-primary text-xs px-3 py-1.5">Открыть результат</button><RouterLink v-if="isLegacySeoTask(task) && !task.archived_at && (task.status === 'draft' || task.status === 'failed')" :to="`/tasks/${task.id}/edit`" class="btn-secondary text-xs px-3 py-1.5">Изменить</RouterLink><button v-if="isLegacySeoTask(task) && !task.archived_at" @click="handleDelete(task)" class="btn-danger text-xs px-3 py-1.5" title="Переместить в архив">В архив</button></div></td>
              </tr>
            </template>
          </tbody>
        </table>
        </div>
        <footer class="flex flex-wrap items-center justify-between gap-3 border-t border-gray-800 px-5 py-3"><span class="text-xs text-gray-600">Показаны {{ (page - 1) * pageSize + 1 }}–{{ Math.min(page * pageSize, filteredTasks.length) }} из {{ filteredTasks.length }} загруженных</span><div class="flex items-center gap-2"><button class="btn-secondary text-xs px-3 py-1.5" :disabled="page <= 1" @click="goPage(page - 1)">Назад</button><button class="btn-secondary text-xs px-3 py-1.5" :disabled="page >= pageCount" @click="goPage(page + 1)">Вперёд</button><button v-if="store.allTasksHasMore" class="btn-primary text-xs px-3 py-1.5" :disabled="centerLoading" @click="loadMoreCenterTasks">{{ centerLoading ? 'Загрузка…' : 'Загрузить ещё задачи' }}</button></div></footer>
      </div>
    </div>

    <ResultModal :task-id="resultTaskId" :visible="showResult" @close="closeResult" />
  </AppLayout>
</template>
