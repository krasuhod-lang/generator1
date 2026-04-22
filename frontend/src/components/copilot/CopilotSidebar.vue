<script setup>
import { computed } from 'vue';
import { useCopilotStore } from '../../stores/copilot.js';

const store = useCopilotStore();

const presetMeta = computed(() => store.presets.find(p => p.action === store.action) || null);

const showSelectionField  = computed(() => presetMeta.value?.needsSelected);
const showKeywordField    = computed(() => presetMeta.value?.needsExtra && (presetMeta.value?.extraSchema?.keyword));
const promptPlaceholder   = computed(() => {
  switch (store.action) {
    case 'factcheck':      return 'Например: «Замени Анапу на Геленджик»';
    case 'add_faq':        return 'Опционально: дополнительные требования к FAQ (тематика, тон)';
    case 'enrich_lsi':     return 'Опционально: акценты для интеграции LSI';
    case 'expand_section': return 'Например: «H2: Как выбрать тариф для малого бизнеса»';
    case 'anti_spam':      return 'Опционально: уточнения по тону';
    case 'custom':         return 'Опишите задачу свободно (например: «Сделай абзац более экспертным»)';
    default: return 'Комментарий к задаче';
  }
});

async function onSubmit() {
  try {
    await store.startOperation();
  } catch (e) {
    store.logs.push({
      ts: new Date().toISOString(),
      level: 'error',
      message: e.response?.data?.error || e.message,
    });
    store.currentStatus = 'error';
  }
}
</script>

<template>
  <aside class="card flex flex-col gap-4">
    <div class="flex items-center gap-2">
      <h3 class="text-sm font-semibold text-white">AI-Copilot</h3>
      <span class="text-xs text-gray-500 ml-auto truncate" :title="store.model">{{ store.model || 'модель не указана' }}</span>
    </div>

    <!-- Action -->
    <div>
      <label class="text-xs text-gray-400 block mb-1">Действие</label>
      <select
        v-model="store.action"
        class="w-full bg-gray-900 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-indigo-500"
        :disabled="store.isBusy"
      >
        <option v-for="p in store.presets" :key="p.action" :value="p.action">{{ p.label }}</option>
      </select>
    </div>

    <!-- Selected text indicator -->
    <div v-if="showSelectionField" class="text-xs">
      <p class="text-gray-400 mb-1">Выделенный фрагмент</p>
      <div
        v-if="store.selectedText"
        class="bg-gray-900 border border-gray-700 rounded-md px-2 py-1.5 text-gray-300 max-h-24 overflow-y-auto whitespace-pre-wrap"
      >{{ store.selectedText.slice(0, 600) }}<span v-if="store.selectedText.length > 600">…</span></div>
      <div v-else class="text-yellow-500">Выделите фрагмент в редакторе слева</div>
      <p v-if="store.selectedText" class="text-gray-600 mt-1">{{ store.selectedText.length }} символов</p>
    </div>

    <!-- Anti-spam keyword -->
    <div v-if="showKeywordField">
      <label class="text-xs text-gray-400 block mb-1">Слово-переспам</label>
      <input
        type="text"
        v-model="store.extraParams.keyword"
        placeholder="Например: «продвижение»"
        class="w-full bg-gray-900 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-indigo-500"
        :disabled="store.isBusy"
      />
    </div>

    <!-- User prompt -->
    <div>
      <label class="text-xs text-gray-400 block mb-1">Комментарий / промпт</label>
      <textarea
        v-model="store.userPrompt"
        :placeholder="promptPlaceholder"
        rows="4"
        maxlength="4000"
        class="w-full bg-gray-900 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-indigo-500 resize-y"
        :disabled="store.isBusy"
      />
      <p class="text-xs text-gray-600 mt-1 text-right">{{ store.userPrompt.length }}/4000</p>
    </div>

    <!-- Generate / Cancel buttons -->
    <div class="flex gap-2">
      <button
        v-if="!store.isBusy"
        @click="onSubmit"
        class="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold rounded-md py-2 transition-colors"
      >Сгенерировать</button>
      <button
        v-else
        @click="store.cancelOperation"
        class="flex-1 bg-red-700 hover:bg-red-600 text-white text-sm font-semibold rounded-md py-2 transition-colors"
      >Отменить</button>

      <button
        @click="store.logsDialogOpen = true"
        class="px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-md transition-colors"
        title="Журнал событий"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"/>
        </svg>
      </button>
    </div>

    <!-- Status text -->
    <p
      v-if="store.currentStatus !== 'idle'"
      class="text-xs"
      :class="{
        'text-yellow-400': store.currentStatus === 'pending' || store.currentStatus === 'streaming',
        'text-green-400':  store.currentStatus === 'done',
        'text-red-400':    store.currentStatus === 'error',
        'text-gray-400':   store.currentStatus === 'cancelled',
      }"
    >
      Статус: {{ store.currentStatus }}
    </p>
  </aside>
</template>
