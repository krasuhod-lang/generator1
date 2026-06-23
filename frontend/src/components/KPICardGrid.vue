<script setup>
/**
 * KPICardGrid.vue (PR-4) — сетка карточек со stagger-анимацией появления.
 *
 * Принимает массив `cards`: каждый элемент — props для KPICard.vue.
 * Каждая карточка появляется со сдвигом `stagger` мс относительно предыдущей,
 * чтобы рендер дашборда чувствовался как Apple keynote. Анимация делается на
 * чистом CSS (transition + transform/opacity), без зависимостей.
 */
import { computed } from 'vue';
import KPICard from './KPICard.vue';

const props = defineProps({
  cards:   { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  stagger: { type: Number, default: 70 }, // мс между карточками
});

const items = computed(() => (Array.isArray(props.cards) ? props.cards : []));
</script>

<template>
  <div class="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
    <div
      v-for="(card, idx) in items"
      :key="card.key || card.title || idx"
      class="kpi-stagger"
      :style="{ animationDelay: (idx * stagger) + 'ms' }"
    >
      <KPICard v-bind="card" :loading="loading" />
    </div>
  </div>
</template>

<style scoped>
.kpi-stagger {
  animation: kpi-fade-in 420ms cubic-bezier(0.22, 0.61, 0.36, 1) both;
}

@keyframes kpi-fade-in {
  0%   { opacity: 0; transform: translateY(12px); }
  100% { opacity: 1; transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  .kpi-stagger { animation: none; }
}
</style>
