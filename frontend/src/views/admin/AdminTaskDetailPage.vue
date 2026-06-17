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
import DOMPurify from 'dompurify';

const route   = useRoute();
const router  = useRouter();
const admin   = useAdminStore();
const taskId  = route.params.id;
// ?source=seo|meta_tag|link_article|article_topic|info_article|relevance|forecaster
// Если параметр отсутствует — задача считается legacy SEO и грузится через /tasks/:id.
const source  = (route.query.source || 'seo').toString();

const task    = ref(null);
const sourceLabel = ref('');
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

// Финальный HTML — собираем из подходящих полей в зависимости от модуля.
// SEO → final_html / full_html; link_article/info_article → article_html;
// article_topic → result_markdown (рендерим как `<pre>` в шаблоне);
// остальные модули HTML не имеют.
const finalHtml = computed(() => {
  const t = task.value;
  if (!t) return '';
  return (
    t.final_html_edited ||
    t.final_html ||
    t.full_html ||
    t.article_html ||
    ''
  );
});

const resultMarkdown = computed(() => {
  return task.value?.result_markdown || '';
});

const isSeoSource = computed(() => source === 'seo');

const metricsJson = computed(() => {
  if (!task.value) return '';
  const m = {
    lsi_coverage:        task.value.lsi_coverage,
    eeat_score:          task.value.eeat_score,
    total_tokens:        task.value.total_tokens,
    total_cost_usd:      task.value.total_cost_usd,
    deepseek_tokens_in:  task.value.deepseek_tokens_in,
    deepseek_tokens_out: task.value.deepseek_tokens_out,
    deepseek_cost_usd:   task.value.deepseek_cost_usd,
    gemini_tokens_in:    task.value.gemini_tokens_in,
    gemini_tokens_out:   task.value.gemini_tokens_out,
    gemini_cost_usd:     task.value.gemini_cost_usd,
    grok_tokens_in:      task.value.grok_tokens_in,
    grok_tokens_out:     task.value.grok_tokens_out,
    grok_cost_usd:       task.value.grok_cost_usd,
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

// Дамп полной строки таблицы (полезно для не-SEO модулей, где результат
// сложно унифицировать одним viewer-ом). Скрывает заведомо тяжёлые поля.
const HEAVY_FIELDS = new Set([
  'full_html', 'final_html', 'final_html_edited', 'article_html', 'article_plain',
  'result_markdown', 'image_prompts', 'input_tz_parsed_json', 'input_brand_facts',
  'input_raw_lsi', 'input_ngrams', 'input_tfidf_json',
]);
const fullRowJson = computed(() => {
  if (!task.value) return '';
  const out = {};
  for (const [k, v] of Object.entries(task.value)) {
    if (HEAVY_FIELDS.has(k)) continue;
    out[k] = v;
  }
  try { return JSON.stringify(out, null, 2); }
  catch (_) { return ''; }
});

async function loadTask() {
  loading.value = true;
  try {
    if (isSeoSource.value) {
      task.value = await admin.fetchAdminTask(taskId);
      sourceLabel.value = 'SEO-текст';
    } else {
      const data = await admin.fetchAdminCrossTask(source, taskId);
      task.value = data.task;
      sourceLabel.value = data.sourceLabel || source;
    }
  } catch (e) {
    error.value = e.response?.data?.error || e.message || 'Ошибка загрузки задачи';
  } finally {
    loading.value = false;
  }
}

async function loadLogsIncremental() {
  if (logsLoading.value) return;
  // task_logs существуют только для SEO-задач; для остальных модулей пропускаем.
  if (!isSeoSource.value) return;
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
  // Logs polling — только для SEO (task_logs table). Не-SEO модули логов
  // в БД не имеют (есть только error_message + status).
  if (!isSeoSource.value) return;
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
  queued:     'bg-yellow-900 text-yellow-300',
  processing: 'bg-indigo-900 text-indigo-300',
  running:    'bg-indigo-900 text-indigo-300',
  completed:  'bg-green-900 text-green-300',
  done:       'bg-green-900 text-green-300',
  failed:     'bg-red-900 text-red-300',
  error:      'bg-red-900 text-red-300',
  cancelled:  'bg-gray-700 text-gray-400',
};
function statusCls(s) { return STATUS_CLS[s] || STATUS_CLS.draft; }

// Универсальный заголовок задачи — учитывает специфические поля каждого модуля.
const universalTitle = computed(() => {
  const t = task.value;
  if (!t) return '';
  return (
    t.title ||
    t.input_target_service ||
    t.topic ||
    t.name ||
    t.query ||
    t.trend_name ||
    t.niche ||
    t.source_filename ||
    'Без названия'
  );
});

// Подпись под заголовком — короткое описание входа.
const universalSubtitle = computed(() => {
  const t = task.value;
  if (!t) return '';
  if (source === 'seo')           return t.input_target_service || '';
  if (source === 'meta_tag')      return [t.niche, t.toponym].filter(Boolean).join(' · ');
  if (source === 'link_article')  return [t.anchor_text, t.anchor_url].filter(Boolean).join(' → ');
  if (source === 'article_topic') return [t.mode, t.niche, t.region].filter(Boolean).join(' · ');
  if (source === 'info_article')  return [t.topic, t.region].filter(Boolean).join(' · ');
  if (source === 'relevance')     return `LR=${t.lr || ''} · top_n=${t.top_n || ''}`;
  if (source === 'forecaster')    return t.source_filename || '';
  return '';
});
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
                {{ universalTitle }}
              </h1>
              <p v-if="universalSubtitle" class="text-sm text-gray-400 mt-1 truncate">{{ universalSubtitle }}</p>
              <p class="text-xs text-gray-500 mt-2">
                Юзер: <span class="text-gray-300">{{ task.user_email }}</span>
                <span class="mx-2">·</span>
                ID: <span class="font-mono text-gray-400">{{ task.id }}</span>
              </p>
            </div>
            <div class="flex flex-col items-end gap-1">
              <span class="badge bg-slate-800 text-slate-200">{{ sourceLabel }}</span>
              <span class="badge" :class="statusCls(task.status)">{{ task.status }}</span>
              <span
                v-if="task.llm_provider"
                class="badge"
                :class="task.llm_provider === 'grok' ? 'bg-purple-900 text-purple-300' : 'bg-blue-900 text-blue-300'"
              >{{ task.llm_provider === 'grok' ? 'Grok' : (task.llm_provider === 'deepseek' ? 'DeepSeek' : 'Gemini') }}</span>
              <span class="text-xs text-gray-500">{{ fmtDate(task.created_at) }}</span>
            </div>
          </div>

          <div v-if="isSeoSource" class="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
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
          <div v-else class="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
            <div class="bg-gray-800/40 rounded p-2 text-center">
              <div class="text-xs text-gray-500">Стоимость</div>
              <div class="text-sm text-white font-semibold">{{ fmtCost(task.cost_usd ?? task.total_cost_usd) }}</div>
            </div>
            <div class="bg-gray-800/40 rounded p-2 text-center">
              <div class="text-xs text-gray-500">Начало</div>
              <div class="text-sm text-white font-semibold">{{ fmtDate(task.started_at) }}</div>
            </div>
            <div class="bg-gray-800/40 rounded p-2 text-center">
              <div class="text-xs text-gray-500">Завершение</div>
              <div class="text-sm text-white font-semibold">{{ fmtDate(task.completed_at) }}</div>
            </div>
            <div class="bg-gray-800/40 rounded p-2 text-center">
              <div class="text-xs text-gray-500">Статус</div>
              <div class="text-sm text-white font-semibold">{{ task.status }}</div>
            </div>
          </div>
        </div>

        <!-- Табы -->
        <div class="flex gap-2 border-b border-gray-800 mb-4 flex-wrap">
          <button
            v-for="tab in [
              { id: 'result',  label: 'Результат', show: true },
              { id: 'logs',    label: `Логи (${logs.length})`, show: isSeoSource },
              { id: 'context', label: 'Промпты / контекст', show: isSeoSource },
              { id: 'raw',     label: 'Полные данные', show: true },
            ].filter(x => x.show)"
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
          <!-- HTML-результат (SEO / info_article / link_article) -->
          <template v-if="finalHtml">
            <div class="card">
              <div class="text-xs text-gray-500 mb-2">Отрендеренный HTML</div>
              <div class="bg-white text-gray-900 rounded p-5 prose prose-sm max-w-none" v-html="finalHtml" />
            </div>
          </template>
          <!-- Markdown-результат (article_topic) -->
          <template v-else-if="resultMarkdown">
            <div class="card">
              <div class="text-xs text-gray-500 mb-2">Результат (markdown)</div>
              <pre class="text-sm text-gray-200 whitespace-pre-wrap break-words max-h-[700px] overflow-y-auto">{{ resultMarkdown }}</pre>
            </div>
          </template>
          <!-- Иначе — короткое сообщение + ссылка на «Полные данные» -->
          <div v-else class="card text-gray-500 text-center py-10">
            <div class="mb-3">Этот модуль не имеет HTML-результата. Откройте вкладку «Полные данные» для просмотра содержимого задачи.</div>
            <div v-if="task.error_message" class="text-red-400 text-sm mt-3 text-left whitespace-pre-wrap">
              {{ task.error_message }}
            </div>
          </div>

          <!-- Метрики (только для SEO) -->
          <div v-if="isSeoSource && finalHtml" class="card">
            <div class="text-xs text-gray-500 mb-2">Метрики</div>
            <pre class="text-xs text-gray-300 font-mono overflow-x-auto whitespace-pre">{{ metricsJson }}</pre>
          </div>
          <div v-if="isSeoSource && unusedInputsJson" class="card">
            <div class="text-xs text-gray-500 mb-2">Не использовано (unused_inputs)</div>
            <pre class="text-xs text-gray-300 font-mono overflow-x-auto whitespace-pre max-h-96">{{ unusedInputsJson }}</pre>
          </div>
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

        <!-- Tab: Промпты / контекст (только для SEO) -->
        <div v-if="activeTab === 'context' && isSeoSource" class="space-y-4">
          <div v-if="strategyJson" class="card">
            <div class="text-xs text-gray-500 mb-2">Strategy context (Pre-Stage 0)</div>
            <pre class="text-xs text-gray-300 font-mono overflow-x-auto max-h-96 whitespace-pre">{{ strategyJson }}</pre>
          </div>
          <div v-if="task.input_brand_facts" class="card">
            <div class="text-xs text-gray-500 mb-2">Brand facts (input)</div>
            <div class="text-xs text-gray-300 overflow-x-auto max-h-96 prose prose-invert prose-sm max-w-none"
              v-html="DOMPurify.sanitize(task.input_brand_facts)" />
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

        <!-- Tab: Полные данные — нормализованный JSON всей строки таблицы
             (без тяжёлых полей вроде final_html / result_markdown). Доступен
             для всех модулей — это базовый fallback просмотрщик. -->
        <div v-if="activeTab === 'raw'" class="card">
          <div class="text-xs text-gray-500 mb-2">Все поля задачи (тяжёлые поля скрыты)</div>
          <pre class="text-xs text-gray-300 font-mono overflow-x-auto max-h-[700px] whitespace-pre">{{ fullRowJson }}</pre>
        </div>
      </template>
    </div>
  </AdminLayout>
</template>
