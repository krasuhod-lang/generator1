<script setup>
/**
 * TopPageInsightsCard — реверс-инжиниринг топ-страниц:
 *   • закономерности лидеров выдачи и рекомендации для будущих статей;
 *   • КФ6 / переспам — оценка переоптимизации ПО РАСПАРСЕННОМУ контенту;
 *   • топ-10 дифференциал — что есть у страниц из топа, чего нет у остальных.
 */
import { computed } from 'vue';

const props = defineProps({
  insights: { type: Object, default: null },
});

const available = computed(() => props.insights && props.insights.available);
const patterns = computed(() => (props.insights && props.insights.patterns) || null);
const recommendations = computed(() => (props.insights && props.insights.recommendations) || []);
const overspam = computed(() => (props.insights && props.insights.overspam) || null);
const differential = computed(() => {
  const d = props.insights && props.insights.differential;
  return d && d.available ? d : null;
});
const pages = computed(() => ((props.insights && props.insights.pages) || []).filter((p) => p && !p.error));

function trimUrl(u) {
  if (!u) return '';
  try { const p = new URL(u); return (p.pathname + p.search) || u; } catch (_) { return u; }
}
function levelClass(lvl) {
  if (lvl === 'risk') return 'text-red-300 border-red-500/40';
  if (lvl === 'watch') return 'text-amber-300 border-amber-500/40';
  if (lvl === 'ok') return 'text-emerald-300 border-emerald-500/40';
  return 'text-gray-400 border-gray-600/40';
}
const LEVEL_RU = { risk: 'переспам', watch: 'под наблюдением', ok: 'норма', unknown: 'мало данных' };
</script>

<template>
  <section v-if="available" class="card space-y-4">
    <h2 class="text-sm font-semibold uppercase tracking-wider text-indigo-300">
      🔬 Реверс-инжиниринг топ-страниц
    </h2>

    <!-- Закономерности лидеров -->
    <div v-if="patterns" class="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
      <div class="bg-gray-950 border border-gray-800 rounded-lg p-2">
        <div class="text-[11px] uppercase text-gray-500">Медианный объём</div>
        <div class="font-bold text-indigo-300">{{ patterns.median_word_count }} слов</div>
      </div>
      <div class="bg-gray-950 border border-gray-800 rounded-lg p-2">
        <div class="text-[11px] uppercase text-gray-500">Разделов H2</div>
        <div class="font-bold text-violet-300">{{ patterns.median_h2_count }}</div>
      </div>
      <div class="bg-gray-950 border border-gray-800 rounded-lg p-2">
        <div class="text-[11px] uppercase text-gray-500">Покрытие семантики</div>
        <div class="font-bold text-emerald-300">{{ patterns.avg_query_coverage_pct }}%</div>
      </div>
      <div class="bg-gray-950 border border-gray-800 rounded-lg p-2">
        <div class="text-[11px] uppercase text-gray-500">Со списками / таблицами</div>
        <div class="font-bold text-amber-300">{{ patterns.pct_with_lists }}% / {{ patterns.pct_with_tables }}%</div>
      </div>
    </div>

    <!-- Топ-10 дифференциал: что есть у топа, чего нет у остальных -->
    <div v-if="differential" class="rounded-lg bg-gray-800/40 p-3 space-y-2">
      <div class="text-xs font-semibold text-fuchsia-300">
        Что есть у страниц из топа, чего нет у остальных
        <span class="text-gray-500">(топ: {{ differential.top_count }} · сравнение: {{ differential.rest_count }})</span>
      </div>
      <ul v-if="differential.summary && differential.summary.length" class="list-disc list-inside text-sm text-gray-300 space-y-0.5">
        <li v-for="(s, i) in differential.summary" :key="i">{{ s }}</li>
      </ul>
      <p v-else class="text-xs text-gray-500">Заметных отличий не выявлено.</p>
    </div>

    <!-- КФ6 / переспам -->
    <div v-if="overspam" class="rounded-lg bg-gray-800/40 p-3 space-y-2">
      <div class="text-xs font-semibold text-red-300">
        КФ6 / переспам (по распарсенному контенту · средний {{ overspam.avg_score }}/100)
      </div>
      <div class="flex flex-wrap gap-1.5 text-[11px]">
        <span class="rounded-full border px-2 py-0.5 text-emerald-300 border-emerald-500/40">норма: {{ overspam.by_level.ok }}</span>
        <span class="rounded-full border px-2 py-0.5 text-amber-300 border-amber-500/40">наблюдение: {{ overspam.by_level.watch }}</span>
        <span class="rounded-full border px-2 py-0.5 text-red-300 border-red-500/40">переспам: {{ overspam.by_level.risk }}</span>
      </div>
      <div v-if="overspam.risky_pages && overspam.risky_pages.length" class="space-y-1">
        <div v-for="(p, i) in overspam.risky_pages" :key="i" class="text-xs">
          <span class="text-indigo-300">{{ trimUrl(p.url) }}</span>
          <span class="ml-1" :class="p.level === 'risk' ? 'text-red-300' : 'text-amber-300'">· {{ p.overspam_score }}/100</span>
          <ul class="list-disc list-inside text-gray-400">
            <li v-for="(s, si) in p.signals" :key="si">{{ s }}</li>
          </ul>
        </div>
      </div>
    </div>

    <!-- Профили страниц-лидеров -->
    <div v-if="pages.length" class="space-y-2">
      <div v-for="(p, i) in pages" :key="i" class="rounded-lg bg-gray-800/40 p-3 text-sm space-y-1">
        <div class="flex items-center justify-between gap-2">
          <span class="text-indigo-300 truncate">{{ trimUrl(p.url) }}</span>
          <span class="flex items-center gap-2 shrink-0">
            <span class="text-xs text-gray-400">поз. {{ p.position }} · {{ p.impressions }} показов</span>
            <span v-if="p.overspam" class="rounded-full border px-2 py-0.5 text-[11px]" :class="levelClass(p.overspam.level)">
              КФ6: {{ LEVEL_RU[p.overspam.level] || p.overspam.level }}
            </span>
          </span>
        </div>
        <ul v-if="p.ranking_factors && p.ranking_factors.length" class="list-disc list-inside text-xs text-gray-300">
          <li v-for="(f, fi) in p.ranking_factors" :key="fi">{{ f }}</li>
        </ul>
      </div>
    </div>

    <!-- Рекомендации для будущих статей -->
    <div v-if="recommendations.length" class="rounded-lg bg-gray-800/40 p-3 space-y-1">
      <div class="text-xs font-semibold text-indigo-300">Рекомендации для будущих статей</div>
      <ul class="list-disc list-inside text-sm text-gray-300 space-y-0.5">
        <li v-for="(r, i) in recommendations" :key="i">{{ r }}</li>
      </ul>
    </div>
  </section>
</template>
