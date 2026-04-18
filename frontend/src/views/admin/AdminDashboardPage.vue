<script setup>
import { ref, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useAdminStore } from '../../stores/admin.js';
import AdminLayout from '../../components/AdminLayout.vue';

const router = useRouter();
const admin  = useAdminStore();

// ── Состояние ──────────────────────────────────────────────────────
const search      = ref('');
const currentPage = ref(1);
const sortField   = ref('created_at');
const sortOrder   = ref('desc');
const pageLimit   = 20;

let searchTimer = null;

// ── Загрузка данных ────────────────────────────────────────────────
onMounted(async () => {
  await Promise.all([loadUsers(), admin.fetchStats()]);
});

async function loadUsers() {
  await admin.fetchUsers({
    page:   currentPage.value,
    limit:  pageLimit,
    search: search.value,
    sort:   sortField.value,
    order:  sortOrder.value,
  });
}

// Debounced search
watch(search, () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    currentPage.value = 1;
    loadUsers();
  }, 300);
});

function handleSort(field) {
  if (sortField.value === field) {
    sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortField.value = field;
    sortOrder.value = 'desc';
  }
  currentPage.value = 1;
  loadUsers();
}

function sortIcon(field) {
  if (sortField.value !== field) return '↕';
  return sortOrder.value === 'asc' ? '↑' : '↓';
}

const totalPages = ref(0);
watch(() => admin.usersTotal, (val) => {
  totalPages.value = Math.ceil(val / pageLimit);
});

function goPage(p) {
  if (p < 1 || p > totalPages.value) return;
  currentPage.value = p;
  loadUsers();
}

// ── Форматирование ─────────────────────────────────────────────────
function fmtDate(dt) {
  if (!dt) return '—';
  return new Date(dt).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtCost(usd) {
  if (!usd || parseFloat(usd) === 0) return '—';
  return '$' + parseFloat(usd).toFixed(4);
}
</script>

<template>
  <AdminLayout>
    <div class="max-w-7xl mx-auto px-6 py-6">
      <h1 class="text-2xl font-bold text-white mb-6">📊 Панель мониторинга</h1>

      <!-- Статистика (карточки) -->
      <div v-if="admin.stats" class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-8">
        <div class="card text-center">
          <div class="text-2xl font-bold text-white">{{ admin.stats.total_users }}</div>
          <div class="text-xs text-gray-400 mt-1">Всего пользователей</div>
        </div>
        <div class="card text-center">
          <div class="text-2xl font-bold text-emerald-400">{{ admin.stats.users_today }}</div>
          <div class="text-xs text-gray-400 mt-1">Новых сегодня</div>
        </div>
        <div class="card text-center">
          <div class="text-2xl font-bold text-blue-400">{{ admin.stats.users_this_week }}</div>
          <div class="text-xs text-gray-400 mt-1">За неделю</div>
        </div>
        <div class="card text-center">
          <div class="text-2xl font-bold text-purple-400">{{ admin.stats.users_this_month }}</div>
          <div class="text-xs text-gray-400 mt-1">За месяц</div>
        </div>
        <div class="card text-center">
          <div class="text-2xl font-bold text-amber-400">{{ admin.stats.total_tasks }}</div>
          <div class="text-xs text-gray-400 mt-1">Всего задач</div>
        </div>
        <div class="card text-center">
          <div class="text-2xl font-bold text-green-400">{{ admin.stats.tasks_completed }}</div>
          <div class="text-xs text-gray-400 mt-1">Завершённых</div>
        </div>
        <div class="card text-center">
          <div class="text-2xl font-bold text-yellow-400">{{ admin.stats.tasks_processing }}</div>
          <div class="text-xs text-gray-400 mt-1">В процессе</div>
        </div>
        <div class="card text-center">
          <div class="text-2xl font-bold text-red-400">{{ admin.stats.tasks_failed }}</div>
          <div class="text-xs text-gray-400 mt-1">Ошибок</div>
        </div>
        <div class="card text-center">
          <div class="text-2xl font-bold text-cyan-400">{{ fmtCost(admin.stats.total_cost_usd) }}</div>
          <div class="text-xs text-gray-400 mt-1">Общие затраты</div>
        </div>
        <div class="card text-center">
          <div class="text-lg font-bold text-white">
            LSI {{ admin.stats.avg_lsi_coverage }}%
            <span class="text-gray-500 mx-1">|</span>
            E-E-A-T {{ admin.stats.avg_eeat_score }}
          </div>
          <div class="text-xs text-gray-400 mt-1">Средние метрики</div>
        </div>
      </div>

      <!-- Поиск -->
      <div class="flex items-center gap-4 mb-4">
        <input
          v-model="search"
          type="text"
          class="input max-w-sm focus:ring-emerald-500"
          placeholder="🔍 Поиск по email или имени..."
        />
        <span class="text-sm text-gray-500">
          Найдено: {{ admin.usersTotal }}
        </span>
      </div>

      <!-- Таблица пользователей -->
      <div class="card overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-gray-800 text-left">
              <th class="py-3 px-3 text-gray-400 font-medium cursor-pointer select-none hover:text-gray-200" @click="handleSort('email')">
                Email {{ sortIcon('email') }}
              </th>
              <th class="py-3 px-3 text-gray-400 font-medium cursor-pointer select-none hover:text-gray-200" @click="handleSort('name')">
                Имя {{ sortIcon('name') }}
              </th>
              <th class="py-3 px-3 text-gray-400 font-medium cursor-pointer select-none hover:text-gray-200" @click="handleSort('created_at')">
                Регистрация {{ sortIcon('created_at') }}
              </th>
              <th class="py-3 px-3 text-gray-400 font-medium cursor-pointer select-none hover:text-gray-200" @click="handleSort('tasks_total')">
                Задач {{ sortIcon('tasks_total') }}
              </th>
              <th class="py-3 px-3 text-gray-400 font-medium">Завершено</th>
              <th class="py-3 px-3 text-gray-400 font-medium">Ошибок</th>
              <th class="py-3 px-3 text-gray-400 font-medium">Последняя задача</th>
              <th class="py-3 px-3 text-gray-400 font-medium cursor-pointer select-none hover:text-gray-200" @click="handleSort('total_cost_usd')">
                Затраты {{ sortIcon('total_cost_usd') }}
              </th>
              <th class="py-3 px-3 text-gray-400 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="u in admin.users"
              :key="u.id"
              class="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors"
            >
              <td class="py-3 px-3 text-gray-200">{{ u.email }}</td>
              <td class="py-3 px-3 text-gray-300">{{ u.name || '—' }}</td>
              <td class="py-3 px-3 text-gray-400">{{ fmtDate(u.created_at) }}</td>
              <td class="py-3 px-3 text-gray-200 font-medium">{{ u.tasks_total }}</td>
              <td class="py-3 px-3 text-green-400">{{ u.tasks_completed }}</td>
              <td class="py-3 px-3 text-red-400">{{ u.tasks_failed }}</td>
              <td class="py-3 px-3 text-gray-400">{{ fmtDate(u.last_task_at) }}</td>
              <td class="py-3 px-3 text-gray-300">{{ fmtCost(u.total_cost_usd) }}</td>
              <td class="py-3 px-3">
                <router-link
                  :to="`/admin/users/${u.id}`"
                  class="text-emerald-400 hover:text-emerald-300 text-xs font-medium transition-colors"
                >
                  Подробнее →
                </router-link>
              </td>
            </tr>
            <tr v-if="!admin.users.length && !admin.loading">
              <td colspan="9" class="py-8 text-center text-gray-500">
                Пользователи не найдены
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Пагинация -->
      <div v-if="totalPages > 1" class="flex items-center justify-center gap-2 mt-4">
        <button
          class="btn-ghost text-xs"
          :disabled="currentPage <= 1"
          @click="goPage(currentPage - 1)"
        >
          ← Назад
        </button>
        <span class="text-sm text-gray-400">
          Страница {{ currentPage }} из {{ totalPages }}
        </span>
        <button
          class="btn-ghost text-xs"
          :disabled="currentPage >= totalPages"
          @click="goPage(currentPage + 1)"
        >
          Вперёд →
        </button>
      </div>

      <!-- Загрузка -->
      <div v-if="admin.loading" class="flex justify-center py-8">
        <svg class="animate-spin w-8 h-8 text-emerald-500" viewBox="0 0 24 24" fill="none">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
        </svg>
      </div>
    </div>
  </AdminLayout>
</template>
