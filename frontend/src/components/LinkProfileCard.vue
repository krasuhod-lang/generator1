<script setup>
/**
 * LinkProfileCard — ссылочный профиль и стратегия (п.1, п.2 ТЗ):
 *   • аудит анкор-облака и доноров из CSV-выгрузки GSC «Ссылки»;
 *   • ≥5 рекомендаций «анкор + тема статьи донора + целевой URL».
 * Если ссылочных данных нет — рекомендации помечены data_source: inferred.
 */
import { computed } from 'vue';

const props = defineProps({
  linkAudit: { type: Object, default: null },
});

const available = computed(() => props.linkAudit && props.linkAudit.available);
const recs = computed(() => (props.linkAudit && props.linkAudit.recommendations) || []);
const audit = computed(() => (props.linkAudit && props.linkAudit.audit) || {});
const inferred = computed(() => props.linkAudit && props.linkAudit.data_source === 'inferred');

function trimUrl(u) {
  if (!u) return '';
  try { const p = new URL(u); return (p.pathname + p.search) || u; } catch (_) { return u; }
}
function prioClass(p) {
  if (p === 'high') return 'text-red-300';
  if (p === 'medium') return 'text-amber-300';
  return 'text-gray-300';
}
</script>

<template>
  <section v-if="available" class="card space-y-3">
    <h2 class="text-sm font-semibold uppercase tracking-wider text-indigo-300">
      🔗 Ссылочная стратегия (анкоры / доноры)
    </h2>
    <p v-if="inferred" class="text-xs text-amber-300/80">
      Нет выгрузки «Ссылки» из GSC — рекомендации построены по контентному срезу (data_source: inferred).
      Загрузите CSV «Внешние ссылки», чтобы уточнить анализ доноров.
    </p>

    <div v-if="audit.anchors && audit.anchors.length" class="text-sm">
      <div class="text-xs text-gray-400 mb-1">Анкор-облако</div>
      <div class="flex flex-wrap gap-2">
        <span v-for="a in audit.anchors.slice(0, 12)" :key="a.anchor"
              class="rounded-full bg-gray-800/60 px-2 py-0.5 text-xs">
          {{ a.anchor }} <span class="text-gray-500">×{{ a.count }}</span>
        </span>
      </div>
    </div>

    <div>
      <div class="text-xs text-gray-400 mb-1">Рекомендации к закупке ({{ recs.length }})</div>
      <div class="space-y-2">
        <div v-for="(r, i) in recs" :key="i" class="rounded-lg bg-gray-800/40 p-3 text-sm">
          <div class="flex items-center justify-between">
            <span class="font-semibold">{{ r.anchor }}</span>
            <span class="text-xs uppercase" :class="prioClass(r.priority)">{{ r.priority }}</span>
          </div>
          <div class="text-xs text-gray-400">Тип анкора: {{ r.anchor_type }}</div>
          <div class="text-xs">Тема статьи донора: <span class="text-gray-200">{{ r.donor_topic }}</span></div>
          <div class="text-xs">Целевой URL: <span class="text-indigo-300">{{ trimUrl(r.target_url) }}</span></div>
          <div v-if="r.why" class="text-xs text-gray-500 mt-1">{{ r.why }}</div>
        </div>
      </div>
    </div>
  </section>
</template>
