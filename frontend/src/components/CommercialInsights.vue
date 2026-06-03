<script setup>
/**
 * CommercialInsights — карточка «Коммерческий срез» по данным GSC.
 * Показывает детерминированный анализ коммерческого трафика:
 *   • доля коммерческого/брендового трафика;
 *   • распределение запросов по интенту;
 *   • коммерческие запросы в зоне быстрого роста (striking distance);
 *   • CTR-аномалии, каннибализация, несоответствие интента.
 *
 * Принимает объект `commercial` из gsc_snapshot.commercial. Используется
 * и в приватном дашборде, и в публичном (read-only) отчёте.
 */
import { computed } from 'vue';

const props = defineProps({
  commercial: { type: Object, default: null },
  serpVerification: { type: Object, default: null },
});

const data = computed(() => props.commercial || null);
const has = computed(() => !!(data.value && data.value.available));

const INTENT_LABELS = {
  transactional: 'Транзакционные',
  commercial: 'Коммерческие (услуги)',
  investigation: 'Сравнение/выбор',
  informational: 'Информационные',
  navigational: 'Навигационные',
  other: 'Прочие',
};
const INTENT_COLORS = {
  transactional: 'bg-emerald-500',
  commercial: 'bg-teal-500',
  investigation: 'bg-cyan-500',
  informational: 'bg-sky-600',
  navigational: 'bg-violet-600',
  other: 'bg-gray-600',
};

function intentLabel(k) { return INTENT_LABELS[k] || k; }
function intentColor(k) { return INTENT_COLORS[k] || 'bg-gray-600'; }

const distribution = computed(() => (data.value?.intent_distribution || []).filter((d) => d.clicks > 0 || d.queries > 0));
const striking = computed(() => data.value?.striking_distance || []);
const anomalies = computed(() => data.value?.ctr_anomalies || []);
const cannibal = computed(() => data.value?.cannibalization || []);
const mismatch = computed(() => data.value?.intent_mismatch || []);

// SERP-вердикты по каннибализации (проверка по реальному топу Google).
const serpItems = computed(() => props.serpVerification?.items || []);
const serpEngine = computed(() => (props.serpVerification?.engine || 'google').toUpperCase());
const SERP_VERDICT = {
  merge_recommended: { label: 'Сливать', cls: 'bg-orange-500/20 text-orange-300 border-orange-500/40' },
  keep_separate: { label: 'Не сливать', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' },
  inconclusive: { label: 'Нет данных', cls: 'bg-gray-600/20 text-gray-400 border-gray-600/40' },
};
function serpVerdict(v) { return SERP_VERDICT[v] || SERP_VERDICT.inconclusive; }

function shortUrl(u) {
  try { const x = new URL(u); return x.pathname + (x.search || ''); } catch (_) { return u; }
}
</script>

<template>
  <section v-if="has" class="card space-y-4">
    <h2 class="text-sm font-semibold uppercase tracking-wider text-emerald-300">
      💰 Коммерческий срез
    </h2>

    <!-- KPI -->
    <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
      <div class="bg-gray-950 border border-gray-800 rounded-lg p-3">
        <div class="text-[11px] uppercase text-gray-500">Коммерч. трафик (клики)</div>
        <div class="text-xl font-bold text-emerald-300">{{ data.commercial_clicks_pct }}%</div>
      </div>
      <div class="bg-gray-950 border border-gray-800 rounded-lg p-3">
        <div class="text-[11px] uppercase text-gray-500">Коммерч. трафик (показы)</div>
        <div class="text-xl font-bold text-teal-300">{{ data.commercial_impressions_pct }}%</div>
      </div>
      <div class="bg-gray-950 border border-gray-800 rounded-lg p-3">
        <div class="text-[11px] uppercase text-gray-500">Брендовый трафик</div>
        <div class="text-xl font-bold text-violet-300">{{ data.branded_clicks_pct }}%</div>
      </div>
    </div>

    <!-- Распределение по интенту -->
    <div v-if="distribution.length" class="space-y-2">
      <div class="text-xs font-semibold text-gray-400 uppercase">Запросы по интенту</div>
      <div class="flex h-3 w-full overflow-hidden rounded-full bg-gray-800">
        <div v-for="d in distribution" :key="d.intent"
             class="h-full" :class="intentColor(d.intent)"
             :style="{ width: Math.max(2, d.clicksPct) + '%' }"
             :title="`${intentLabel(d.intent)}: ${d.clicksPct}% кликов`"></div>
      </div>
      <div class="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-400">
        <span v-for="d in distribution" :key="d.intent" class="inline-flex items-center gap-1.5">
          <span class="inline-block w-2.5 h-2.5 rounded-sm" :class="intentColor(d.intent)"></span>
          {{ intentLabel(d.intent) }} — {{ d.clicksPct }}% ({{ d.queries }} зпр.)
        </span>
      </div>
    </div>

    <!-- Striking distance -->
    <div v-if="striking.length" class="space-y-1.5">
      <div class="text-xs font-semibold text-emerald-400 uppercase">🚀 Быстрые точки роста (позиции 4–20)</div>
      <div class="overflow-x-auto">
        <table class="w-full text-xs">
          <thead class="text-gray-500 text-left">
            <tr><th class="py-1 pr-2">Запрос</th><th class="py-1 px-2">Показы</th><th class="py-1 px-2">CTR</th><th class="py-1 pl-2">Позиция</th></tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in striking" :key="i" class="border-t border-gray-800/60">
              <td class="py-1 pr-2 text-gray-200">{{ r.query }}</td>
              <td class="py-1 px-2 text-gray-400">{{ r.impressions.toLocaleString('ru') }}</td>
              <td class="py-1 px-2 text-gray-400">{{ r.ctr }}%</td>
              <td class="py-1 pl-2 text-amber-300">{{ r.position }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- CTR-аномалии -->
    <div v-if="anomalies.length" class="space-y-1.5">
      <div class="text-xs font-semibold text-amber-400 uppercase">⚠️ CTR ниже ожидаемого (доработать title/description)</div>
      <div class="overflow-x-auto">
        <table class="w-full text-xs">
          <thead class="text-gray-500 text-left">
            <tr><th class="py-1 pr-2">Запрос</th><th class="py-1 px-2">CTR факт</th><th class="py-1 px-2">CTR норма</th><th class="py-1 pl-2">Позиция</th></tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in anomalies" :key="i" class="border-t border-gray-800/60">
              <td class="py-1 pr-2 text-gray-200">{{ r.query }}</td>
              <td class="py-1 px-2 text-red-300">{{ r.ctr }}%</td>
              <td class="py-1 px-2 text-gray-400">~{{ r.expectedCtr }}%</td>
              <td class="py-1 pl-2 text-amber-300">{{ r.position }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Каннибализация -->
    <div v-if="cannibal.length" class="space-y-1.5">
      <div class="text-xs font-semibold text-orange-400 uppercase">🔁 Каннибализация (несколько URL на один запрос)</div>
      <ul class="space-y-1.5">
        <li v-for="(r, i) in cannibal" :key="i" class="text-xs text-gray-300">
          <span class="text-gray-100 font-medium">{{ r.query }}</span>
          <span class="text-gray-500"> — лучшая позиция {{ r.best_position }}</span>
          <ul class="ml-4 mt-0.5 text-gray-500">
            <li v-for="(p, j) in r.pages" :key="j" class="truncate">• {{ shortUrl(p.page) }} (поз. {{ p.position }})</li>
          </ul>
        </li>
      </ul>
    </div>

    <!-- Верификация каннибализации по топ-выдаче Google -->
    <div v-if="serpItems.length" class="space-y-1.5">
      <div class="text-xs font-semibold text-sky-400 uppercase">🔎 Проверка по топу {{ serpEngine }} (нужно ли сливать разделы)</div>
      <ul class="space-y-1.5">
        <li v-for="(r, i) in serpItems" :key="i" class="text-xs text-gray-300">
          <span class="inline-flex items-center gap-2">
            <span class="px-1.5 py-0.5 rounded border text-[10px] uppercase font-semibold" :class="serpVerdict(r.verdict).cls">
              {{ serpVerdict(r.verdict).label }}
            </span>
            <span class="text-gray-100 font-medium">{{ r.query }}</span>
            <span v-if="r.best_position" class="text-gray-500">— лучшая позиция {{ r.best_position }}, страниц в топе: {{ r.site_pages_in_top_count }}</span>
          </span>
          <div class="ml-1 mt-0.5 text-gray-500">{{ r.recommendation }}</div>
        </li>
      </ul>
    </div>

    <!-- Несоответствие интента -->
    <div v-if="mismatch.length" class="space-y-1.5">
      <div class="text-xs font-semibold text-rose-400 uppercase">🎯 Несоответствие интента (коммерч. запрос → инфо-страница)</div>
      <ul class="space-y-1 text-xs text-gray-300">
        <li v-for="(r, i) in mismatch" :key="i">
          <span class="text-gray-100 font-medium">{{ r.query }}</span>
          <span class="text-gray-500"> → {{ shortUrl(r.landing_page) }} (поз. {{ r.position }})</span>
        </li>
      </ul>
    </div>

    <p class="text-[11px] text-gray-600 pt-1 border-t border-gray-800">
      Срез рассчитан автоматически по данным GSC и использован ИИ для раздела «Коммерческий рост».
    </p>
  </section>
</template>
