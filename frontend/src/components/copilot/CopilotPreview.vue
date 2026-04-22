<script setup>
import { useCopilotStore } from '../../stores/copilot.js';
const store = useCopilotStore();

const emit = defineEmits(['apply']);

function applyReplace() { emit('apply', { mode: 'replace',     html: store.streamingText }); }
function applyBelow()   { emit('apply', { mode: 'insert_below', html: store.streamingText }); }
function dismiss()      { store.previewVisible = false; store.streamingText = ''; store.currentStatus = 'idle'; }
</script>

<template>
  <div v-if="store.streamingText || store.isBusy" class="card flex flex-col gap-3">
    <div class="flex items-center gap-2">
      <h3 class="text-sm font-semibold text-white">Превью результата</h3>
      <span class="text-xs text-gray-500 ml-auto">{{ store.streamingText.length }} симв.</span>
    </div>

    <div class="bg-gray-900 border border-gray-700 rounded-md p-3 max-h-80 overflow-y-auto">
      <pre class="text-xs font-mono text-gray-300 whitespace-pre-wrap break-words">{{ store.streamingText || '…' }}</pre>
    </div>

    <div v-if="store.currentStatus === 'done'" class="flex gap-2">
      <button
        @click="applyReplace"
        class="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold rounded-md py-2 transition-colors"
      >Применить (заменить)</button>
      <button
        @click="applyBelow"
        class="flex-1 bg-gray-700 hover:bg-gray-600 text-white text-sm font-semibold rounded-md py-2 transition-colors"
      >Вставить ниже</button>
      <button
        @click="dismiss"
        class="px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-md transition-colors"
        title="Отклонить"
      >✕</button>
    </div>

    <div v-else-if="store.currentStatus === 'streaming' || store.currentStatus === 'pending'" class="text-xs text-yellow-400 flex items-center gap-2">
      <svg class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" class="opacity-25" />
        <path fill="currentColor" d="M4 12a8 8 0 018-8v8z" class="opacity-75" />
      </svg>
      Стрим в процессе…
    </div>

    <div v-else-if="store.currentStatus === 'error'" class="text-xs text-red-400 break-words">
      <p class="font-semibold">Ошибка генерации</p>
      <p v-if="store.lastError" class="mt-1">{{ store.lastError }}</p>
      <p v-else class="mt-1">Откройте журнал событий для деталей.</p>
    </div>
  </div>
</template>
