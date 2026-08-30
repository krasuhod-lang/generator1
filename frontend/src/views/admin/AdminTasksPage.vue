<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAdminStore } from '../../stores/admin.js';
import AdminLayout from '../../components/AdminLayout.vue';

const route = useRoute();
const router = useRouter();
const admin = useAdminStore();
const tasks = ref([]);
const total = ref(0);
const page = ref(1);
const perPage = 30;
const loading = ref(false);
const error = ref(null);
const status = ref(typeof route.query.status === 'string' ? route.query.status : '');
const user = ref('');
const from = ref('');
const to = ref('');

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / perPage)));
const statusOptions = [
  { value: '', label: 'Все статусы' },
  { value: 'queued', label: 'В очереди' },
  { value: 'processing', label: 'В работе' },
  { value: 'completed', label: 'Завершено' },
  { value: 'failed', label: 'Ошибка' },
  { value: 'paused', label: 'Пауза' },
];

function statusLabel(value) {
  return statusOptions.find((item) => item.value === value)?.label || value || '—';
}

function statusClass(value) {
  return value === 'completed' ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/20' : value === 'failed' ? 'bg-red-500/15 text-red-300 ring-red-400/20' : value === 'processing' ? 'bg-blue-500/15 text-blue-300 ring-blue-400/20' : value === 'queued' ? 'bg-amber-500/15 text-amber-300 ring-amber-400/20' : 'bg-gray-800 text-gray-400 ring-gray-700';
}

function fmtDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtCost(value) {
  const number = Number(value);
  return Number.isFinite(number) ? '$' + number.toFixed(Math.abs(number) < 0.01 ? 6 : 4) : '—';
}

function sourceLabel(task) {
  return task.input_target_service || task.source || 'SEO';
}

async function loadTasks() {
  loading.value = true;
  error.value = null;
  try {
    const data = await admin.fetchAdminAllTasks({ status: status.value, user: user.value.trim(), from: from.value, to: to.value, page: page.value, perPage });
    tasks.value = data.tasks || [];
    total.value = Number(data.total) || 0;
  } catch (requestError) {
    error.value = requestError.response?.data?.error || requestError.message || 'Не удалось загрузить задачи';
  } finally {
    loading.value = false;
  }
}

function applyFilters() {
  page.value = 1;
  const query = {};
  if (status.value) query.status = status.value;
  if (user.value.trim()) query.user = user.value.trim();
  router.replace({ path: '/admin/tasks', query });
  loadTasks();
}

function clearFilters() {
  status.value = '';
  user.value = '';
  from.value = '';
  to.value = '';
  applyFilters();
}

function openTask(task) {
  router.push(`/admin/tasks/${task.id}`);
}

function openPage(nextPage) {
  if (nextPage < 1 || nextPage > totalPages.value || nextPage === page.value) return;
  page.value = nextPage;
  loadTasks();
}

onMounted(loadTasks);
</script>

<template>
  <AdminLayout>
    <div class="app-page">
      <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p class="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-blue-300/80">Task operations</p>
          <h2 class="text-2xl font-semibold tracking-tight text-white sm:text-3xl">Все задачи</h2>
          <p class="mt-2 max-w-2xl text-sm leading-6 text-gray-500">Единый список SEO, blog, link и других генераций с быстрым переходом к логам и деталям.</p>
        </div>
        <div class="rounded-xl border border-gray-800 bg-gray-900/60 px-3 py-2 text-xs text-gray-400">Найдено: <strong class="text-white">{{ total }}</strong></div>
      </div>

      <div v-if="error" class="mb-5 rounded-xl border border-red-800/80 bg-red-950/40 px-4 py-3 text-sm text-red-300" role="alert">{{ error }}</div>

      <section class="card mb-5">
        <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div><h3 class="text-sm font-semibold text-white">Фильтры</h3><p class="mt-1 text-xs text-gray-600">Поиск по email пользователя или UUID.</p></div>
          <button type="button" class="text-xs text-gray-600 transition hover:text-gray-300" @click="clearFilters">Сбросить всё</button>
        </div>
        <form class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-[1fr_1.4fr_1fr_1fr_auto]" @submit.prevent="applyFilters">
          <label class="text-xs text-gray-500">Статус<select v-model="status" class="input mt-1" aria-label="Статус"><option v-for="option in statusOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
          <label class="text-xs text-gray-500">Пользователь<input v-model="user" class="input mt-1" type="search" placeholder="email или UUID" aria-label="Пользователь" /></label>
          <label class="text-xs text-gray-500">От<input v-model="from" class="input mt-1" type="date" aria-label="Дата от" /></label>
          <label class="text-xs text-gray-500">До<input v-model="to" class="input mt-1" type="date" aria-label="Дата до" /></label>
          <button type="submit" class="btn-primary self-end justify-center bg-blue-600 hover:bg-blue-500" :disabled="loading">{{ loading ? 'Ищем…' : 'Применить' }}</button>
        </form>
      </section>

      <section class="card overflow-hidden p-0">
        <div class="flex items-center justify-between border-b border-gray-800/80 px-5 py-4"><div><h3 class="text-sm font-semibold text-white">Лента генераций</h3><p class="mt-1 text-xs text-gray-600">Сортировка: сначала последние созданные задачи.</p></div><button type="button" class="btn-ghost border border-gray-800 px-3 py-2 text-xs" :disabled="loading" @click="loadTasks">↻ Обновить</button></div>
        <div class="overflow-x-auto">
          <table class="min-w-[980px] w-full text-sm">
            <thead class="bg-gray-950/60"><tr class="border-b border-gray-800 text-left"><th class="px-5 py-3 text-xs font-medium text-gray-500">Задача</th><th class="px-3 py-3 text-xs font-medium text-gray-500">Пользователь</th><th class="px-3 py-3 text-xs font-medium text-gray-500">Тип</th><th class="px-3 py-3 text-xs font-medium text-gray-500">Статус</th><th class="px-3 py-3 text-xs font-medium text-gray-500">Создана</th><th class="px-3 py-3 text-xs font-medium text-gray-500">Метрики</th><th class="px-5 py-3 text-right text-xs font-medium text-gray-500">Действие</th></tr></thead>
            <tbody>
              <tr v-for="task in tasks" :key="`${task.id}-${task.source || 'seo'}`" class="border-b border-gray-800/60 transition hover:bg-gray-800/25">
                <td class="max-w-[320px] px-5 py-4"><button type="button" class="block max-w-full truncate text-left font-medium text-gray-200 transition hover:text-emerald-300" :title="task.title" @click="openTask(task)">{{ task.title || 'Без названия' }}</button><div class="mt-1 font-mono text-[10px] text-gray-700">{{ task.id }}</div></td>
                <td class="max-w-[210px] px-3 py-4"><div class="truncate text-gray-300" :title="task.user_email">{{ task.user_email || '—' }}</div><div class="mt-1 text-[11px] text-gray-600">{{ task.user_id }}</div></td>
                <td class="px-3 py-4 text-xs text-gray-400">{{ sourceLabel(task) }}</td>
                <td class="px-3 py-4"><span class="inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset" :class="statusClass(task.status)">{{ statusLabel(task.status) }}</span></td>
                <td class="whitespace-nowrap px-3 py-4 text-xs text-gray-500">{{ fmtDate(task.created_at) }}</td>
                <td class="px-3 py-4"><div class="text-xs text-gray-300">{{ task.total_tokens ? `${Number(task.total_tokens).toLocaleString('ru-RU')} ток.` : '—' }}</div><div class="mt-1 font-mono text-[11px] text-cyan-300">{{ fmtCost(task.total_cost_usd) }}</div></td>
                <td class="px-5 py-4 text-right"><button type="button" class="text-xs font-medium text-emerald-400 transition hover:text-emerald-300" @click="openTask(task)">Открыть →</button></td>
              </tr>
              <tr v-if="!tasks.length && !loading"><td colspan="7" class="px-5 py-14 text-center"><div class="text-3xl text-gray-700">▦</div><p class="mt-3 text-sm text-gray-500">Задач по выбранным условиям нет</p><p class="mt-1 text-xs text-gray-700">Попробуйте сбросить фильтры или изменить период.</p></td></tr>
              <tr v-if="loading"><td colspan="7" class="px-5 py-14 text-center text-sm text-gray-500"><span class="inline-flex items-center gap-2"><span class="h-2 w-2 animate-pulse rounded-full bg-blue-400" />Загружаем задачи…</span></td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <div v-if="totalPages > 1" class="mt-5 flex items-center justify-between gap-3"><p class="text-xs text-gray-600">Страница {{ page }} из {{ totalPages }}</p><div class="flex gap-2"><button type="button" class="btn-ghost px-3 py-2 text-xs" :disabled="page <= 1 || loading" @click="openPage(page - 1)">← Назад</button><button type="button" class="btn-ghost px-3 py-2 text-xs" :disabled="page >= totalPages || loading" @click="openPage(page + 1)">Вперёд →</button></div></div>
    </div>
  </AdminLayout>
</template>
