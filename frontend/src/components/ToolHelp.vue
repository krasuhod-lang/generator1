<script setup>
import { ref } from 'vue';

const props = defineProps({
  title: { type: String, required: true },
  text: { type: String, required: true },
});

const open = ref(false);

function toggle() {
  open.value = !open.value;
}

function close() {
  open.value = false;
}
</script>

<template>
  <span class="relative inline-flex align-middle" @keydown.esc="close">
    <button
      type="button"
      class="inline-flex h-5 w-5 items-center justify-center rounded-full border border-indigo-400/70 text-[11px] font-bold leading-none text-indigo-300 transition hover:border-indigo-300 hover:bg-indigo-500/15 hover:text-indigo-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
      :aria-label="`Справка: ${props.title}`"
      :aria-expanded="open"
      :title="props.title"
      @click.stop="toggle"
    >!
    </button>
    <div
      v-if="open"
      role="tooltip"
      class="absolute left-0 top-7 z-30 w-72 rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-left text-xs font-normal leading-relaxed text-gray-300 shadow-2xl"
    >
      <div class="mb-1 font-semibold text-indigo-200">{{ props.title }}</div>
      <div>{{ props.text }}</div>
    </div>
  </span>
</template>

<style scoped>
button { font-family: inherit; }
</style>
