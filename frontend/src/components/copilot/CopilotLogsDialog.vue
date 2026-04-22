<script setup>
import { useCopilotStore } from '../../stores/copilot.js';
const store = useCopilotStore();

function levelClass(level) {
  if (level === 'error') return 'text-red-400';
  if (level === 'warn')  return 'text-yellow-400';
  return 'text-gray-400';
}
function fmtTs(ts) {
  try { return new Date(ts).toLocaleTimeString('ru-RU', { hour12: false }); }
  catch { return ts; }
}
</script>

<template>
  <div
    v-if="store.logsDialogOpen"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
    @click.self="store.logsDialogOpen = false"
  >
    <div class="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-2xl max-h-[80vh] flex flex-col shadow-xl">
      <div class="flex items-center px-4 py-3 border-b border-gray-800">
        <h3 class="text-sm font-semibold text-white">Журнал событий операции</h3>
        <span class="text-xs text-gray-500 ml-2">({{ store.logs.length }})</span>
        <button
          class="ml-auto text-gray-500 hover:text-gray-300"
          @click="store.logsDialogOpen = false"
        >✕</button>
      </div>

      <div class="flex-1 overflow-y-auto p-4 space-y-1.5 font-mono text-xs">
        <div v-if="!store.logs.length" class="text-gray-600 italic">Нет записей. Запустите операцию, чтобы увидеть логи.</div>
        <div
          v-for="(entry, idx) in store.logs"
          :key="idx"
          class="flex items-start gap-2"
        >
          <span class="text-gray-600 flex-shrink-0">{{ fmtTs(entry.ts) }}</span>
          <span :class="['uppercase font-semibold flex-shrink-0', levelClass(entry.level)]">[{{ entry.level || 'info' }}]</span>
          <span class="text-gray-300 break-words">{{ entry.message }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
