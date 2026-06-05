<script setup>
/**
 * ActionPlanCard — карточка «План действий» (ТЗ п.3).
 * Связывает аналитические срезы GSC в конкретные, посчитанные рекомендации:
 *   • конкретные мета-теги (было → стало) с ожидаемым эффектом;
 *   • точки быстрого роста (striking distance) с расчётом доп. кликов;
 *   • content refresh затухающих страниц с цифрами тренда;
 *   • устранение каннибализации (что с чем сливать/разводить);
 *   • конкретные темы статей под незакрытый спрос.
 *
 * Принимает объект `plan` из gsc_snapshot.action_plan. Полностью read-only,
 * используется и в приватном дашборде, и в публичном (share) отчёте.
 */
import { computed } from 'vue';
import CopyButton from './CopyButton.vue';

const props = defineProps({
  plan: { type: Object, default: null },
});

const data = computed(() => props.plan || null);
const has = computed(() => !!(data.value && data.value.available));
const summary = computed(() => data.value?.summary || {});
const metaChanges = computed(() => data.value?.meta_changes || []);
const striking = computed(() => data.value?.striking_distance || []);
const refresh = computed(() => data.value?.content_refresh || []);
const cannibal = computed(() => data.value?.cannibalization || []);
const topics = computed(() => (data.value?.article_topics || []).filter((t) => t.title));
const patterns = computed(() => (data.value?.article_topics || []).filter((t) => !t.title && (t.recommendation)));

function fmt(n) { return Number(n || 0).toLocaleString('ru'); }
function shortUrl(u) {
  try { const x = new URL(u); return x.pathname + (x.search || ''); } catch (_) { return u || '—'; }
}

const VERDICT = {
  merge_recommended: { label: 'Сливать', cls: 'bg-orange-500/20 text-orange-300 border-orange-500/40' },
  keep_separate: { label: 'Развести', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' },
  inconclusive: { label: 'Проверить', cls: 'bg-gray-600/20 text-gray-400 border-gray-600/40' },
};
function verdict(v) { return VERDICT[v] || VERDICT.inconclusive; }

// Готовый текст карточки целиком для копирования в задачу/ТЗ.
const planText = computed(() => {
  const L = [];
  L.push('ПЛАН ДЕЙСТВИЙ');
  if (summary.value.est_extra_clicks) L.push(`Потенциал: +${fmt(summary.value.est_extra_clicks)} кликов/период`);
  if (summary.value.est_recoverable_weekly_clicks) L.push(`Возврат затухающего трафика: ~${fmt(summary.value.est_recoverable_weekly_clicks)} кликов/нед`);
  if (metaChanges.value.length) {
    L.push('', '— МЕТА-ТЕГИ —');
    metaChanges.value.forEach((m) => {
      L.push(`URL: ${m.url}`);
      if (m.keyword) L.push(`Запрос: ${m.keyword}`);
      if (m.before?.title) L.push(`Было (title): ${m.before.title}`);
      if (m.suggested?.title) L.push(`Стало (title): ${m.suggested.title}`);
      if (m.suggested?.description) L.push(`Стало (description): ${m.suggested.description}`);
      if (m.suggested?.h1) L.push(`Стало (H1): ${m.suggested.h1}`);
      L.push(`Почему: ${m.why}`);
      L.push('');
    });
  }
  if (striking.value.length) {
    L.push('— ТОЧКИ БЫСТРОГО РОСТА —');
    striking.value.forEach((s) => L.push(`«${s.query}» (поз. ${s.position}) → +${fmt(s.expected_extra_clicks)} кликов: ${s.action}`));
    L.push('');
  }
  if (refresh.value.length) {
    L.push('— ОБНОВЛЕНИЕ КОНТЕНТА —');
    refresh.value.forEach((r) => L.push(`${shortUrl(r.url)} (тренд ${r.slope_pct_per_week}%/нед): ${r.action}`));
    L.push('');
  }
  if (cannibal.value.length) {
    L.push('— КАННИБАЛИЗАЦИЯ —');
    cannibal.value.forEach((c) => L.push(`«${c.query}» [${verdict(c.verdict).label}]: ${c.action}`));
    L.push('');
  }
  if (topics.value.length) {
    L.push('— ТЕМЫ СТАТЕЙ —');
    topics.value.forEach((t) => L.push(`${t.title} — ${t.why}`));
  }
  return L.join('\n');
});
</script>

<template>
  <section v-if="has" class="card space-y-4">
    <div class="flex items-center justify-between gap-2">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-amber-300">
        План действий
      </h2>
      <CopyButton :text="planText" label="Копировать план" />
    </div>
    <p class="text-xs text-gray-500 -mt-2">
      Конкретные, посчитанные рекомендации: что менять, на что и зачем — с ожидаемым эффектом.
    </p>

    <!-- Сводка потенциала -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div class="bg-gray-950 border border-amber-800/40 rounded-lg p-3">
        <div class="text-[11px] uppercase text-gray-500">Потенциал кликов</div>
        <div class="text-xl font-bold text-amber-300">+{{ fmt(summary.est_extra_clicks) }}</div>
      </div>
      <div class="bg-gray-950 border border-gray-800 rounded-lg p-3">
        <div class="text-[11px] uppercase text-gray-500">Возврат/нед</div>
        <div class="text-xl font-bold text-emerald-300">~{{ fmt(summary.est_recoverable_weekly_clicks) }}</div>
      </div>
      <div class="bg-gray-950 border border-gray-800 rounded-lg p-3">
        <div class="text-[11px] uppercase text-gray-500">Мета-теги</div>
        <div class="text-xl font-bold text-sky-300">{{ summary.meta_changes_count || 0 }}</div>
      </div>
      <div class="bg-gray-950 border border-gray-800 rounded-lg p-3">
        <div class="text-[11px] uppercase text-gray-500">Темы статей</div>
        <div class="text-xl font-bold text-violet-300">{{ summary.article_topics_count || 0 }}</div>
      </div>
    </div>

    <!-- Мета-теги: было → стало -->
    <div v-if="metaChanges.length" class="space-y-2">
      <div class="text-xs font-semibold text-gray-400 uppercase">Мета-теги: было → стало</div>
      <div v-for="(m, i) in metaChanges" :key="'m' + i"
           class="bg-gray-950 border border-gray-800 rounded-lg p-3 space-y-2">
        <div class="flex items-center justify-between gap-2">
          <a :href="m.url" target="_blank" rel="noopener"
             class="text-xs text-sky-400 hover:underline truncate">{{ shortUrl(m.url) }}</a>
          <span v-if="m.expected_effect && m.expected_effect.extra_clicks"
                class="shrink-0 text-[11px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40">
            +{{ fmt(m.expected_effect.extra_clicks) }} кликов
          </span>
        </div>
        <div v-if="m.keyword" class="text-[11px] text-gray-500">Главный запрос: «{{ m.keyword }}»</div>
        <div v-if="m.suggested" class="space-y-1.5 text-xs">
          <div v-if="m.before && m.before.title">
            <span class="text-gray-500">Title было:</span>
            <span class="text-gray-400 line-through ml-1">{{ m.before.title }}</span>
          </div>
          <div v-if="m.suggested.title">
            <span class="text-gray-500">Title стало:</span>
            <span class="text-emerald-300 ml-1">{{ m.suggested.title }}</span>
          </div>
          <div v-if="m.suggested.description">
            <span class="text-gray-500">Description:</span>
            <span class="text-gray-200 ml-1">{{ m.suggested.description }}</span>
          </div>
          <div v-if="m.suggested.h1">
            <span class="text-gray-500">H1:</span>
            <span class="text-gray-200 ml-1">{{ m.suggested.h1 }}</span>
          </div>
        </div>
        <div v-else class="text-[11px] text-gray-500 italic">
          Конкретные значения сгенерирует мета-генератор при перегенерации (нужны ключи интеграций).
        </div>
        <div class="text-[11px] text-gray-400">{{ m.why }}</div>
      </div>
    </div>

    <!-- Точки быстрого роста -->
    <div v-if="striking.length" class="space-y-2">
      <div class="text-xs font-semibold text-gray-400 uppercase">Точки быстрого роста (striking distance)</div>
      <div class="overflow-x-auto">
        <table class="w-full text-xs">
          <thead class="text-gray-500">
            <tr class="text-left border-b border-gray-800">
              <th class="py-1 pr-2 font-medium">Запрос</th>
              <th class="py-1 px-2 font-medium text-right">Поз.</th>
              <th class="py-1 px-2 font-medium text-right">Показы</th>
              <th class="py-1 px-2 font-medium text-right">+Клики</th>
              <th class="py-1 pl-2 font-medium">Действие</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(s, i) in striking" :key="'s' + i" class="border-b border-gray-900 align-top">
              <td class="py-1.5 pr-2 text-gray-200">{{ s.query }}</td>
              <td class="py-1.5 px-2 text-right text-gray-400">{{ s.position }}</td>
              <td class="py-1.5 px-2 text-right text-gray-400">{{ fmt(s.impressions) }}</td>
              <td class="py-1.5 px-2 text-right font-semibold text-amber-300">+{{ fmt(s.expected_extra_clicks) }}</td>
              <td class="py-1.5 pl-2 text-gray-400">{{ s.action }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Обновление контента -->
    <div v-if="refresh.length" class="space-y-2">
      <div class="text-xs font-semibold text-gray-400 uppercase">Обновить контент (затухающие страницы)</div>
      <div v-for="(r, i) in refresh" :key="'r' + i"
           class="bg-gray-950 border border-gray-800 rounded-lg p-3 space-y-1">
        <div class="flex items-center justify-between gap-2">
          <a :href="r.url" target="_blank" rel="noopener"
             class="text-xs text-sky-400 hover:underline truncate">{{ shortUrl(r.url) }}</a>
          <span class="shrink-0 text-[11px] px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/40">
            {{ r.slope_pct_per_week }}%/нед
          </span>
        </div>
        <div class="text-[11px] text-gray-300">{{ r.action }}</div>
        <div class="text-[11px] text-gray-500">{{ r.why }}</div>
      </div>
    </div>

    <!-- Каннибализация -->
    <div v-if="cannibal.length" class="space-y-2">
      <div class="text-xs font-semibold text-gray-400 uppercase">Устранить каннибализацию</div>
      <div v-for="(c, i) in cannibal" :key="'c' + i"
           class="bg-gray-950 border border-gray-800 rounded-lg p-3 space-y-1">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-gray-200">«{{ c.query }}» · поз. {{ c.best_position }} · {{ (c.pages || []).length }} URL</span>
          <span class="shrink-0 text-[11px] px-2 py-0.5 rounded-full border" :class="verdict(c.verdict).cls">
            {{ verdict(c.verdict).label }}
          </span>
        </div>
        <div class="text-[11px] text-gray-300">{{ c.action }}</div>
        <div class="text-[11px] text-gray-500">{{ c.why }}</div>
      </div>
    </div>

    <!-- Темы статей -->
    <div v-if="topics.length" class="space-y-2">
      <div class="text-xs font-semibold text-gray-400 uppercase">Темы статей под спрос</div>
      <div v-for="(t, i) in topics" :key="'t' + i"
           class="bg-gray-950 border border-gray-800 rounded-lg p-3 space-y-1">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-semibold text-gray-100">{{ t.title }}</span>
          <span v-if="t.expected_effect && t.expected_effect.impressions_in_demand"
                class="shrink-0 text-[11px] px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-300 border border-violet-500/40">
            {{ fmt(t.expected_effect.impressions_in_demand) }} показов спроса
          </span>
        </div>
        <div v-if="t.description" class="text-[11px] text-gray-400">{{ t.description }}</div>
        <div class="text-[11px] text-gray-500">{{ t.why }}</div>
        <div v-if="t.target_keywords && t.target_keywords.length" class="flex flex-wrap gap-1 pt-0.5">
          <span v-for="(kw, k) in t.target_keywords.slice(0, 6)" :key="'kw' + k"
                class="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">{{ kw }}</span>
        </div>
      </div>
    </div>

    <!-- Паттерны лидеров -->
    <div v-if="patterns.length" class="space-y-1">
      <div class="text-xs font-semibold text-gray-400 uppercase">Повторить у лидеров топа</div>
      <ul class="list-disc list-inside text-[11px] text-gray-400 space-y-0.5">
        <li v-for="(p, i) in patterns" :key="'p' + i">{{ p.recommendation }}</li>
      </ul>
    </div>
  </section>
</template>
