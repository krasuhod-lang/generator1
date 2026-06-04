<script setup>
/**
 * AiVisibilityCard — GEO/AEO для нейровыдачи (п.7 ТЗ):
 *   • AEO-форматы ответов под запросы (TL;DR, списки, prompt-friendly H);
 *   • отсутствующие AI-критичные типы schema, hreflang/гео;
 *   • ручной зонд видимости в AI Overviews / SGE по SERP-фичам.
 */
import { ref, computed } from 'vue';
import { useProjectsStore } from '../stores/projects.js';

const props = defineProps({
  geoAeo:    { type: Object, default: null },
  projectId: { type: [String, Number], default: null },
});

const store = useProjectsStore();
const available = computed(() => props.geoAeo && props.geoAeo.available);
const aeo = computed(() => (props.geoAeo && props.geoAeo.aeo) || {});
const answers = computed(() => aeo.value.aeo_answers || []);
const missingSchema = computed(() => aeo.value.missing_schema || []);
const recommendations = computed(() => aeo.value.recommendations || []);

const probe = ref(props.geoAeo && props.geoAeo.ai_visibility ? props.geoAeo.ai_visibility : null);
const probing = ref(false);

async function runProbe() {
  if (!props.projectId) return;
  probing.value = true;
  try {
    const res = await store.probeAiVisibility(props.projectId, {});
    if (res) probe.value = res;
  } catch (_) { /* graceful */ }
  finally { probing.value = false; }
}
</script>

<template>
  <section v-if="available" class="card space-y-3">
    <h2 class="text-sm font-semibold uppercase tracking-wider text-indigo-300">
      🤖 GEO/AEO — нейровыдача (AI Overviews / SGE)
    </h2>

    <div v-if="recommendations.length">
      <div class="text-xs text-gray-400 mb-1">Что сделать</div>
      <ul class="list-disc list-inside text-sm text-gray-300">
        <li v-for="(r, i) in recommendations" :key="i">{{ r }}</li>
      </ul>
    </div>

    <div v-if="missingSchema.length" class="text-sm">
      <span class="text-gray-400 text-xs">Не хватает AI-критичной разметки:</span>
      <div class="flex flex-wrap gap-1 pt-1">
        <span v-for="t in missingSchema" :key="t"
              class="rounded-full bg-red-900/40 text-red-300 px-2 py-0.5 text-[11px]">{{ t }}</span>
      </div>
    </div>

    <div v-if="answers.length">
      <div class="text-xs text-gray-400 mb-1">AEO-форматы ответов</div>
      <div class="space-y-2">
        <div v-for="(a, i) in answers.slice(0, 6)" :key="i" class="rounded-lg bg-gray-800/40 p-3 text-sm space-y-1">
          <div class="font-semibold">{{ a.query }} <span class="text-xs text-gray-500">· {{ a.intent }}</span></div>
          <div v-if="a.answer_format" class="text-xs text-gray-300">{{ a.answer_format.tldr }}</div>
          <div v-if="a.answer_format" class="text-[11px] text-gray-500">
            Заголовок: {{ a.answer_format.prompt_friendly_heading }}
          </div>
        </div>
      </div>
    </div>

    <div class="pt-1">
      <button class="btn-secondary text-xs" :disabled="probing" @click="runProbe">
        {{ probing ? 'Проверка…' : 'Проверить видимость в AI-выдаче' }}
      </button>
      <div v-if="probe && probe.probes" class="mt-2 space-y-1">
        <div class="text-[11px] text-gray-500">data_source: {{ probe.data_source }}</div>
        <div v-for="(p, i) in probe.probes.slice(0, 8)" :key="i" class="text-xs flex items-center justify-between">
          <span class="truncate mr-2">{{ p.query }}</span>
          <span :class="p.sge_includes_us ? 'text-emerald-300' : 'text-gray-400'">
            {{ p.sge_includes_us ? 'мы в топе' : 'нет' }}
          </span>
        </div>
      </div>
    </div>
  </section>
</template>
