<script setup>
/**
 * BlogTopicsCard — план публикаций в блог (п.3 ТЗ):
 *   ≥5 тем статей с готовыми title (50-60) / description (140-155),
 *   H1, целевым интентом и поддерживающими запросами.
 */
import { computed } from 'vue';

const props = defineProps({
  blogPlan: { type: Object, default: null },
});

const available = computed(() => props.blogPlan && props.blogPlan.available);
const topics = computed(() => (props.blogPlan && props.blogPlan.topics) || []);
</script>

<template>
  <section v-if="available && topics.length" class="card space-y-3">
    <h2 class="text-sm font-semibold uppercase tracking-wider text-indigo-300">
      ✍️ План публикаций в блог ({{ topics.length }} тем)
    </h2>
    <div class="space-y-2">
      <div v-for="(t, i) in topics" :key="i" class="rounded-lg bg-gray-800/40 p-3 text-sm space-y-1">
        <div class="font-semibold">{{ i + 1 }}. {{ t.topic }}</div>
        <div v-if="t.h1" class="text-xs"><span class="text-gray-400">H1:</span> {{ t.h1 }}</div>
        <div class="text-xs">
          <span class="text-gray-400">Title:</span> {{ t.title }}
          <span class="text-gray-500">({{ (t.title || '').length }})</span>
        </div>
        <div class="text-xs">
          <span class="text-gray-400">Description:</span> {{ t.description }}
          <span class="text-gray-500">({{ (t.description || '').length }})</span>
        </div>
        <div v-if="t.target_url_intent" class="text-xs">
          <span class="text-gray-400">Интент целевой страницы:</span> {{ t.target_url_intent }}
        </div>
        <div v-if="t.supporting_queries && t.supporting_queries.length" class="flex flex-wrap gap-1 pt-1">
          <span v-for="q in t.supporting_queries.slice(0, 6)" :key="q"
                class="rounded-full bg-gray-900/60 px-2 py-0.5 text-[11px] text-gray-300">{{ q }}</span>
        </div>
      </div>
    </div>
  </section>
</template>
