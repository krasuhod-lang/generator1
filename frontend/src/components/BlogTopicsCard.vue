<script setup>
/**
 * BlogTopicsCard — план публикаций в блог (п.3 ТЗ):
 *   темы статей с готовыми title (50-60) / description (140-155), H1,
 *   размеченным интентом и поддерживающими запросами со статистикой.
 *   Темы строятся строго из фактов GSC (без галлюцинаций).
 */
import { computed, ref } from 'vue';
import { copyToClipboard, toTsv } from '../utils/clipboard.js';

const props = defineProps({
  blogPlan: { type: Object, default: null },
});

const available = computed(() => props.blogPlan && props.blogPlan.available);
const topics = computed(() => (props.blogPlan && props.blogPlan.topics) || []);
const insufficient = computed(() => props.blogPlan && props.blogPlan.insufficient);
const copied = ref(false);

function supportImpressions(t) {
  if (Array.isArray(t.evidence) && t.evidence.length) {
    return t.evidence.reduce((sum, e) => sum + (Number(e.impressions) || 0), 0);
  }
  return Number(t.impressions) || 0;
}

// Копирование всей таблицы тем в Excel: TSV с разбивкой по колонкам (2 клика).
async function copyAllForExcel() {
  const headers = ['Тема', 'H1', 'Title', 'Description', 'Интент', 'Не закрытый интент',
    'Поддерживающие запросы', 'Показы'];
  const rows = [headers];
  topics.value.forEach((t) => {
    rows.push([
      t.topic || '',
      t.h1 || '',
      t.title || '',
      t.description || '',
      t.intent || '',
      t.intent_gap || '',
      (t.supporting_queries || []).join('; '),
      supportImpressions(t),
    ]);
  });
  const ok = await copyToClipboard(toTsv(rows));
  if (ok) { copied.value = true; setTimeout(() => { copied.value = false; }, 2000); }
}
</script>

<template>
  <section v-if="available && (topics.length || insufficient)" class="card space-y-3">
    <div class="flex items-center justify-between gap-2">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-indigo-300">
        ✍️ План публикаций в блог ({{ topics.length }} тем)
      </h2>
      <button v-if="topics.length" class="btn-secondary text-xs" @click="copyAllForExcel"
              title="Скопировать таблицу в формате TSV — вставляется в Excel как таблица (Ctrl+V)">
        {{ copied ? '✓ Скопировано' : '📋 Копировать всё (для Excel)' }}
      </button>
    </div>

    <div v-if="insufficient" class="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded p-2">
      Недостаточно данных GSC: найдено {{ insufficient.got }} тем из желаемых {{ insufficient.needed }}.
      Темы построены только на реальных запросах — заглушки не добавляются.
    </div>

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
        <div v-if="t.intent" class="text-xs">
          <span class="rounded-full bg-indigo-500/20 px-2 py-0.5 text-[11px] text-indigo-200">{{ t.intent }}</span>
          <span v-if="t.intent_gap" class="text-gray-400 ml-1">{{ t.intent_gap }}</span>
        </div>
        <div v-if="t.target_url_intent" class="text-xs">
          <span class="text-gray-400">Интент целевой страницы:</span> {{ t.target_url_intent }}
        </div>
        <div v-if="t.supporting_queries && t.supporting_queries.length" class="flex flex-wrap items-center gap-1 pt-1">
          <span v-for="q in t.supporting_queries.slice(0, 6)" :key="q"
                class="rounded-full bg-gray-900/60 px-2 py-0.5 text-[11px] text-gray-300">{{ q }}</span>
          <span class="text-[11px] text-gray-500">· показы: {{ supportImpressions(t) }}</span>
        </div>
      </div>
    </div>
  </section>
</template>
