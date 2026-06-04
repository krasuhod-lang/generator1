<script setup>
/**
 * EatTemplatesCard — E-E-A-T по шаблонам страниц (п.5 ТЗ):
 *   score 0..100 по каждому кластеру шаблонов (каталог/услуги/товар/блог…)
 *   + чего не хватает по измерениям Experience/Expertise/Authority/Trust.
 */
import { computed } from 'vue';

const props = defineProps({
  eat: { type: Object, default: null },
});

const available = computed(() => props.eat && props.eat.available);
const templates = computed(() => (props.eat && props.eat.templates) || []);

function trimUrl(u) {
  if (!u) return '';
  try { const p = new URL(u); return (p.pathname + p.search) || u; } catch (_) { return u; }
}
function scoreClass(s) {
  if (s == null) return 'text-gray-400';
  if (s >= 80) return 'text-emerald-300';
  if (s >= 60) return 'text-lime-300';
  if (s >= 40) return 'text-amber-300';
  return 'text-red-300';
}
</script>

<template>
  <section v-if="available && templates.length" class="card space-y-3">
    <h2 class="text-sm font-semibold uppercase tracking-wider text-indigo-300">
      🧭 E-E-A-T по шаблонам страниц
      <span v-if="eat.avg_score != null" class="text-xs text-gray-400">· средний {{ eat.avg_score }}/100</span>
    </h2>
    <div class="space-y-2">
      <div v-for="(t, i) in templates" :key="i" class="rounded-lg bg-gray-800/40 p-3 text-sm space-y-1">
        <div class="flex items-center justify-between">
          <span class="font-semibold">{{ t.template }}</span>
          <span class="font-semibold" :class="scoreClass(t.score)">
            {{ t.score != null ? t.score + '/100' : '—' }}
            <span v-if="t.level" class="text-xs text-gray-400">({{ t.level }})</span>
          </span>
        </div>
        <div class="text-xs text-indigo-300">{{ trimUrl(t.sample_url) }}</div>
        <div v-if="t.error" class="text-xs text-red-300">Не удалось спарсить представителя кластера.</div>
        <template v-else>
          <div v-if="t.gaps && t.gaps.length" class="text-xs">
            <span class="text-gray-400">Чего не хватает:</span>
            <ul class="list-disc list-inside text-gray-300">
              <li v-for="(g, gi) in t.gaps.slice(0, 6)" :key="gi">{{ g }}</li>
            </ul>
          </div>
          <div v-if="t.schema_types && t.schema_types.length" class="flex flex-wrap gap-1 pt-1">
            <span v-for="s in t.schema_types" :key="s"
                  class="rounded-full bg-gray-900/60 px-2 py-0.5 text-[11px] text-gray-300">{{ s }}</span>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>
