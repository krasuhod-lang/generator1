<script setup>
/**
 * SchemaAuditCard — микроразметка (п.8 ТЗ):
 *   по каждому шаблону — что есть / чего не хватает / что битое
 *   + готовые JSON-LD сниппеты к внедрению.
 */
import { ref, computed } from 'vue';

const props = defineProps({
  schemaAudit: { type: Object, default: null },
});

const available = computed(() => props.schemaAudit && props.schemaAudit.available);
const items = computed(() => (props.schemaAudit && props.schemaAudit.items) || []);
const summary = computed(() => (props.schemaAudit && props.schemaAudit.summary) || null);

const openSnippet = ref({});
function toggle(key) { openSnippet.value = { ...openSnippet.value, [key]: !openSnippet.value[key] }; }

function trimUrl(u) {
  if (!u) return '';
  try { const p = new URL(u); return (p.pathname + p.search) || u; } catch (_) { return u; }
}
</script>

<template>
  <section v-if="available && items.length" class="card space-y-3">
    <h2 class="text-sm font-semibold uppercase tracking-wider text-indigo-300">
      🧩 Микроразметка: что добавить и поправить
      <span v-if="summary" class="text-xs text-gray-400">
        · {{ summary.missing_types }} отсутствует, {{ summary.broken_fields }} с ошибками
      </span>
    </h2>
    <div class="space-y-2">
      <div v-for="(it, i) in items" :key="i" class="rounded-lg bg-gray-800/40 p-3 text-sm space-y-1">
        <div class="flex items-center justify-between">
          <span class="font-semibold">{{ it.template }}</span>
          <span class="text-xs text-indigo-300">{{ trimUrl(it.sample_url) }}</span>
        </div>
        <div v-if="it.present_types && it.present_types.length" class="flex flex-wrap gap-1">
          <span v-for="t in it.present_types" :key="t"
                class="rounded-full bg-emerald-900/40 text-emerald-300 px-2 py-0.5 text-[11px]">{{ t }}</span>
        </div>
        <div v-if="it.missing_types && it.missing_types.length" class="flex flex-wrap gap-1">
          <span v-for="t in it.missing_types" :key="t"
                class="rounded-full bg-red-900/40 text-red-300 px-2 py-0.5 text-[11px]">+ {{ t }}</span>
        </div>
        <ul v-if="it.actions && it.actions.length" class="list-disc list-inside text-xs text-gray-300">
          <li v-for="(a, ai) in it.actions" :key="ai">{{ a }}</li>
        </ul>
        <div v-if="it.snippets && Object.keys(it.snippets).length">
          <button class="btn-secondary text-xs" @click="toggle(i)">
            {{ openSnippet[i] ? 'Скрыть' : 'Показать' }} JSON-LD сниппеты
          </button>
          <pre v-if="openSnippet[i]" class="mt-2 max-h-72 overflow-auto rounded bg-gray-900/70 p-2 text-[11px] text-gray-200"><code>{{ JSON.stringify(it.snippets, null, 2) }}</code></pre>
        </div>
      </div>
    </div>
  </section>
</template>
