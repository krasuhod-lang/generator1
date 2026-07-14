<script setup>
/**
 * KpSectionTabs — вкладки раздела «Создать КП»:
 *   «Прогнозатор» (/forecaster) и «Фронт работ» (/proposals).
 * Активная вкладка определяется по текущему маршруту.
 */
import { computed } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();

const TABS = [
  { key: 'forecaster', label: '📈 Прогнозатор', path: '/forecaster' },
  { key: 'proposals',  label: '🧱 Фронт работ', path: '/proposals' },
];

const activeKey = computed(() => (route.path.startsWith('/proposals') ? 'proposals' : 'forecaster'));
</script>

<template>
  <div class="flex rounded-lg overflow-hidden border border-gray-700 text-sm w-fit">
    <router-link v-for="t in TABS" :key="t.key" :to="t.path"
      class="px-4 py-1.5 font-medium transition"
      :class="activeKey === t.key ? 'bg-indigo-600 text-white' : 'bg-gray-950 text-gray-400 hover:text-gray-200'">
      {{ t.label }}
    </router-link>
  </div>
</template>
