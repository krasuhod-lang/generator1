<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { useTasksStore } from '../stores/tasks.js';
import ResultModal from '../components/ResultModal.vue';

const router = useRouter();
const auth   = useAuthStore();
const store  = useTasksStore();

// ── Модалка результатов ────────────────────────────────────────────
const showResult     = ref(false);
const resultTaskId   = ref(null);

function openResult(task) {
  resultTaskId.value = task.id;
  showResult.value   = true;
}

function closeResult() {
  showResult.value   = false;
  resultTaskId.value = null;
}

// Инлайн ошибка (заменяет alert)
const errorMsg = ref(null);
function showError(msg) {
  errorMsg.value = msg;
  setTimeout(() => { errorMsg.value = null; }, 6000);
}

// Автообновление каждые 5 секунд
let pollTimer = null;

onMounted(async () => {
  await store.fetchTasks();
  pollTimer = setInterval(store.fetchTasks, 5000);
});

onUnmounted(() => clearInterval(pollTimer));

// ── Действия ───────────────────────────────────────────────────────
async function handleStart(task) {
  try {
    await store.startTask(task.id);
    router.push(`/tasks/${task.id}/monitor`);
  } catch (e) {
    showError(e.response?.data?.error || 'Ошибка запуска задачи');
  }
}

async function handleDelete(task) {
  if (!confirm(`Удалить задачу "${task.title || task.input_target_service}"?`)) return;
  try {
    await store.deleteTask(task.id);
  } catch (e) {
    showError(e.response?.data?.error || 'Ошибка удаления');
  }
}

function handleLogout() {
  auth.logout();
  router.push('/login');
}

// ── Бейдж статуса ──────────────────────────────────────────────────
const STATUS_META = {
  draft:      { label: 'Черновик',     cls: 'bg-gray-700 text-gray-300' },
  queued:     { label: 'В очереди',    cls: 'bg-yellow-900 text-yellow-300 animate-pulse' },
  processing: { label: 'Выполняется',  cls: 'bg-indigo-900 text-indigo-300 animate-pulse' },
  completed:  { label: 'Завершена',    cls: 'bg-green-900 text-green-300' },
  failed:     { label: 'Ошибка',       cls: 'bg-red-900 text-red-300' },
};

function statusMeta(status) {
  return STATUS_META[status] || { label: status, cls: 'bg-gray-700 text-gray-400' };
}

function fmtDate(dt) {
  if (!dt) return '—';
  return new Date(dt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmtCost(usd) {
  if (!usd) return '—';
  return '$' + parseFloat(usd).toFixed(4);
}
</script>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 0.25s ease; }
.fade-enter-from, .fade-leave-to        { opacity: 0; }
</style>

<template>
  <div class="min-h-screen bg-gray-950">
    <!-- Шапка -->
    <header class="border-b border-gray-800 bg-gray-900 px-6 py-3 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <svg viewBox="0 0 32 32" class="w-7 h-7" fill="none">
          <rect width="32" height="32" rx="8" fill="#6366f1"/>
          <path d="M8 16a8 8 0 1 1 10.6 7.6" stroke="white" stroke-width="2" stroke-linecap="round"/>
          <circle cx="16" cy="16" r="3" fill="white"/>
          <path d="M22 22l4 4" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
        </svg>
        <span class="font-bold text-white">SEO Genius <span class="text-indigo-400">v4.0</span></span>
      </div>
      <div class="flex items-center gap-4">
        <span class="text-sm text-gray-400">{{ auth.user?.name || auth.user?.email }}</span>
        <button @click="handleLogout" class="btn-ghost text-xs">Выйти</button>
      </div>
    </header>

    <!-- Инлайн ошибка -->
    <transition name="fade">
      <div
        v-if="errorMsg"
        class="max-w-7xl mx-auto px-6 pt-4"
      >
        <div class="flex items-start gap-3 bg-red-950/70 border border-red-800 text-red-300 rounded-lg px-4 py-3 text-sm">
          <svg class="w-4 h-4 mt-0.5 flex-shrink-0 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
          </svg>
          <span class="flex-1">{{ errorMsg }}</span>
          <button
            class="text-red-500 hover:text-red-300 transition-colors ml-2 flex-shrink-0"
            @click="errorMsg = null"
            aria-label="Закрыть"
          >✕</button>
        </div>
      </div>
    </transition>

    <!-- Контент -->
    <main class="max-w-7xl mx-auto px-6 py-8">
      <!-- Заголовок + кнопка -->
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-xl font-bold text-white">Мои задачи</h1>
          <p class="text-sm text-gray-500 mt-0.5">{{ store.tasks.length }} задач</p>
        </div>
        <RouterLink to="/tasks/new" class="btn-primary">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
          </svg>
          Создать задачу
        </RouterLink>
      </div>

      <!-- Загрузка -->
      <div v-if="store.loading && !store.tasks.length" class="flex items-center justify-center py-20 text-gray-500">
        <svg class="animate-spin w-6 h-6 mr-3" viewBox="0 0 24 24" fill="none">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
        </svg>
        Загрузка задач...
      </div>

      <!-- Пусто -->
      <div v-else-if="!store.tasks.length" class="card text-center py-16">
        <div class="text-5xl mb-4">🚀</div>
        <p class="text-gray-400 text-lg font-medium">Задач пока нет</p>
        <p class="text-gray-600 text-sm mt-1 mb-5">Создайте первую задачу и запустите генерацию SEO-контента</p>
        <RouterLink to="/tasks/new" class="btn-primary inline-flex">Создать задачу</RouterLink>
      </div>

      <!-- Таблица -->
      <div v-else class="card overflow-hidden p-0">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-gray-800 text-left">
              <th class="px-5 py-3 text-gray-500 font-medium w-6">#</th>
              <th class="px-5 py-3 text-gray-500 font-medium">Задача</th>
              <th class="px-5 py-3 text-gray-500 font-medium">Статус</th>
              <th class="px-5 py-3 text-gray-500 font-medium">Создана</th>
              <th class="px-5 py-3 text-gray-500 font-medium">Стоимость</th>
              <th class="px-5 py-3 text-gray-500 font-medium text-right">Действия</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(task, idx) in store.tasks"
              :key="task.id"
              class="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors"
            >
              <!-- № -->
              <td class="px-5 py-3.5 text-gray-600">{{ idx + 1 }}</td>

              <!-- Название -->
              <td class="px-5 py-3.5">
                <p class="text-white font-medium truncate max-w-xs">
                  {{ task.title || task.input_target_service }}
                </p>
                <p v-if="task.lsi_coverage" class="text-xs text-gray-500 mt-0.5">
                  LSI {{ task.lsi_coverage }}% · E-E-A-T {{ task.eeat_score }}
                </p>
              </td>

              <!-- Статус -->
              <td class="px-5 py-3.5">
                <span :class="['badge', statusMeta(task.status).cls]">
                  {{ statusMeta(task.status).label }}
                </span>
              </td>

              <!-- Дата -->
              <td class="px-5 py-3.5 text-gray-400 whitespace-nowrap">
                {{ fmtDate(task.created_at) }}
              </td>

              <!-- Стоимость -->
              <td class="px-5 py-3.5 font-mono text-indigo-400">
                {{ fmtCost(task.total_cost_usd) }}
              </td>

              <!-- Кнопки действий -->
              <td class="px-5 py-3.5">
                <div class="flex items-center gap-1.5 justify-end flex-wrap">
                  <!-- Запустить (только черновик / failed) -->
                  <button
                    v-if="task.status === 'draft' || task.status === 'failed'"
                    @click="handleStart(task)"
                    class="btn-primary text-xs px-3 py-1.5"
                    title="Запустить"
                  >
                    ▶ Запустить
                  </button>

                  <!-- Мониторинг (queued / processing) -->
                  <RouterLink
                    v-if="task.status === 'queued' || task.status === 'processing'"
                    :to="`/tasks/${task.id}/monitor`"
                    class="btn-secondary text-xs px-3 py-1.5"
                  >
                    👁 Мониторинг
                  </RouterLink>

                  <!-- Результат (completed) -->
                  <button
                    v-if="task.status === 'completed'"
                    @click="openResult(task)"
                    class="btn-primary text-xs px-3 py-1.5"
                  >
                    📊 Результат
                  </button>

                  <!-- Редактировать (draft / failed) -->
                  <RouterLink
                    v-if="task.status === 'draft' || task.status === 'failed'"
                    :to="`/tasks/${task.id}/edit`"
                    class="btn-secondary text-xs px-3 py-1.5"
                    title="Редактировать"
                  >
                    ✏ Изменить
                  </RouterLink>

                  <!-- Удалить -->
                  <button
                    @click="handleDelete(task)"
                    class="btn-danger text-xs px-3 py-1.5"
                    title="Удалить"
                  >
                    🗑
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </main>

    <!-- Модалка результатов -->
    <ResultModal
      :task-id="resultTaskId"
      :visible="showResult"
      @close="closeResult"
    />
  </div>
</template>
