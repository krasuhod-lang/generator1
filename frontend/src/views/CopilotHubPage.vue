<script setup>
/**
 * CopilotHubPage — точка входа в AI-Редактор из верхнего меню кабинета.
 *
 * Поддерживает два режима:
 *   1) picker  — выбор готовой задачи (status === 'completed') из списка пользователя.
 *   2) editor  — встроенный AI-редактор для выбранной задачи (та же логика, что и в
 *                EditorCopilotPage.vue, но внутри AppLayout, чтобы верхнее меню
 *                оставалось видимым).
 *
 * Также принимает query-параметр ?taskId=<id> для прямого открытия конкретной задачи.
 */
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import { useTasksStore }   from '../stores/tasks.js';
import { useCopilotStore } from '../stores/copilot.js';

import CopilotEditor      from '../components/copilot/CopilotEditor.vue';
import CopilotSidebar     from '../components/copilot/CopilotSidebar.vue';
import CopilotPreview     from '../components/copilot/CopilotPreview.vue';
import CopilotLogsDialog  from '../components/copilot/CopilotLogsDialog.vue';
import CopilotUsageBar    from '../components/copilot/CopilotUsageBar.vue';
import CopilotHistory     from '../components/copilot/CopilotHistory.vue';

const route       = useRoute();
const router      = useRouter();
const tasksStore  = useTasksStore();
const store       = useCopilotStore();

const mode          = ref('picker');     // 'picker' | 'editor'
const selectedTask  = ref(null);
const articleHtml   = ref('');
const editorRef     = ref(null);
const editorLoading = ref(false);
const editorError   = ref(null);
const listLoading   = ref(false);
const listError     = ref(null);

let saveTimer = null;
const SAVE_DEBOUNCE_MS = 2500;

const completedTasks = computed(() =>
  (tasksStore.tasks || []).filter(t => t.status === 'completed')
);

onMounted(async () => {
  // 1) Загружаем список задач + пресеты редактора параллельно.
  listLoading.value = true;
  listError.value   = null;
  try {
    await Promise.all([
      tasksStore.fetchTasks(),
      store.loadPresets().catch(() => {/* пресеты не критичны для выбора */}),
    ]);
  } catch (e) {
    listError.value = e?.response?.data?.error || e?.message || 'Не удалось загрузить задачи';
  } finally {
    listLoading.value = false;
  }

  // 2) Если в URL передан ?taskId — пытаемся сразу открыть редактор.
  const qid = route.query.taskId ? String(route.query.taskId) : null;
  if (qid) {
    const t = (tasksStore.tasks || []).find(x => String(x.id) === qid);
    if (t && t.status === 'completed') {
      await openTask(t);
    }
  }
});

onBeforeUnmount(() => {
  store.closeStream();
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
});

async function openTask(task) {
  if (!task) return;
  selectedTask.value = task;
  mode.value         = 'editor';
  editorLoading.value = true;
  editorError.value   = null;
  articleHtml.value   = '';

  // Полностью сбрасываем состояние стора (важно при переключении между задачами).
  store.reset();

  try {
    const data = await tasksStore.fetchResult(task.id);
    selectedTask.value = data.task || task;
    articleHtml.value  = data.task?.full_html_edited || data.task?.full_html || '';
    if (!articleHtml.value) {
      editorError.value = 'Статья ещё не сгенерирована. Дождитесь окончания работы основного пайплайна.';
    } else {
      await store.loadSession(task.id);
    }
    // Синхронизируем URL для шаринга/обновления страницы.
    if (String(route.query.taskId || '') !== String(task.id)) {
      router.replace({ path: '/copilot', query: { taskId: String(task.id) } });
    }
  } catch (e) {
    editorError.value = e?.response?.data?.error || e?.message || 'Не удалось открыть задачу';
  } finally {
    editorLoading.value = false;
  }
}

function backToPicker() {
  store.closeStream();
  store.reset();
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  selectedTask.value = null;
  articleHtml.value  = '';
  editorError.value  = null;
  mode.value         = 'picker';
  if (route.query.taskId) {
    router.replace({ path: '/copilot' });
  }
  // На случай — обновим список (статусы могли измениться).
  tasksStore.fetchTasks().catch(() => {});
}

function onSelectionChange({ text, html }) {
  store.selectedText = text || '';
  store.selectedHtml = html || '';
}

// Дебаунс автосохранения html_edited при правках в редакторе.
watch(articleHtml, (val) => {
  if (mode.value !== 'editor' || editorLoading.value || !val) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    store.saveEditedHtml(val).catch(() => {/* swallow */});
  }, SAVE_DEBOUNCE_MS);
});

async function onApply({ mode: applyMode, html }) {
  if (!editorRef.value || !html) return;
  if (applyMode === 'replace')      editorRef.value.replaceSelection(html);
  if (applyMode === 'insert_below') editorRef.value.insertBelow(html);
  const newFull = editorRef.value.getCurrentHtml();
  articleHtml.value = newFull;
  try {
    await store.applyOperation(applyMode, newFull);
  } catch (e) {
    store.logs.push({
      ts: new Date().toISOString(),
      level: 'error',
      message: 'Apply failed: ' + (e?.response?.data?.error || e?.message),
    });
  }
}

// Авто-применение результата при `done` — то же поведение, что в EditorCopilotPage:
// если при старте операции был выделенный фрагмент → автоматически заменяем его
// результатом; иначе для add_faq/expand_section вставляем ниже курсора. Прочее —
// оставляем preview, чтобы пользователь решил вручную.
let _operationStartedWithSelection = false;
let _lastAutoAppliedOperationId    = null;
const INSERT_BELOW_ACTIONS = new Set(['add_faq', 'expand_section']);

watch(() => store.currentOperationId, (opId) => {
  if (opId) {
    _operationStartedWithSelection = !!(store.selectedHtml || store.selectedText);
    _lastAutoAppliedOperationId    = null;
  }
});

watch(() => store.currentStatus, async (status) => {
  if (status !== 'done') return;
  if (mode.value !== 'editor') return;
  const opId = store.currentOperationId;
  if (!opId || _lastAutoAppliedOperationId === opId) return;
  if (!store.streamingText) return;

  if (_operationStartedWithSelection) {
    _lastAutoAppliedOperationId = opId;
    await onApply({ mode: 'replace', html: store.streamingText });
  } else if (INSERT_BELOW_ACTIONS.has(store.action)) {
    _lastAutoAppliedOperationId = opId;
    await onApply({ mode: 'insert_below', html: store.streamingText });
  }
});

function fmtDate(s) {
  if (!s) return '';
  try {
    const d = new Date(s);
    return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (_) { return s; }
}
</script>

<template>
  <AppLayout>
    <div class="max-w-7xl mx-auto px-6 py-8">

      <!-- ───────────────── Режим выбора задачи ───────────────── -->
      <template v-if="mode === 'picker'">
        <div class="flex items-center justify-between mb-6">
          <div>
            <h1 class="text-xl font-bold text-white flex items-center gap-2">
              <span>🤖</span> AI-Редактор статьи
            </h1>
            <p class="text-sm text-gray-500 mt-0.5">
              Выберите готовую задачу — и редактируйте сгенерированную статью с помощью ИИ
            </p>
          </div>
        </div>

        <!-- Загрузка списка -->
        <div v-if="listLoading" class="card text-center py-16 text-gray-500">
          <svg class="animate-spin w-6 h-6 mx-auto mb-3" viewBox="0 0 24 24" fill="none">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
          </svg>
          Загрузка задач...
        </div>

        <!-- Ошибка -->
        <div v-else-if="listError" class="card border border-red-800 text-red-300">
          {{ listError }}
        </div>

        <!-- Пусто -->
        <div v-else-if="!completedTasks.length" class="card text-center py-16">
          <div class="text-5xl mb-4">📭</div>
          <p class="text-gray-400 text-lg font-medium">Готовых статей пока нет</p>
          <p class="text-gray-600 text-sm mt-1 mb-5">
            Сначала запустите задачу в «Генератор SEO текста» и дождитесь её завершения.
          </p>
          <RouterLink to="/dashboard" class="btn-primary inline-flex">К списку задач</RouterLink>
        </div>

        <!-- Сетка готовых задач -->
        <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <button
            v-for="t in completedTasks"
            :key="t.id"
            @click="openTask(t)"
            class="card text-left hover:border-indigo-600 hover:bg-gray-800/40 transition-colors p-4"
          >
            <div class="flex items-start justify-between gap-3">
              <p class="text-white font-medium truncate">
                {{ t.title || t.input_target_service || `Задача #${t.id}` }}
              </p>
              <span class="badge bg-green-900 text-green-300 flex-shrink-0">✓ Готово</span>
            </div>
            <div class="mt-2 text-xs text-gray-500 flex items-center gap-3 flex-wrap">
              <span>{{ fmtDate(t.created_at) }}</span>
              <span v-if="t.lsi_coverage">LSI {{ t.lsi_coverage }}%</span>
              <span v-if="t.eeat_score">E-E-A-T {{ t.eeat_score }}</span>
            </div>
            <div class="mt-3 inline-flex items-center gap-1.5 text-indigo-400 text-xs font-medium">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>
              </svg>
              Открыть в AI-Редакторе
            </div>
          </button>
        </div>
      </template>

      <!-- ───────────────── Режим редактора ───────────────── -->
      <template v-else>
        <div class="flex items-center gap-3 mb-4">
          <button @click="backToPicker" class="btn-ghost text-xs">← Сменить задачу</button>
          <span class="text-white font-semibold truncate max-w-lg">
            {{ selectedTask?.input_target_service || selectedTask?.title || 'Задача' }}
          </span>
          <span class="text-xs px-2.5 py-1 rounded-md bg-indigo-600 text-white ml-1">AI-Редактор</span>
          <RouterLink
            v-if="selectedTask?.id"
            :to="`/tasks/${selectedTask.id}/result`"
            class="text-xs px-3 py-1.5 rounded-md bg-gray-800 text-gray-300 hover:bg-gray-700 transition-colors ml-auto"
          >
            Открыть результат задачи →
          </RouterLink>
        </div>

        <div v-if="editorLoading" class="card text-center text-gray-500 py-8">Загрузка…</div>
        <div v-else-if="editorError" class="card border border-red-800 text-red-300">{{ editorError }}</div>

        <template v-else>
          <CopilotUsageBar />

          <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
            <!-- Левая колонка: WYSIWYG -->
            <div class="lg:col-span-2 space-y-4">
              <CopilotEditor
                ref="editorRef"
                v-model="articleHtml"
                @selection-change="onSelectionChange"
              />
              <CopilotPreview @apply="onApply" />
            </div>

            <!-- Правая колонка: Sidebar + History -->
            <div class="space-y-4">
              <CopilotSidebar />
              <CopilotHistory />
            </div>
          </div>
        </template>

        <CopilotLogsDialog />
      </template>
    </div>
  </AppLayout>
</template>
