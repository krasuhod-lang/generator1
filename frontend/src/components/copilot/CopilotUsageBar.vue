<script setup>
import { computed } from 'vue';
import { useCopilotStore } from '../../stores/copilot.js';

const store = useCopilotStore();

const fmtCost = (n) => `$${(Number(n) || 0).toFixed(4)}`;
const fmtTok  = (n) => (Number(n) || 0).toLocaleString('ru-RU');

const opTotal = computed(() => store.usage.tokens_in + store.usage.tokens_out);
const sessionTotal = computed(() => store.sessionTotals.tokens_in + store.sessionTotals.tokens_out);
</script>

<template>
  <div class="card flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
    <div class="flex items-center gap-2">
      <span class="text-gray-500 uppercase tracking-wide">Текущая операция:</span>
      <span class="text-gray-300">in <strong class="text-gray-100">{{ fmtTok(store.usage.tokens_in) }}</strong></span>
      <span class="text-gray-300">/ out <strong class="text-gray-100">{{ fmtTok(store.usage.tokens_out) }}</strong></span>
      <span class="text-gray-500">= {{ fmtTok(opTotal) }} ток.</span>
      <span class="text-indigo-300 font-semibold">{{ fmtCost(store.usage.cost_usd) }}</span>
    </div>
    <div class="flex items-center gap-2 ml-auto">
      <span class="text-gray-500 uppercase tracking-wide">Сессия (всего):</span>
      <span class="text-gray-300">{{ fmtTok(sessionTotal) }} ток.</span>
      <span class="text-indigo-300 font-semibold">{{ fmtCost(store.sessionTotals.cost_usd) }}</span>
    </div>
  </div>
</template>
