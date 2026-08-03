<script setup>
/**
 * ForecasterHumanSummaryV2 — блок «Простыми словами» (V2).
 *
 * Показывает человеческое резюме выводов прогноза (из deepseek_summary.human_summary,
 * его пишет backend-переводчик humanizeConclusionsV2 — только когда флаг включён).
 *
 * ДОПОЛНЕНИЕ: если данных нет (флаг выключен или переводчик не отработал) —
 * компонент НЕ рендерит ничего. Оригинальный отчёт при этом не меняется.
 */
defineProps({
  data: { type: Object, default: null },
});
</script>

<template>
  <section
    v-if="data && data.verdict === 'ok' && (data.summary || (data.points && data.points.length))"
    class="bg-emerald-950/30 border border-emerald-800/50 rounded-xl p-4">
    <h2 class="text-sm font-semibold text-emerald-300 mb-2 flex items-center gap-2 flex-wrap">
      <span>💬 Простыми словами</span>
      <span class="text-[10px] font-normal text-emerald-500/70">— для владельца, без терминов</span>
    </h2>

    <p v-if="data.headline" class="text-base font-semibold text-gray-100 mb-2 leading-snug">
      {{ data.headline }}
    </p>

    <p v-if="data.summary" class="text-sm text-gray-200 leading-relaxed mb-3 whitespace-pre-line">
      {{ data.summary }}
    </p>

    <ul v-if="data.points && data.points.length" class="space-y-1.5">
      <li v-for="(p, i) in data.points" :key="i" class="text-sm text-gray-300 leading-relaxed flex gap-2">
        <span class="text-emerald-400 mt-0.5 shrink-0">•</span>
        <span>{{ p }}</span>
      </li>
    </ul>
  </section>
</template>
