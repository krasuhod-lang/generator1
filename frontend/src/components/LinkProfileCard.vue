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
function rowText(r) {
  const lines = [
    `Купить: ${buyText(r)}`,
    `Анкор: ${r.anchor}`,
    `Тема статьи донора: ${r.donor_topic}`,
  ];
  if (r.donor_topic_title) lines.push(`Title: ${r.donor_topic_title}`);
  if (r.donor_topic_description) lines.push(`Description: ${r.donor_topic_description}`);
  if (r.donor_topic_angle) lines.push(`Угол раскрытия: ${r.donor_topic_angle}`);
  lines.push(`Целевой URL: ${r.target_url}`);
  lines.push(`Приоритет: ${prioLabel(r.priority)}`);
  return lines.join('\n');
}

// Вся таблица в TSV для вставки в Google Sheets / Excel.
function copyAll() {
  const header = ['Что купить', 'Тип анкора', 'Анкор', 'Тема статьи донора', 'Целевой URL', 'Приоритет'];
  const body = recs.value.map((r) => {
    const b = buyInfo(r);
    return [b.what, b.kind, r.anchor, r.donor_topic, r.target_url, prioLabel(r.priority)];
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
              <td class="py-1.5 px-2 text-gray-200">{{ r.anchor }}</td>
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
              </td>
              <td class="py-1.5 px-2 text-indigo-300 break-all">{{ trimUrl(r.target_url) }}</td>
              <td class="py-1.5 px-2 uppercase" :class="prioClass(r.priority)">{{ prioLabel(r.priority) }}</td>
              <td class="py-1.5 pl-2"><CopyButton :text="rowText(r)" /></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>
