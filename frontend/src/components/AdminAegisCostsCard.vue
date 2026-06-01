<script setup>
import { ref, computed, onMounted } from 'vue';
import { useAdminStore } from '../stores/admin.js';

const admin = useAdminStore();

// ── Фильтры периода ────────────────────────────────────────────────
const PERIODS = [
  { value: 7, label: '7 дней' },
  { value: 30, label: '30 дней' },
  { value: 90, label: '90 дней' },
  { value: 0, label: 'Свой период' },
];

const selectedPeriod = ref(30);
const customFrom = ref('');
const customTo = ref('');
const loading = ref(false);
const errorMsg = ref(null);
const data = ref(null);

function _range() {
  // Свой период: используем выбранные даты (включительно по дню «to»).
  if (selectedPeriod.value === 0 && customFrom.value && customTo.value) {
    const from = new Date(customFrom.value + 'T00:00:00');
    const to = new Date(customTo.value + 'T00:00:00');
    to.setDate(to.getDate() + 1); // верхняя граница эксклюзивна
    return { from: from.toISOString(), to: to.toISOString() };
  }
  const to = new Date();
  const days = selectedPeriod.value || 30;
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

async function load() {
  loading.value = true;
  errorMsg.value = null;
  try {
    data.value = await admin.fetchAegisCosts(_range());
  } catch (e) {
    errorMsg.value = (e && e.message) || 'Не удалось загрузить расходы Эгиды';
    data.value = null;
  } finally {
    loading.value = false;
  }
}

onMounted(load);

// ── Производные данные ─────────────────────────────────────────────
const totals = computed(() => (data.value && data.value.totals) ? data.value.totals : null);
const daily = computed(() => (data.value && Array.isArray(data.value.daily)) ? data.value.daily : []);
const byProvider = computed(() => (data.value && Array.isArray(data.value.by_provider)) ? data.value.by_provider : []);
const note = computed(() => (data.value && data.value.note) ? data.value.note : null);

const maxDailyCost = computed(() => {
  let m = 0;
  for (const d of daily.value) { const c = parseFloat(d.cost_usd) || 0; if (c > m) m = c; }
  return m || 1;
});

function costBarWidth(row) {
  const c = parseFloat(row.cost_usd) || 0;
  return Math.max(2, Math.round((c / maxDailyCost.value) * 100));
}

function fmtCost(usd) {
  const n = parseFloat(usd) || 0;
  if (!n) return '$0';
  if (n < 0.01) return '$' + n.toFixed(5);
  return '$' + n.toFixed(4);
}

function fmtInt(v) {
  return new Intl.NumberFormat('ru-RU').format(Number(v) || 0);
}

function fmtPct(v) {
  return (v == null ? 0 : Number(v)).toFixed(1) + '%';
}

function fmtDay(d) {
  if (!d) return '';
  // d — ISO date (YYYY-MM-DD) или timestamp.
  const s = String(d).slice(0, 10);
  const parts = s.split('-');
  if (parts.length === 3) return `${parts[2]}.${parts[1]}`;
  return s;
}

// Доля кэш-хитов по дню (для подсветки «кушает ли Эгида кэш»).
function dayCacheHitPct(row) {
  const calls = Number(row.calls) || 0;
  if (!calls) return 0;
  return Number((((Number(row.cache_hits) || 0) / calls) * 100).toFixed(1));
}

function dayCachedTokenPct(row) {
  const tin = Number(row.tokens_in) || 0;
  if (!tin) return 0;
  return Number((((Number(row.cached_tokens) || 0) / tin) * 100).toFixed(1));
}
</script>

<template>
  <div class="card mb-8">
    <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
      <h2 class="text-lg font-bold text-white">💸 Расходы Эгиды по дням</h2>
      <div class="flex flex-wrap items-center gap-2">
        <select v-model.number="selectedPeriod" class="input text-xs py-1" @change="load">
          <option v-for="p in PERIODS" :key="p.value" :value="p.value">{{ p.label }}</option>
        </select>
        <template v-if="selectedPeriod === 0">
          <input v-model="customFrom" type="date" class="input text-xs py-1" />
          <span class="text-gray-500 text-xs">—</span>
          <input v-model="customTo" type="date" class="input text-xs py-1" />
        </template>
        <button class="btn-ghost text-xs" :disabled="loading" @click="load">⟳ Обновить</button>
      </div>
    </div>

    <div v-if="errorMsg" class="text-sm text-red-400 py-4">{{ errorMsg }}</div>
    <div v-else-if="loading" class="text-sm text-gray-400 py-4">Загрузка…</div>
    <div v-else-if="note" class="text-sm text-gray-500 py-4">
      Учёт расходов Эгиды ещё не инициализирован (таблица aegis_llm_usage пуста).
    </div>
    <div v-else-if="!daily.length" class="text-sm text-gray-500 py-4">
      Нет расходов Эгиды за выбранный период.
    </div>

    <template v-else>
      <!-- Итоги периода -->
      <div v-if="totals" class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <div class="bg-gray-800/40 rounded-lg p-3">
          <div class="text-lg font-bold text-cyan-300">{{ fmtCost(totals.cost_usd) }}</div>
          <div class="text-xs text-gray-400 mt-1">Стоимость за период</div>
        </div>
        <div class="bg-gray-800/40 rounded-lg p-3">
          <div class="text-lg font-bold text-white">{{ fmtInt(totals.calls) }}</div>
          <div class="text-xs text-gray-400 mt-1">Вызовов LLM</div>
        </div>
        <div class="bg-gray-800/40 rounded-lg p-3">
          <div class="text-lg font-bold text-emerald-300">{{ fmtPct(totals.cache_hit_rate_pct) }}</div>
          <div class="text-xs text-gray-400 mt-1">
            Кэш-хиты ({{ fmtPct(totals.cached_token_pct) }} input-токенов)
          </div>
        </div>
        <div class="bg-gray-800/40 rounded-lg p-3">
          <div class="text-lg font-bold text-white">
            {{ fmtInt(totals.tokens_in) }} <span class="text-gray-500">/</span> {{ fmtInt(totals.tokens_out) }}
          </div>
          <div class="text-xs text-gray-400 mt-1">Токены in / out</div>
        </div>
      </div>

      <!-- Разбивка по провайдерам -->
      <div v-if="byProvider.length" class="overflow-x-auto mb-6">
        <table class="w-full text-xs">
          <thead>
            <tr class="border-b border-gray-800 text-left text-gray-400">
              <th class="py-2 px-2 font-medium">Провайдер</th>
              <th class="py-2 px-2 font-medium">Вызовов</th>
              <th class="py-2 px-2 font-medium">Стоимость</th>
              <th class="py-2 px-2 font-medium">Токены in</th>
              <th class="py-2 px-2 font-medium">Токены out</th>
              <th class="py-2 px-2 font-medium">Кэш-хиты</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in byProvider" :key="row.provider" class="border-b border-gray-800/50">
              <td class="py-2 px-2 text-gray-200 capitalize">{{ row.provider }}</td>
              <td class="py-2 px-2 text-gray-300">{{ fmtInt(row.calls) }}</td>
              <td class="py-2 px-2 text-cyan-300">{{ fmtCost(row.cost_usd) }}</td>
              <td class="py-2 px-2 text-gray-400">{{ fmtInt(row.tokens_in) }}</td>
              <td class="py-2 px-2 text-gray-400">{{ fmtInt(row.tokens_out) }}</td>
              <td class="py-2 px-2 text-emerald-400">{{ fmtInt(row.cache_hits) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Суточный ряд -->
      <div class="overflow-x-auto">
        <table class="w-full text-xs">
          <thead>
            <tr class="border-b border-gray-800 text-left text-gray-400">
              <th class="py-2 px-2 font-medium">День</th>
              <th class="py-2 px-2 font-medium w-1/4">Стоимость</th>
              <th class="py-2 px-2 font-medium">Вызовов</th>
              <th class="py-2 px-2 font-medium">Токены in / out</th>
              <th class="py-2 px-2 font-medium">Кэш</th>
              <th class="py-2 px-2 font-medium">Ошибки</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in daily" :key="row.day" class="border-b border-gray-800/50">
              <td class="py-2 px-2 text-gray-200 whitespace-nowrap">{{ fmtDay(row.day) }}</td>
              <td class="py-2 px-2">
                <div class="flex items-center gap-2">
                  <div class="flex-1 bg-gray-800 rounded h-2 min-w-[40px]">
                    <div class="bg-cyan-500 h-2 rounded" :style="{ width: costBarWidth(row) + '%' }"></div>
                  </div>
                  <span class="text-cyan-300 whitespace-nowrap">{{ fmtCost(row.cost_usd) }}</span>
                </div>
              </td>
              <td class="py-2 px-2 text-gray-300">{{ fmtInt(row.calls) }}</td>
              <td class="py-2 px-2 text-gray-400 whitespace-nowrap">
                {{ fmtInt(row.tokens_in) }} / {{ fmtInt(row.tokens_out) }}
              </td>
              <td class="py-2 px-2 whitespace-nowrap">
                <span class="text-emerald-400">{{ fmtPct(dayCacheHitPct(row)) }}</span>
                <span class="text-gray-600 mx-1">·</span>
                <span class="text-gray-400">{{ fmtPct(dayCachedTokenPct(row)) }} ток.</span>
              </td>
              <td class="py-2 px-2" :class="(Number(row.errors) || 0) > 0 ? 'text-red-400' : 'text-gray-500'">
                {{ fmtInt(row.errors) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="text-[11px] text-gray-500 mt-3">
        Учитываются LLM-вызовы Эгиды через её роутер (критик/писатель, фолбэк-цепочки).
        «Кэш» — доля вызовов с попаданием в prompt-кэш и доля закэшированных input-токенов.
      </p>
    </template>
  </div>
</template>
