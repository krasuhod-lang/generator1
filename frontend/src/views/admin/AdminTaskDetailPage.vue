<script setup>
/**
 * AdminTaskDetailPage — детальный просмотр одной задачи администратором.
 * Точка входа из AdminUserDetailPage (кнопка «Открыть» в таблице задач).
 *
 * Включает три вкладки:
 *   1. Результат — отрендеренный final_html + JSON метрик
 *   2. Логи      — таблица из task_logs (фильтр по уровню + поиск)
 *   3. Контекст  — AKB / strategy / unused_inputs (если хранятся)
 *
 * Все запросы идут через /api/admin/tasks/* (admin auth, без user_id check).
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAdminStore } from '../../stores/admin.js';
import AdminLayout from '../../components/AdminLayout.vue';

const route   = useRoute();
const router  = useRouter();
const admin   = useAdminStore();
const taskId  = route.params.id;

const task    = ref(null);
const loading = ref(true);
const error   = ref(null);

const activeTab = ref('result'); // 'result' | 'logs' | 'context'

// Логи
const logs        = ref([]);
const logFilter   = ref('all'); // all | info | warn | error
const logSearch   = ref('');
const logsLoading = ref(false);
let lastLogId     = 0;
let logsPollTimer = null;

const filteredLogs = computed(() => {
  const search = logSearch.value.trim().toLowerCase();
  return logs.value.filter((l) => {
    if (logFilter.value !== 'all' && l.level !== logFilter.value) return false;
    if (search && !(`${l.message || ''} ${l.stage || ''}`).toLowerCase().includes(search)) return false;
    return true;
  });
});

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('ru-RU');
}
function fmtCost(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return '$' + n.toFixed(4);
}
function levelClass(level) {
  switch ((level || '').toLowerCase()) {
    case 'error':   return 'bg-red-900/30 text-red-300';
    case 'warn':    return 'bg-yellow-900/30 text-yellow-300';
    case 'success': return 'bg-green-900/30 text-green-300';
    default:        return 'bg-gray-800/40 text-gray-300';
  }
}

// Безопасный рендер HTML — final_html уже прошёл санитизацию на стороне
// бэкенда в Stage 7. Дополнительный sanitize здесь не делаем, чтобы не
// сломать визуальное совпадение с тем, что отдаётся пользователю.
const finalHtml = computed(() => {
  return task.value?.final_html_edited || task.value?.final_html || '';
});

const metricsJson = computed(() => {
  if (!task.value) return '';
  const m = {
    lsi_coverage:        task.value.lsi_coverage,
    eeat_score:          task.value.eeat_score,
    naturalness_score:   task.value.naturalness_score,
    total_tokens:        task.value.total_tokens,
    total_cost_usd:      task.value.total_cost_usd,
    deepseek_tokens_in:  task.value.deepseek_tokens_in,
    deepseek_tokens_out: task.value.deepseek_tokens_out,
    deepseek_cost_usd:   task.value.deepseek_cost_usd,
    gemini_tokens_in:    task.value.gemini_tokens_in,
    gemini_tokens_out:   task.value.gemini_tokens_out,
    gemini_cost_usd:     task.value.gemini_cost_usd,
  };
  return JSON.stringify(m, null, 2);
});

const unusedInputsJson = computed(() => {
  const u = task.value?.unused_inputs;
  if (!u) return '';
  try { return JSON.stringify(typeof u === 'string' ? JSON.parse(u) : u, null, 2); }
  catch (_) { return String(u); }
});

const strategyJson = computed(() => {
  const s = task.value?.strategy_context;
  if (!s) return '';
  try { return JSON.stringify(typeof s === 'string' ? JSON.parse(s) : s, null, 2); }
  catch (_) { return String(s); }
});

async function loadTask() {
  loading.value = true;
  try {
    task.value = await admin.fetchAdminTask(taskId);
  } catch (e) {
    error.value = e.response?.data?.error || e.message || 'Ошибка загрузки задачи';
  } finally {
    loading.value = false;
  }
}

async function loadLogsIncremental() {
  if (logsLoading.value) return;
  logsLoading.value = true;
  try {
    const data = await admin.fetchAdminTaskLogs(taskId, { after: lastLogId || null, limit: 1000 });
    if (data.logs?.length) {
      logs.value.push(...data.logs);
      lastLogId = data.logs[data.logs.length - 1].id;
      // Cap history at 5000 entries to keep DOM responsive
      if (logs.value.length > 5000) logs.value.splice(0, logs.value.length - 5000);
    }
  } catch (e) {
    // Silent — logs are best-effort
  } finally {
    logsLoading.value = false;
  }
}

function startLogsPolling() {
  if (logsPollTimer) return;
  // Poll every 3s while task is processing — stop when terminal.
  logsPollTimer = setInterval(() => {
    if (task.value && (task.value.status === 'completed' || task.value.status === 'failed')) {
      clearInterval(logsPollTimer);
      logsPollTimer = null;
      return;
    }
    loadLogsIncremental();
  }, 3000);
}

onMounted(async () => {
  await loadTask();
  await loadLogsIncremental();
  startLogsPolling();
});

onUnmounted(() => {
  if (logsPollTimer) { clearInterval(logsPollTimer); logsPollTimer = null; }
});

const STATUS_CLS = {
  draft:      'bg-gray-800 text-gray-300',
  pending:    'bg-blue-900 text-blue-300',
  processing: 'bg-indigo-900 text-indigo-300',
  completed:  'bg-green-900 text-green-300',
  failed:     'bg-red-900 text-red-300',
};
function statusCls(s) { return STATUS_CLS[s] || STATUS_CLS.draft; }
</script>

<template>
  <AdminLayout>
    <div class="px-6 py-6">
      <button @click="router.back()" class="btn-ghost text-xs mb-4">← Назад</button>

      <div v-if="loading" class="text-center py-20 text-gray-500">Загрузка...</div>
      <div v-else-if="error" class="bg-red-950 border border-red-800 text-red-400 px-4 py-3 rounded">
        {{ error }}
      </div>

      <template v-else-if="task">
        <!-- Шапка -->
        <div class="card mb-4">
          <div class="flex items-start gap-4 flex-wrap">
            <div class="flex-1 min-w-0">
              <h1 class="text-xl font-semibold text-white truncate">
                {{ task.title || task.input_target_service || 'Без названия' }}
              </h1>
              <p class="text-sm text-gray-400 mt-1 truncate">{{ task.input_target_service }}</p>
              <p class="text-xs text-gray-500 mt-2">
                Юзер: <span class="text-gray-300">{{ task.user_email }}</span>
                <span class="mx-2">·</span>
                ID: <span class="font-mono text-gray-400">{{ task.id }}</span>
              </p>
            </div>
            <div class="flex flex-col items-end gap-1">
              <span class="badge" :class="statusCls(task.status)">{{ task.status }}</span>
              <span
                v-if="task.llm_provider"
                class="badge"
                :class="task.llm_provider === 'grok' ? 'bg-purple-900 text-purple-300' : 'bg-blue-900 text-blue-300'"
              >{{ task.llm_provider === 'grok' ? 'Grok' : 'Gemini' }}</span>
              <span class="text-xs text-gray-500">{{ fmtDate(task.created_at) }}</span>
            </div>
          </div>

          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
            <div class="bg-gray-800/40 rounded p-2 text-center">
              <div class="text-xs text-gray-500">Стоимость</div>
              <div class="text-sm text-white font-semibold">{{ fmtCost(task.total_cost_usd) }}</div>
            </div>
            <div class="bg-gray-800/40 rounded p-2 text-center">
              <div class="text-xs text-gray-500">Токенов всего</div>
              <div class="text-sm text-white font-semibold">{{ task.total_tokens || '—' }}</div>
            </div>
            <div class="bg-gray-800/40 rounded p-2 text-center">
              <div class="text-xs text-gray-500">LSI %</div>
              <div class="text-sm text-white font-semibold">
                {{ task.lsi_coverage != null ? Number(task.lsi_coverage).toFixed(1) + '%' : '—' }}
              </div>
            </div>
            <div class="bg-gray-800/40 rounded p-2 text-center">
              <div class="text-xs text-gray-500">E-E-A-T</div>
              <div class="text-sm text-white font-semibold">
                {{ task.eeat_score != null ? Number(task.eeat_score).toFixed(1) : '—' }}
              </div>
            </div>
          </div>
        </div>

        <!-- Табы -->
        <div class="flex gap-2 border-b border-gray-800 mb-4">
          <button
            v-for="tab in [
              { id: 'result',  label: 'Результат' },
              { id: 'logs',    label: `Логи (${logs.length})` },
              { id: 'context', label: 'Промпты / контекст' },
            ]"
            :key="tab.id"
            @click="activeTab = tab.id"
            class="px-4 py-2 text-sm transition-colors"
            :class="activeTab === tab.id
              ? 'text-white border-b-2 border-indigo-500'
              : 'text-gray-400 hover:text-gray-200'"
          >{{ tab.label }}</button>
        </div>

        <!-- Tab: Результат -->
        <div v-if="activeTab === 'result'" class="space-y-4">
          <div v-if="!finalHtml" class="card text-gray-500 text-center py-10">
            Финальный HTML ещё не сгенерирован.
          </div>
          <template v-else>
            <div class="card">
              <div class="text-xs text-gray-500 mb-2">Отрендеренный HTML</div>
              <div class="bg-white text-gray-900 rounded p-5 prose prose-sm max-w-none" v-html="finalHtml" />
            </div>
            <div class="card">
              <div class="text-xs text-gray-500 mb-2">Метрики</div>
              <pre class="text-xs text-gray-300 font-mono overflow-x-auto whitespace-pre">{{ metricsJson }}</pre>
            </div>
            <div v-if="unusedInputsJson" class="card">
              <div class="text-xs text-gray-500 mb-2">Не использовано (unused_inputs)</div>
              <pre class="text-xs text-gray-300 font-mono overflow-x-auto whitespace-pre max-h-96">{{ unusedInputsJson }}</pre>
            </div>
          </template>
        </div>

        <!-- Tab: Логи -->
        <div v-if="activeTab === 'logs'" class="card">
          <div class="flex items-center gap-3 mb-3 flex-wrap">
            <select v-model="logFilter" class="input text-sm" style="max-width:160px">
              <option value="all">Все уровни</option>
              <option value="info">info</option>
              <option value="warn">warn</option>
              <option value="error">error</option>
              <option value="success">success</option>
            </select>
            <input
              v-model="logSearch"
              type="text"
              class="input text-sm flex-1"
              placeholder="Поиск по сообщению или stage..."
            />
            <button class="btn-ghost text-xs" @click="loadLogsIncremental" :disabled="logsLoading">
              {{ logsLoading ? '...' : '↻ Обновить' }}
            </button>
          </div>
          <div class="overflow-x-auto max-h-[600px] overflow-y-auto">
            <table class="w-full text-xs">
              <thead class="sticky top-0 bg-gray-900">
                <tr class="text-left text-gray-500">
                  <th class="py-2 px-2 w-32">Время</th>
                  <th class="py-2 px-2 w-20">Level</th>
                  <th class="py-2 px-2 w-32">Stage</th>
                  <th class="py-2 px-2">Сообщение</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="l in filteredLogs" :key="l.id" class="border-b border-gray-800/40">
                  <td class="py-1 px-2 text-gray-400 font-mono">{{ fmtDate(l.ts) }}</td>
                  <td class="py-1 px-2">
                    <span class="badge text-[10px]" :class="levelClass(l.level)">{{ l.level || '—' }}</span>
                  </td>
                  <td class="py-1 px-2 text-gray-300">{{ l.stage || '—' }}</td>
                  <td class="py-1 px-2 text-gray-200 whitespace-pre-wrap break-words">{{ l.message }}</td>
                </tr>
                <tr v-if="!filteredLogs.length">
                  <td colspan="4" class="text-center text-gray-500 py-6">
                    {{ logs.length ? 'Нет логов под фильтр' : 'Логов нет' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Tab: Промпты / контекст -->
        <div v-if="activeTab === 'context'" class="space-y-4">
          <div v-if="strategyJson" class="card">
            <div class="text-xs text-gray-500 mb-2">Strategy context (Pre-Stage 0)</div>
            <pre class="text-xs text-gray-300 font-mono overflow-x-auto max-h-96 whitespace-pre">{{ strategyJson }}</pre>
          </div>
          <div v-if="task.input_brand_facts" class="card">
            <div class="text-xs text-gray-500 mb-2">Brand facts (input)</div>
            <pre class="text-xs text-gray-300 font-mono overflow-x-auto max-h-96 whitespace-pre-wrap">{{ task.input_brand_facts }}</pre>
          </div>
          <div v-if="task.input_raw_lsi" class="card">
            <div class="text-xs text-gray-500 mb-2">LSI (input)</div>
            <pre class="text-xs text-gray-300 font-mono overflow-x-auto max-h-96 whitespace-pre-wrap">{{ task.input_raw_lsi }}</pre>
          </div>
          <div v-if="!strategyJson && !task.input_brand_facts && !task.input_raw_lsi"
               class="card text-gray-500 text-center py-10">
            Контекстные данные недоступны.
          </div>
        </div>
      </template>
    </div>
  </AdminLayout>
</template>
