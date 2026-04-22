<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useTasksStore } from '../stores/tasks.js';
import { useCopilotStore } from '../stores/copilot.js';

import CopilotEditor      from '../components/copilot/CopilotEditor.vue';
import CopilotSidebar     from '../components/copilot/CopilotSidebar.vue';
import CopilotPreview     from '../components/copilot/CopilotPreview.vue';
import CopilotLogsDialog  from '../components/copilot/CopilotLogsDialog.vue';
import CopilotUsageBar    from '../components/copilot/CopilotUsageBar.vue';
import CopilotHistory     from '../components/copilot/CopilotHistory.vue';

const route       = useRoute();
const tasksStore  = useTasksStore();
const store       = useCopilotStore();
const taskId      = route.params.id;

const editorRef   = ref(null);
const articleHtml = ref('');
const loading     = ref(true);
const error       = ref(null);
const task        = ref(null);

let saveTimer = null;
const SAVE_DEBOUNCE_MS = 2500;

// Запоминаем, был ли при старте операции выделенный фрагмент: по требованию
// пользователя «когда нажимаю Сгенерировать — выделенный фрагмент должен
// автоматически замениться». Используем эту метку при автозамене на done.
let _operationStartedWithSelection = false;
let _lastAutoAppliedOperationId    = null;

onMounted(async () => {
  try {
    await store.loadPresets();
    const data = await tasksStore.fetchResult(taskId);
    task.value = data.task;
    articleHtml.value = data.task?.full_html_edited || data.task?.full_html || '';
    if (!articleHtml.value) {
      error.value = 'Статья ещё не сгенерирована. Дождитесь окончания работы основного пайплайна.';
    } else {
      await store.loadSession(taskId);
    }
  } catch (e) {
    error.value = e.response?.data?.error || e.message;
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(() => {
  store.closeStream();
  if (saveTimer) clearTimeout(saveTimer);
});

function onSelectionChange({ text, html }) {
  store.selectedText = text || '';
  store.selectedHtml = html || '';
}

// Дебаунс автосохранения html_edited при правках в редакторе
watch(articleHtml, (val) => {
  if (loading.value || !val) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    store.saveEditedHtml(val).catch(() => {/* swallow */});
  }, SAVE_DEBOUNCE_MS);
});

async function onApply({ mode, html }) {
  if (!editorRef.value || !html) return;
  if (mode === 'replace')      editorRef.value.replaceSelection(html);
  if (mode === 'insert_below') editorRef.value.insertBelow(html);
  // Берём свежий HTML после изменения и шлём бэку.
  const newFull = editorRef.value.getCurrentHtml();
  articleHtml.value = newFull;
  try {
    await store.applyOperation(mode, newFull);
  } catch (e) {
    store.logs.push({
      ts: new Date().toISOString(),
      level: 'error',
      message: 'Apply failed: ' + (e.response?.data?.error || e.message),
    });
  }
}

// При старте новой операции запоминаем, был ли выделенный фрагмент.
// Это нужно, чтобы на done корректно решить, заменять ли выделение
// автоматически. Триггеримся на смену operationId, а не на статус,
// чтобы поймать состояние ДО первого 'streaming'-токена.
watch(() => store.currentOperationId, (opId) => {
  if (opId) {
    _operationStartedWithSelection = !!(store.selectedHtml || store.selectedText);
    _lastAutoAppliedOperationId    = null;
  }
});

// Авто-применение результата при `done` — реализует требование пользователя:
// «когда нажимаю Сгенерировать — выделенный фрагмент должен автоматически
// замениться». Если выделения не было — для пресетов с insert-below-семантикой
// (add_faq, expand_section) вставляем результат ниже курсора. В прочих случаях
// оставляем preview, чтобы пользователь решил вручную.
const INSERT_BELOW_ACTIONS = new Set(['add_faq', 'expand_section']);

watch(() => store.currentStatus, async (status) => {
  if (status !== 'done') return;
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
  // Иначе — оставляем preview как раньше (пользователь решит).
});
</script>

<template>
  <div class="min-h-screen bg-gray-950">

    <!-- Шапка -->
    <header class="border-b border-gray-800 bg-gray-900 px-6 py-3 flex items-center gap-3">
      <RouterLink to="/dashboard" class="btn-ghost text-xs">← Кабинет</RouterLink>
      <span class="text-white font-semibold truncate max-w-lg">
        {{ task?.input_target_service || 'Задача' }}
      </span>

      <nav class="ml-4 flex gap-1">
        <RouterLink
          :to="`/tasks/${taskId}/result`"
          class="text-xs px-3 py-1.5 rounded-md bg-gray-800 text-gray-300 hover:bg-gray-700 transition-colors"
        >Генератор SEO текста</RouterLink>
        <span class="text-xs px-3 py-1.5 rounded-md bg-indigo-600 text-white">AI-Редактор</span>
      </nav>
    </header>

    <main class="max-w-7xl mx-auto px-6 py-6 space-y-4">
      <!-- Загрузка/ошибка -->
      <div v-if="loading" class="card text-center text-gray-500 py-8">Загрузка…</div>
      <div v-else-if="error" class="card border border-red-800 text-red-300">{{ error }}</div>

      <template v-else>
        <!-- Расход в реальном времени — сверху, всегда виден -->
        <CopilotUsageBar />

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
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
    </main>

    <CopilotLogsDialog />
  </div>
</template>
