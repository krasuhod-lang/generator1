<script setup>
import { ref, onMounted, watch, computed } from 'vue';
import { useAdminStore } from '../../stores/admin.js';
import AdminLayout from '../../components/AdminLayout.vue';

const admin = useAdminStore();
const search = ref('');
const currentPage = ref(1);
const sortField = ref('created_at');
const sortOrder = ref('desc');
const pageLimit = 20;
const pageLoading = ref(false);
const pageError = ref(null);
const deletingId = ref(null);
let searchTimer = null;

const totalPages = computed(() => Math.max(1, Math.ceil((admin.usersTotal || 0) / pageLimit)));
const pageRange = computed(() => {
  const total = totalPages.value;
  const current = currentPage.value;
  const start = Math.max(1, Math.min(current - 2, total - 4));
  return Array.from({ length: Math.min(5, total) }, (_, index) => start + index).filter((page) => page <= total);
});

function roleLabel(role) {
  return ({ admin: 'Администратор', employee: 'Сотрудник', client: 'Клиент' }[role] || 'Клиент');
}

function planLabel(plan) {
  return ({ trial: 'Бесплатный', minimal: 'Минимальный', medium: 'Средний', pro: 'Про', internal: 'Внутренний' }[plan] || plan || '—');
}

function fmtDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtCost(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return '$' + number.toFixed(Math.abs(number) < 0.01 ? 6 : 4);
}

function roleClass(role) {
  return role === 'admin' ? 'bg-indigo-500/15 text-indigo-200 ring-indigo-400/20' : role === 'employee' ? 'bg-blue-500/15 text-blue-200 ring-blue-400/20' : 'bg-gray-800 text-gray-300 ring-gray-700';
}

function planClass(plan) {
  return plan === 'pro' ? 'text-amber-300' : plan === 'medium' ? 'text-violet-300' : plan === 'minimal' ? 'text-cyan-300' : plan === 'trial' ? 'text-emerald-300' : 'text-gray-300';
}

async function loadUsers() {
  pageLoading.value = true;
  pageError.value = null;
  try {
    await admin.fetchUsers({ page: currentPage.value, limit: pageLimit, search: search.value, sort: sortField.value, order: sortOrder.value });
  } catch (error) {
    pageError.value = error.response?.data?.error || error.message || 'Не удалось загрузить пользователей';
  } finally {
    pageLoading.value = false;
  }
}

function handleSort(field) {
  if (sortField.value === field) sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc';
  else { sortField.value = field; sortOrder.value = 'desc'; }
  currentPage.value = 1;
  loadUsers();
}

function sortIcon(field) {
  if (sortField.value !== field) return '↕';
  return sortOrder.value === 'asc' ? '↑' : '↓';
}

function goPage(page) {
  if (page < 1 || page > totalPages.value || page === currentPage.value) return;
  currentPage.value = page;
  loadUsers();
}

async function removeUser(user) {
  if (deletingId.value || user.role === 'admin') return;
  if (!window.confirm(`Удалить пользователя ${user.email}?\n\nВсе его задачи, проекты и данные будут удалены безвозвратно.`)) return;
  deletingId.value = user.id;
  try {
    await admin.deleteUser(user.id);
    await loadUsers();
  } catch (error) {
    pageError.value = error.response?.data?.error || error.message || 'Не удалось удалить пользователя';
  } finally {
    deletingId.value = null;
  }
}

watch(search, () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { currentPage.value = 1; loadUsers(); }, 300);
});

onMounted(loadUsers);
</script>

<template>
  <AdminLayout>
    <div class="app-page">
      <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p class="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-emerald-400/80">Access management</p>
          <h2 class="text-2xl font-semibold tracking-tight text-white sm:text-3xl">Пользователи</h2>
          <p class="mt-2 max-w-2xl text-sm leading-6 text-gray-500">Управляйте ролями, тарифами и индивидуальными лимитами. Откройте профиль пользователя для полного access summary.</p>
        </div>
        <div class="flex items-center gap-2 rounded-xl border border-gray-800 bg-gray-900/60 px-3 py-2 text-xs text-gray-400">
          <span class="h-2 w-2 rounded-full bg-emerald-400" />
          Всего: <strong class="font-semibold text-white">{{ admin.usersTotal }}</strong>
        </div>
      </div>

      <div v-if="pageError" class="mb-5 rounded-xl border border-red-800/80 bg-red-950/40 px-4 py-3 text-sm text-red-300" role="alert">{{ pageError }}</div>

      <section class="card mb-5">
        <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <label class="relative block w-full lg:max-w-md">
            <span class="sr-only">Поиск пользователей</span>
            <span class="pointer-events-none absolute inset-y-0 left-3 flex items-center text-gray-600">⌕</span>
            <input v-model="search" type="search" class="input pl-9" placeholder="Поиск по email или имени…" />
          </label>
          <div class="flex flex-wrap items-center gap-3 text-xs text-gray-500">
            <span v-if="pageLoading" class="inline-flex items-center gap-2 text-emerald-300"><span class="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />Обновление списка…</span>
            <span v-else>Показано {{ admin.users.length }} из {{ admin.usersTotal }}</span>
            <button type="button" class="btn-ghost border border-gray-800 px-3 py-2" :disabled="pageLoading" @click="loadUsers">↻ Обновить</button>
          </div>
        </div>
      </section>

      <section class="card overflow-hidden p-0">
        <div class="flex items-center justify-between border-b border-gray-800/80 px-5 py-4">
          <div>
            <h3 class="text-sm font-semibold text-white">Реестр аккаунтов</h3>
            <p class="mt-1 text-xs text-gray-600">Нажмите «Подробнее», чтобы изменить доступ и лимиты.</p>
          </div>
          <span class="hidden rounded-full bg-gray-800 px-2.5 py-1 text-[11px] text-gray-500 sm:inline-flex">Страница {{ currentPage }} / {{ totalPages }}</span>
        </div>
        <div class="overflow-x-auto">
          <table class="min-w-[980px] w-full text-sm">
            <thead class="bg-gray-950/60">
              <tr class="border-b border-gray-800 text-left">
                <th class="px-5 py-3 text-xs font-medium text-gray-500" @click="handleSort('email')">Email <button type="button" class="ml-1 text-gray-600 hover:text-gray-300">{{ sortIcon('email') }}</button></th>
                <th class="px-3 py-3 text-xs font-medium text-gray-500" @click="handleSort('name')">Профиль <button type="button" class="ml-1 text-gray-600 hover:text-gray-300">{{ sortIcon('name') }}</button></th>
                <th class="px-3 py-3 text-xs font-medium text-gray-500">Доступ</th>
                <th class="px-3 py-3 text-xs font-medium text-gray-500">Тариф</th>
                <th class="px-3 py-3 text-xs font-medium text-gray-500" @click="handleSort('tasks_total')">Задачи <button type="button" class="ml-1 text-gray-600 hover:text-gray-300">{{ sortIcon('tasks_total') }}</button></th>
                <th class="px-3 py-3 text-xs font-medium text-gray-500">Результат</th>
                <th class="px-3 py-3 text-xs font-medium text-gray-500" @click="handleSort('total_cost_usd')">Расходы <button type="button" class="ml-1 text-gray-600 hover:text-gray-300">{{ sortIcon('total_cost_usd') }}</button></th>
                <th class="px-5 py-3 text-right text-xs font-medium text-gray-500">Действия</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="user in admin.users" :key="user.id" class="border-b border-gray-800/60 transition hover:bg-gray-800/25">
                <td class="px-5 py-4">
                  <div class="max-w-[250px] truncate font-medium text-gray-200" :title="user.email">{{ user.email }}</div>
                  <div class="mt-1 text-[11px] text-gray-600">Регистрация: {{ fmtDate(user.created_at) }}</div>
                </td>
                <td class="px-3 py-4"><div class="text-gray-300">{{ user.name || 'Без имени' }}</div><div class="mt-1 text-[11px] text-gray-600">Последняя задача: {{ fmtDate(user.last_task_at) }}</div></td>
                <td class="px-3 py-4">
                  <span class="inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset" :class="roleClass(user.account_role || user.role)">{{ roleLabel(user.account_role || user.role) }}</span>
                  <span v-if="user.access_status && user.access_status !== 'active'" class="mt-1 block text-[11px] text-amber-300">{{ user.access_status }}</span>
                </td>
                <td class="px-3 py-4"><span class="font-medium" :class="planClass(user.plan_key)">{{ planLabel(user.plan_key) }}</span></td>
                <td class="px-3 py-4"><div class="font-semibold tabular-nums text-gray-200">{{ user.tasks_total }}</div><div class="mt-1 text-[11px] text-gray-600"><span class="text-green-400">{{ user.tasks_completed }}</span> завершено · <span class="text-red-400">{{ user.tasks_failed }}</span> ошибок</div></td>
                <td class="px-3 py-4"><div class="text-xs text-gray-300">{{ user.last_task_at ? 'Есть активность' : 'Нет задач' }}</div><div class="mt-1 text-[11px] text-gray-600">{{ fmtDate(user.last_task_at) }}</div></td>
                <td class="px-3 py-4 font-mono text-xs text-cyan-300">{{ fmtCost(user.total_cost_usd) }}</td>
                <td class="px-5 py-4"><div class="flex items-center justify-end gap-3"><router-link :to="`/admin/users/${user.id}`" class="text-xs font-medium text-emerald-400 transition hover:text-emerald-300">Управление →</router-link><button v-if="user.role !== 'admin'" type="button" class="text-xs text-gray-600 transition hover:text-red-300 disabled:opacity-40" :disabled="deletingId === user.id" @click="removeUser(user)">{{ deletingId === user.id ? '…' : 'Удалить' }}</button></div></td>
              </tr>
              <tr v-if="!admin.users.length && !pageLoading"><td colspan="8" class="px-5 py-14 text-center"><div class="text-3xl text-gray-700">◎</div><p class="mt-3 text-sm text-gray-500">Пользователи не найдены</p><p class="mt-1 text-xs text-gray-700">Измените поисковый запрос или обновите список.</p></td></tr>
              <tr v-if="pageLoading"><td colspan="8" class="px-5 py-14 text-center text-sm text-gray-500"><span class="inline-flex items-center gap-2"><span class="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />Загружаем пользователей…</span></td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <div v-if="totalPages > 1" class="mt-5 flex flex-wrap items-center justify-between gap-3">
        <p class="text-xs text-gray-600">{{ (currentPage - 1) * pageLimit + 1 }}–{{ Math.min(currentPage * pageLimit, admin.usersTotal) }} из {{ admin.usersTotal }}</p>
        <div class="flex items-center gap-1">
          <button type="button" class="btn-ghost px-3 py-2 text-xs" :disabled="currentPage <= 1 || pageLoading" @click="goPage(currentPage - 1)">← Назад</button>
          <button v-for="page in pageRange" :key="page" type="button" class="h-9 min-w-9 rounded-lg px-2 text-xs transition" :class="page === currentPage ? 'bg-emerald-500 text-gray-950' : 'text-gray-500 hover:bg-gray-800 hover:text-gray-200'" :disabled="pageLoading" @click="goPage(page)">{{ page }}</button>
          <button type="button" class="btn-ghost px-3 py-2 text-xs" :disabled="currentPage >= totalPages || pageLoading" @click="goPage(currentPage + 1)">Вперёд →</button>
        </div>
      </div>
    </div>
  </AdminLayout>
</template>
