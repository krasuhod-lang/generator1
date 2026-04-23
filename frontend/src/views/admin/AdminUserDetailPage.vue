<script setup>
import { ref, onMounted, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAdminStore } from '../../stores/admin.js';
import AdminLayout from '../../components/AdminLayout.vue';

const route  = useRoute();
const router = useRouter();
const admin  = useAdminStore();

const userId = route.params.id;

const userDetail   = ref(null);
const tasks        = ref([]);
const tasksTotal   = ref(0);
const currentPage  = ref(1);
const pageLimit    = 20;
const loading      = ref(true);
const error        = ref(null);

onMounted(async () => {
  try {
    const [user, tasksData] = await Promise.all([
      admin.fetchUserDetail(userId),
      admin.fetchUserTasks(userId, { page: 1, limit: pageLimit }),
    ]);
    userDetail.value = user;
    tasks.value      = tasksData.tasks;
    tasksTotal.value = tasksData.total;
  } catch (e) {
    error.value = e.response?.data?.error || 'Ошибка загрузки';
  } finally {
    loading.value = false;
  }
});

async function loadTasks() {
  const data = await admin.fetchUserTasks(userId, { page: currentPage.value, limit: pageLimit });
  tasks.value      = data.tasks;
  tasksTotal.value = data.total;
}

const totalPages = computed(() => Math.ceil(tasksTotal.value / pageLimit));

function goPage(p) {
  if (p < 1 || p > totalPages.value) return;
  currentPage.value = p;
  loadTasks();
}

// ── Статистика статусов (для простой визуализации) ──────────────────
const statusStats = computed(() => {
  if (!userDetail.value) return [];
  const u = userDetail.value;
  return [
    { label: 'Завершено', count: u.tasks_completed, color: 'bg-green-500' },
    { label: 'Ошибок',    count: u.tasks_failed,    color: 'bg-red-500' },
    { label: 'В процессе', count: u.tasks_processing, color: 'bg-yellow-500' },
    { label: 'В очереди',  count: u.tasks_queued,     color: 'bg-blue-500' },
    { label: 'Черновики',  count: u.tasks_draft,      color: 'bg-gray-500' },
  ];
});

const barTotal = computed(() => {
  return statusStats.value.reduce((s, v) => s + v.count, 0) || 1;
});

// ── Дни с регистрации ──────────────────────────────────────────────
const daysSinceRegistration = computed(() => {
  if (!userDetail.value?.created_at) return 0;
  const diff = Date.now() - new Date(userDetail.value.created_at).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
});

// ── Форматирование ─────────────────────────────────────────────────
const STATUS_META = {
  draft:      { label: 'Черновик',     cls: 'bg-gray-700 text-gray-300' },
  queued:     { label: 'В очереди',    cls: 'bg-yellow-900 text-yellow-300' },
  processing: { label: 'Выполняется',  cls: 'bg-indigo-900 text-indigo-300' },
  completed:  { label: 'Завершена',    cls: 'bg-green-900 text-green-300' },
  failed:     { label: 'Ошибка',       cls: 'bg-red-900 text-red-300' },
};

function statusMeta(status) {
  return STATUS_META[status] || { label: status, cls: 'bg-gray-700 text-gray-400' };
}

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

      <!-- Назад -->
      <button @click="router.push('/admin')" class="btn-ghost text-xs mb-4">
        ← Назад к списку
      </button>

      <!-- Загрузка / Ошибка -->
      <div v-if="loading" class="flex justify-center py-16">
        <svg class="animate-spin w-8 h-8 text-emerald-500" viewBox="0 0 24 24" fill="none">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
        </svg>
      </div>

      <div v-else-if="error" class="bg-red-950 border border-red-800 text-red-400 text-sm px-4 py-3 rounded-lg">
        {{ error }}
      </div>

      <template v-else-if="userDetail">
        <!-- Карточка пользователя -->
        <div class="card mb-6">
          <div class="flex flex-col sm:flex-row sm:items-center gap-4">
            <div class="w-12 h-12 rounded-full bg-emerald-900 flex items-center justify-center text-emerald-300 text-xl font-bold flex-shrink-0">
              {{ (userDetail.name || userDetail.email)[0].toUpperCase() }}
            </div>
            <div class="flex-1">
              <h2 class="text-xl font-bold text-white">{{ userDetail.name || 'Без имени' }}</h2>
              <p class="text-gray-400 text-sm">{{ userDetail.email }}</p>
            </div>
            <div class="flex gap-6 text-sm">
              <div>
                <span class="text-gray-500">Регистрация:</span>
                <span class="text-gray-300 ml-1">{{ fmtDate(userDetail.created_at) }}</span>
              </div>
              <div>
                <span class="text-gray-500">Дней в системе:</span>
                <span class="text-gray-300 ml-1">{{ daysSinceRegistration }}</span>
              </div>
              <div>
                <span class="text-gray-500">Роль:</span>
                <span class="text-gray-300 ml-1">{{ userDetail.role }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Статистика задач: бар -->
        <div class="card mb-6">
          <h3 class="text-sm font-medium text-gray-400 uppercase tracking-wide mb-4">Статистика задач</h3>
          <div class="flex items-center gap-6 mb-4">
            <div v-for="s in statusStats" :key="s.label" class="flex items-center gap-2">
              <span class="w-3 h-3 rounded-full" :class="s.color"></span>
              <span class="text-xs text-gray-400">{{ s.label }}: <span class="text-white font-medium">{{ s.count }}</span></span>
            </div>
          </div>
          <!-- Визуальный бар -->
          <div class="flex h-4 rounded-full overflow-hidden bg-gray-800">
            <div
              v-for="s in statusStats"
              :key="s.label"
              :class="s.color"
              :style="{ width: (s.count / barTotal * 100) + '%' }"
              class="transition-all duration-300"
            ></div>
          </div>
          <div class="mt-3 text-sm text-gray-400">
            Общая стоимость генерации: <span class="text-white font-medium">{{ fmtCost(userDetail.total_cost_usd) }}</span>
          </div>
        </div>

        <!-- Таблица задач -->
        <div class="card overflow-x-auto">
          <h3 class="text-sm font-medium text-gray-400 uppercase tracking-wide mb-4">Задачи пользователя ({{ tasksTotal }})</h3>
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-gray-800 text-left">
                <th class="py-3 px-3 text-gray-400 font-medium">Название</th>
                <th class="py-3 px-3 text-gray-400 font-medium">H1 / Услуга</th>
                <th class="py-3 px-3 text-gray-400 font-medium">Статус</th>
                <th class="py-3 px-3 text-gray-400 font-medium">Создана</th>
                <th class="py-3 px-3 text-gray-400 font-medium">Завершена</th>
                <th class="py-3 px-3 text-gray-400 font-medium">LSI%</th>
                <th class="py-3 px-3 text-gray-400 font-medium">E-E-A-T</th>
                <th class="py-3 px-3 text-gray-400 font-medium">Стоимость</th>
                <th class="py-3 px-3 text-gray-400 font-medium">Ошибка</th>
                <th class="py-3 px-3 text-gray-400 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="t in tasks"
                :key="t.id"
                class="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors"
              >
                <td class="py-3 px-3 text-gray-200 max-w-[200px] truncate">{{ t.title || '—' }}</td>
                <td class="py-3 px-3 text-gray-300 max-w-[200px] truncate">{{ t.input_target_service || '—' }}</td>
                <td class="py-3 px-3">
                  <span class="badge" :class="statusMeta(t.status).cls">
                    {{ statusMeta(t.status).label }}
                  </span>
                </td>
                <td class="py-3 px-3 text-gray-400">{{ fmtDate(t.created_at) }}</td>
                <td class="py-3 px-3 text-gray-400">{{ fmtDate(t.completed_at) }}</td>
                <td class="py-3 px-3">
                  <span :class="parseFloat(t.lsi_coverage) >= 80 ? 'text-green-400' : 'text-yellow-400'">
                    {{ t.lsi_coverage ? parseFloat(t.lsi_coverage).toFixed(1) + '%' : '—' }}
                  </span>
                </td>
                <td class="py-3 px-3">
                  <span :class="parseFloat(t.eeat_score) >= 8 ? 'text-green-400' : 'text-yellow-400'">
                    {{ t.eeat_score ? parseFloat(t.eeat_score).toFixed(1) : '—' }}
                  </span>
                </td>
                <td class="py-3 px-3 text-gray-300">{{ fmtCost(t.total_cost_usd) }}</td>
                <td class="py-3 px-3 text-red-400 max-w-[200px] truncate" :title="t.error_message">
                  {{ t.error_message || '—' }}
                </td>
                <td class="py-3 px-3">
                  <button
                    class="btn-ghost text-xs"
                    @click="router.push(`/admin/tasks/${t.id}`)"
                    title="Открыть подробности задачи (результат + логи)"
                  >Открыть</button>
                </td>
              </tr>
              <tr v-if="!tasks.length">
                <td colspan="10" class="py-8 text-center text-gray-500">У пользователя нет задач</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Пагинация -->
        <div v-if="totalPages > 1" class="flex items-center justify-center gap-2 mt-4">
          <button class="btn-ghost text-xs" :disabled="currentPage <= 1" @click="goPage(currentPage - 1)">
            ← Назад
          </button>
          <span class="text-sm text-gray-400">Страница {{ currentPage }} из {{ totalPages }}</span>
          <button class="btn-ghost text-xs" :disabled="currentPage >= totalPages" @click="goPage(currentPage + 1)">
            Вперёд →
          </button>
        </div>
      </template>

    </div>
  </AdminLayout>
</template>
