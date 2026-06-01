<script setup>
import { ref, computed, onMounted } from 'vue';
import { useAdminStore } from '../stores/admin.js';

const admin = useAdminStore();

// ── Фильтры ────────────────────────────────────────────────────────
const KINDS = [
  { value: '', label: 'Все генераторы' },
  { value: 'info_article', label: 'Инфо-статьи' },
  { value: 'link_article', label: 'Ссылочные статьи' },
  { value: 'meta_tags', label: 'Мета-теги' },
  { value: 'relevance', label: 'Релевантность' },
  { value: 'article_topics', label: 'Темы статей' },
  { value: 'forecaster', label: 'Прогнозатор' },
];
const PERIODS = [
  { value: 7, label: '7 дней' },
  { value: 30, label: '30 дней' },
  { value: 90, label: '90 дней' },
];

const selectedKind = ref('');
const selectedPeriod = ref(30);
const loading = ref(false);
const errorMsg = ref(null);
const data = ref(null);

async function load() {
  loading.value = true;
  errorMsg.value = null;
  try {
    const to = new Date();
    const from = new Date(to.getTime() - selectedPeriod.value * 24 * 60 * 60 * 1000);
    data.value = await admin.fetchFunnels({
      kind: selectedKind.value || null,
      from: from.toISOString(),
      to: to.toISOString(),
    });
  } catch (e) {
    errorMsg.value = (e && e.message) || 'Не удалось загрузить воронки';
    data.value = null;
  } finally {
    loading.value = false;
  }
}

onMounted(load);

// ── Производные данные ─────────────────────────────────────────────
const summaryRows = computed(() => (data.value && Array.isArray(data.value.summary)) ? data.value.summary : []);

// Воронки по kind: { kind: [ { stage, ok, fail, skipped, retry, total, conversion_pct } ] }
const stagesByKind = computed(() => (data.value && data.value.stages) ? data.value.stages : {});
const stageReasons = computed(() => (data.value && data.value.stage_reasons) ? data.value.stage_reasons : {});
const failReasons = computed(() => (data.value && Array.isArray(data.value.fail_reasons)) ? data.value.fail_reasons : []);

const kindList = computed(() => Object.keys(stagesByKind.value));

function kindLabel(k) {
  const found = KINDS.find((x) => x.value === k);
  return found ? found.label : k;
}

function maxTotal(stages) {
  let m = 0;
  for (const s of stages) if (s.total > m) m = s.total;
  return m || 1;
}

function barWidth(stage, stages) {
  return Math.max(2, Math.round((stage.total / maxTotal(stages)) * 100));
}

function topReasonsForStage(kind, stage) {
  const byStage = stageReasons.value[kind] || {};
  const arr = byStage[stage] || [];
  return arr.slice(0, 3);
}

function fmtPct(v) {
  return (v == null ? 0 : Number(v)).toFixed(1) + '%';
}

function fmtCost(usd) {
  const n = parseFloat(usd);
  if (!n) return '$0';
  return '$' + n.toFixed(4);
}

function fmtMs(ms) {
  const n = Number(ms) || 0;
  if (n < 1000) return n + ' мс';
  return (n / 1000).toFixed(1) + ' с';
}

function convColor(pct) {
  if (pct >= 90) return 'bg-emerald-500';
  if (pct >= 70) return 'bg-blue-500';
  if (pct >= 40) return 'bg-amber-500';
  return 'bg-red-500';
}
</script>

<template>
  <div class="card mb-8">
    <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
      <h2 class="text-lg font-bold text-white">🪜 Воронки генерации</h2>
      <div class="flex flex-wrap items-center gap-2">
        <select v-model="selectedKind" class="input text-xs py-1" @change="load">
          <option v-for="k in KINDS" :key="k.value" :value="k.value">{{ k.label }}</option>
        </select>
        <select v-model.number="selectedPeriod" class="input text-xs py-1" @change="load">
          <option v-for="p in PERIODS" :key="p.value" :value="p.value">{{ p.label }}</option>
        </select>
        <button class="btn-ghost text-xs" :disabled="loading" @click="load">⟳ Обновить</button>
      </div>
    </div>

    <div v-if="errorMsg" class="text-sm text-red-400 py-4">{{ errorMsg }}</div>
    <div v-else-if="loading" class="text-sm text-gray-400 py-4">Загрузка…</div>
    <div v-else-if="!kindList.length" class="text-sm text-gray-500 py-4">
      Нет данных по воронкам за выбранный период.
    </div>

    <template v-else>
      <!-- Сводка успех/провал по kind -->
      <div class="overflow-x-auto mb-6">
        <table class="w-full text-xs">
          <thead>
            <tr class="border-b border-gray-800 text-left text-gray-400">
              <th class="py-2 px-2 font-medium">Генератор</th>
              <th class="py-2 px-2 font-medium">Всего</th>
              <th class="py-2 px-2 font-medium">Успешно</th>
              <th class="py-2 px-2 font-medium">Провал</th>
              <th class="py-2 px-2 font-medium">Конверсия</th>
              <th class="py-2 px-2 font-medium">$ успех</th>
              <th class="py-2 px-2 font-medium">$ провал</th>
              <th class="py-2 px-2 font-medium">⏱ успех</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in summaryRows" :key="row.kind" class="border-b border-gray-800/50">
              <td class="py-2 px-2 text-gray-200">{{ kindLabel(row.kind) }}</td>
              <td class="py-2 px-2 text-gray-300">{{ row.total }}</td>
              <td class="py-2 px-2 text-emerald-400">{{ row.completed }}</td>
              <td class="py-2 px-2 text-red-400">{{ row.failed }}</td>
              <td class="py-2 px-2 text-blue-300">
                {{ fmtPct(row.total ? (row.completed / row.total) * 100 : 0) }}
              </td>
              <td class="py-2 px-2 text-cyan-300">{{ fmtCost(row.avg_cost_completed) }}</td>
              <td class="py-2 px-2 text-gray-400">{{ fmtCost(row.avg_cost_failed) }}</td>
              <td class="py-2 px-2 text-gray-400">{{ fmtMs(row.avg_duration_completed) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Пошаговые воронки по kind -->
      <div v-for="k in kindList" :key="k" class="mb-6">
        <h3 class="text-sm font-semibold text-gray-200 mb-2">{{ kindLabel(k) }}</h3>
        <div class="space-y-1">
          <div
            v-for="stage in stagesByKind[k]"
            :key="stage.stage"
            class="flex items-center gap-3"
          >
            <div class="w-44 shrink-0 text-xs text-gray-400 truncate" :title="stage.stage">
              {{ stage.stage }}
            </div>
            <div class="flex-1 bg-gray-800/40 rounded h-5 relative overflow-hidden">
              <div
                class="h-full rounded transition-all"
                :class="convColor(stage.conversion_pct)"
                :style="{ width: barWidth(stage, stagesByKind[k]) + '%' }"
              ></div>
              <div class="absolute inset-0 flex items-center px-2 text-[10px] text-white/90 justify-between">
                <span>{{ stage.ok }}/{{ stage.total }} · {{ fmtPct(stage.conversion_pct) }}</span>
                <span v-if="stage.fail" class="text-red-200">✗ {{ stage.fail }}</span>
              </div>
            </div>
            <div class="w-56 shrink-0 text-[10px] text-gray-500 truncate">
              <span
                v-for="r in topReasonsForStage(k, stage.stage)"
                :key="r.reason"
                class="inline-block mr-2"
              >
                <span class="text-red-300">{{ r.reason }}</span>×{{ r.n }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- Топ причин обрыва воронки -->
      <div v-if="failReasons.length" class="mt-4">
        <h3 class="text-sm font-semibold text-gray-200 mb-2">Топ причин обрыва</h3>
        <div class="flex flex-wrap gap-2">
          <span
            v-for="(fr, i) in failReasons.slice(0, 12)"
            :key="i"
            class="text-[11px] px-2 py-1 rounded bg-red-500/10 text-red-300 border border-red-500/20"
          >
            {{ kindLabel(fr.kind) }}: {{ fr.reason }} ×{{ fr.n }}
          </span>
        </div>
      </div>
    </template>
  </div>
</template>
