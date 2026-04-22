<script setup>
import { useCopilotStore } from '../../stores/copilot.js';
const store = useCopilotStore();

const STATUS_COLORS = {
  done:      'text-green-400',
  streaming: 'text-yellow-400',
  pending:   'text-yellow-400',
  error:     'text-red-400',
  cancelled: 'text-gray-500',
};

function fmtDt(ts) {
  try { return new Date(ts).toLocaleString('ru-RU', { hour12: false }); }
  catch { return ts; }
}
function actionLabel(act) {
  const p = store.presets.find(p => p.action === act);
  return p ? p.label : act;
}
</script>

<template>
  <div class="card">
    <div class="flex items-center mb-3">
      <h3 class="text-sm font-semibold text-white">История операций</h3>
      <span class="text-xs text-gray-500 ml-2">({{ store.history.length }})</span>
    </div>
    <div v-if="!store.history.length" class="text-xs text-gray-600 italic">Нет операций по этой задаче.</div>
    <ul v-else class="space-y-1.5 max-h-72 overflow-y-auto">
      <li
        v-for="op in store.history"
        :key="op.id"
        class="flex items-center gap-2 text-xs bg-gray-900 rounded px-3 py-2"
      >
        <span :class="['font-semibold uppercase w-20', STATUS_COLORS[op.status] || 'text-gray-400']">{{ op.status }}</span>
        <span class="text-gray-300 flex-1 truncate">{{ actionLabel(op.action) }}</span>
        <span v-if="op.applied" class="text-green-500">✓ применено</span>
        <span class="text-gray-500 font-mono">${{ Number(op.cost_usd || 0).toFixed(4) }}</span>
        <span class="text-gray-600 font-mono w-32 text-right truncate" :title="fmtDt(op.created_at)">{{ fmtDt(op.created_at) }}</span>
      </li>
    </ul>
  </div>
</template>
