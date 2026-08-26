<script setup>
/**
 * LinkProfileCard — ссылочный профиль и стратегия (п.1, п.2 ТЗ):
 *   • аудит анкор-облака и доноров из CSV-выгрузки GSC «Ссылки»;
 *   • ≥5 рекомендаций «анкор + тема статьи донора + целевой URL».
 * Если ссылочных данных нет — рекомендации помечены data_source: inferred.
 */
import { computed } from 'vue';
import CopyButton from './CopyButton.vue';
import { toTsv } from '../utils/clipboard.js';

const props = defineProps({
  linkAudit: { type: Object, default: null },
});

const available = computed(() => props.linkAudit && props.linkAudit.available);
const recs = computed(() => (props.linkAudit && props.linkAudit.recommendations) || []);
const audit = computed(() => (props.linkAudit && props.linkAudit.audit) || {});
const inferred = computed(() => props.linkAudit && props.linkAudit.data_source === 'inferred');
const anchorCloud = computed(() => (audit.value.anchors && audit.value.anchors.anchor_cloud) || []);
const targetPages = computed(() => audit.value.target_pages || []);
const targetPageTotals = computed(() => audit.value.target_page_totals || {});
const donors = computed(() => audit.value.donors || []);
const donorTotals = computed(() => audit.value.donor_totals || {});
const competitiveBasis = computed(() => (props.linkAudit && props.linkAudit.competitive_basis) || {});

function trimUrl(u) {
  if (!u) return '';
  try { const p = new URL(u); return (p.pathname + p.search) || u; } catch (_) { return u; }
}
function prioClass(p) {
  if (p === 'high') return 'text-red-300';
  if (p === 'medium') return 'text-amber-300';
  return 'text-gray-300';
}
function prioLabel(p) {
  if (p === 'high') return 'высокий';
  if (p === 'medium') return 'средний';
  return 'низкий';
}

// Что именно покупать: анкорная ссылка с нужным типом анкора или безанкорная.
const BUY = {
  commercial: { what: 'Анкорная', kind: 'коммерческий анкор' },
  branded:    { what: 'Анкорная', kind: 'брендовый анкор' },
  generic:    { what: 'Анкорная', kind: 'общий (разбавляющий) анкор' },
  naked:      { what: 'Безанкорная', kind: 'голый URL / «тут», «здесь»' },
};
function buyInfo(r) {
  const naked = /безанкор/i.test(r.anchor || '');
  return naked ? BUY.naked : (BUY[r.anchor_type] || BUY.generic);
}
function buyText(r) {
  const b = buyInfo(r);
  return `${b.what} ссылка — ${b.kind}`;
}

// Строка для копирования одной рекомендации.
function competitionLabel(signal) {
  const labels = {
    striking_distance: 'зона роста 3–20',
    high_priority_gap: 'приоритетный gap',
    supporting_target: 'поддерживающая цель',
  };
  return labels[signal] || 'сигнал GSC';
}
function rowText(r) {
  const plan = r.anchor_plan || {};
  const brief = r.article_brief || {};
  const lines = [
    `Купить: ${buyText(r)}`,
    `Анкор: ${plan.recommended_anchor || r.anchor}`,
    `Варианты анкоров: ${(plan.variants || []).join(' | ')}`,
    `Тема статьи донора: ${r.donor_topic}`,
  ];
  if (brief.format) lines.push(`Формат статьи: ${brief.format}`);
  if (brief.evidence) lines.push(`Что доказать: ${brief.evidence}`);
  if (r.donor_topic_title) lines.push(`Title: ${r.donor_topic_title}`);
  if (r.donor_topic_description) lines.push(`Description: ${r.donor_topic_description}`);
  if (r.donor_topic_angle) lines.push(`Угол раскрытия: ${r.donor_topic_angle}`);
  if (r.competition && r.competition.signal) lines.push(`Основание: ${competitionLabel(r.competition.signal)}`);
  lines.push(`Целевой URL: ${r.target_url}`);
  lines.push(`Приоритет: ${prioLabel(r.priority)}`);
  return lines.join('\n');
}

// Вся таблица в TSV для вставки в Google Sheets / Excel.
function copyAll() {
  const header = ['Что купить', 'Тип анкора', 'Рекомендуемый анкор', 'Варианты анкоров', 'Формат статьи', 'Тема статьи донора', 'Целевой URL', 'Приоритет'];
  const body = recs.value.map((r) => {
    const b = buyInfo(r);
    const plan = r.anchor_plan || {};
    const brief = r.article_brief || {};
    return [b.what, b.kind, plan.recommended_anchor || r.anchor, (plan.variants || []).join(' | '), brief.format || '', r.donor_topic, r.target_url, prioLabel(r.priority)];
  });
  return toTsv([header, ...body]);
}
</script>

<template>
  <section v-if="available" class="card space-y-3">
    <div class="flex items-center justify-between gap-2">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-indigo-300">
        🔗 Ссылочная стратегия (анкоры / доноры)
      </h2>
      <CopyButton v-if="recs.length" :copy-fn="copyAll" label="Копировать таблицу" />
    </div>
    <p v-if="inferred" class="text-xs text-amber-300/80">
      Нет выгрузки «Ссылки» из GSC — рекомендации построены по контентному срезу (data_source: inferred).
      Загрузите CSV или Excel «Внешние ссылки», чтобы уточнить анализ доноров и целевых страниц.
    </p>
    <p v-else-if="competitiveBasis && competitiveBasis.competitor_backlink_data === false" class="text-xs text-gray-400">
      Рекомендации опираются на собственные GSC-показы/позиции и ссылочный экспорт. Внешние backlink-метрики конкурентов не выдаются GSC и не подменяются догадками.
    </p>

    <div v-if="anchorCloud.length" class="text-sm">
        <div class="text-xs text-gray-400 mb-1">Анкор-облако</div>
      <div class="flex flex-wrap gap-2">
        <span v-for="a in anchorCloud.slice(0, 12)" :key="a.anchor"
              class="rounded-full bg-gray-800/60 px-2 py-0.5 text-xs">
          {{ a.anchor }} <span class="text-gray-500">×{{ a.links }}</span>
        </span>
      </div>
    </div>

    <div v-if="targetPages.length || targetPageTotals.incoming_links" class="space-y-2">
      <div class="flex flex-wrap items-center gap-2 text-xs text-gray-400">
        <span>Top Target Pages</span>
        <span class="rounded bg-gray-800 px-2 py-0.5">страниц: {{ targetPageTotals.target_pages || targetPages.length }}</span>
        <span class="rounded bg-gray-800 px-2 py-0.5">входящих ссылок: {{ targetPageTotals.incoming_links || 0 }}</span>
        <span class="rounded bg-gray-800 px-2 py-0.5">сайтов-доноров: {{ targetPageTotals.referring_sites || 0 }}</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-xs">
          <thead class="text-gray-500 text-left">
            <tr>
              <th class="py-1 pr-2">Страница назначения</th>
              <th class="py-1 px-2">Входящие ссылки</th>
              <th class="py-1 pl-2">Сайты со ссылками</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in targetPages.slice(0, 10)" :key="p.target_page" class="border-t border-gray-800/60 align-top">
              <td class="py-1.5 pr-2 text-indigo-300 break-all">{{ trimUrl(p.target_page) }}</td>
              <td class="py-1.5 px-2 text-gray-200">{{ p.links }}</td>
              <td class="py-1.5 pl-2 text-gray-200">{{ p.referring_sites }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="donors.length || donorTotals.donors" class="space-y-2">
      <div class="flex flex-wrap items-center gap-2 text-xs text-gray-400">
        <span>Top Linking Sites</span>
        <span class="rounded bg-gray-800 px-2 py-0.5">доноров: {{ donorTotals.donors || donors.length }}</span>
        <span class="rounded bg-gray-800 px-2 py-0.5">страниц со ссылками: {{ donorTotals.incoming_link_pages || 0 }}</span>
        <span class="rounded bg-gray-800 px-2 py-0.5">страниц назначения: {{ donorTotals.target_pages || 0 }}</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-xs">
          <thead class="text-gray-500 text-left">
            <tr>
              <th class="py-1 pr-2">Сайт-донор</th>
              <th class="py-1 px-2">Страницы со ссылками</th>
              <th class="py-1 px-2">Страницы назначения</th>
              <th class="py-1 pl-2">Оценка</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in donors.slice(0, 10)" :key="d.host || d.donor" class="border-t border-gray-800/60 align-top">
              <td class="py-1.5 pr-2 text-indigo-300 break-all">{{ d.host || d.donor }}</td>
              <td class="py-1.5 px-2 text-gray-200">{{ d.links || 0 }}</td>
              <td class="py-1.5 px-2 text-gray-200">{{ d.target_pages || 0 }}</td>
              <td class="py-1.5 pl-2 text-gray-200">
                <span>{{ d.trust_score ?? 0 }}/100</span>
                <span v-if="d.coverage_score" class="text-gray-500"> · coverage {{ d.coverage_score }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div>
      <div class="text-xs text-gray-400 mb-1">Рекомендации к закупке ({{ recs.length }})</div>
      <div class="overflow-x-auto">
        <table class="w-full text-xs">
          <thead class="text-gray-500 text-left">
            <tr>
              <th class="py-1 pr-2">Что купить</th>
              <th class="py-1 px-2">Анкор</th>
              <th class="py-1 px-2">Тема статьи донора</th>
              <th class="py-1 px-2">Целевой URL</th>
              <th class="py-1 px-2">Приоритет</th>
              <th class="py-1 pl-2"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in recs" :key="i" class="border-t border-gray-800/60 align-top">
              <td class="py-1.5 pr-2">
                <div class="text-gray-100 font-medium">{{ buyInfo(r).what }} ссылка</div>
                <div class="text-[11px] text-gray-500">{{ buyInfo(r).kind }}</div>
              </td>
              <td class="py-1.5 px-2 text-gray-200">
                <div class="font-medium">{{ (r.anchor_plan && r.anchor_plan.recommended_anchor) || r.anchor }}</div>
                <div v-if="r.anchor_plan && r.anchor_plan.variants && r.anchor_plan.variants.length > 1" class="text-[11px] text-gray-500 mt-0.5">
                  Варианты: {{ r.anchor_plan.variants.slice(0, 4).join(' · ') }}
                </div>
                <div v-if="r.anchor_plan && r.anchor_plan.risk === 'diversify'" class="text-[11px] text-amber-300 mt-0.5">
                  Разбавить профиль; exact-match не ставить подряд
                </div>
              </td>
              <td class="py-1.5 px-2 text-gray-300">
                <div>{{ r.donor_topic }}</div>
                <div v-if="r.donor_topic_title" class="text-[11px] text-indigo-300 mt-0.5">
                  Title: {{ r.donor_topic_title }}
                </div>
                <div v-if="r.donor_topic_description" class="text-[11px] text-gray-400 mt-0.5">
                  Description: {{ r.donor_topic_description }}
                </div>
                <div v-if="r.donor_topic_angle" class="text-[11px] text-gray-500 mt-0.5">
                  Угол: {{ r.donor_topic_angle }}
                </div>
                <div v-if="r.article_brief" class="text-[11px] text-gray-500 mt-0.5">
                  {{ r.article_brief.format }} · {{ r.article_brief.angle }}
                </div>
              </td>
              <td class="py-1.5 px-2 text-indigo-300 break-all">{{ trimUrl(r.target_url) }}</td>
              <td class="py-1.5 px-2 uppercase" :class="prioClass(r.priority)">
                <div>{{ prioLabel(r.priority) }}</div>
                <div v-if="r.competition" class="text-[10px] normal-case text-gray-500 mt-0.5">
                  {{ competitionLabel(r.competition.signal) }}<span v-if="r.competition.position"> · #{{ r.competition.position }}</span>
                </div>
              </td>
              <td class="py-1.5 pl-2"><CopyButton :text="rowText(r)" /></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>
