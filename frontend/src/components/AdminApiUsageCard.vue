<script setup>
import { computed, onMounted, ref } from 'vue';
import { useAdminStore } from '../stores/admin.js';

const admin = useAdminStore();
const usage = ref(null);
const loading = ref(false);
const error = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    usage.value = await admin.fetchApiUsage();
  } catch (err) {
    const payload = err.response?.data;
    error.value = [payload?.error || err.message || 'Не удалось загрузить API usage', payload?.note]
      .filter(Boolean)
      .join(' — ');
  } finally {
    loading.value = false;
  }
}

function fmtNum(value) {
  return (Number(value) || 0).toLocaleString('ru-RU');
}
function fmtCost(value) {
  const n = Number(value) || 0;
  return '$' + n.toFixed(Math.abs(n) < 0.01 ? 6 : 4);
}
function fmtDate(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch (_) {
    return String(value);
  }
}
function shortId(value) {
  const text = String(value || '');
  return text ? `${text.slice(0, 8)}…` : 'вне задачи';
}
function anomalyLabel(type) {
  return {
    outside_task: 'Вне задачи',
    partial_attribution: 'Неполная привязка',
    cache_miss: 'Cache miss',
    failed: 'Ошибка API',
    retry: 'Повтор',
    high_cost: 'Перерасход',
    review: 'Проверить',
  }[type] || type || 'Проверить';
}
function anomalyClass(type) {
  return {
    outside_task: 'border-amber-800/60 bg-amber-950/30 text-amber-300',
    partial_attribution: 'border-orange-800/60 bg-orange-950/30 text-orange-300',
    cache_miss: 'border-cyan-800/60 bg-cyan-950/30 text-cyan-300',
    failed: 'border-red-800/60 bg-red-950/30 text-red-300',
    retry: 'border-blue-800/60 bg-blue-950/30 text-blue-300',
    high_cost: 'border-fuchsia-800/60 bg-fuchsia-950/30 text-fuchsia-300',
    review: 'border-gray-700 bg-gray-900/40 text-gray-300',
  }[type] || 'border-gray-700 bg-gray-900/40 text-gray-300';
}

const dailyMax = computed(() => Math.max(0, ...(usage.value?.daily || []).map((row) => Number(row.cost_usd) || 0)));
const reconciliationDelta = computed(() => Number(usage.value?.reconciliation?.delta_usd) || 0);
const legacyStageCalls = computed(() => Number(usage.value?.reconciliation?.task_stage_calls) || 0);
const historical = computed(() => usage.value?.historical_task_stages || {});
const displayRequests = computed(() => Number(usage.value?.totals?.requests) || Number(historical.value.calls) || 0);
const displayTokensIn = computed(() => Number(usage.value?.totals?.tokens_in) || Number(historical.value.tokens_in) || 0);
const displayTokensOut = computed(() => Number(usage.value?.totals?.tokens_out) || Number(historical.value.tokens_out) || 0);
const displayCost = computed(() => Number(usage.value?.totals?.cost_usd) || Number(historical.value.cost_usd) || 0);
const ledgerTokenTotal = computed(() => {
  const totals = usage.value?.totals || {};
  return (Number(totals.tokens_in) || 0)
    + (Number(totals.tokens_out) || 0)
    + (Number(totals.thoughts_tokens) || 0);
});

onMounted(load);
</script>

<template>
  <section class="card mt-8" aria-labelledby="api-usage-title">
    <div class="flex flex-wrap items-start justify-between gap-3 mb-4">
      <div>
        <h2 id="api-usage-title" class="text-lg font-semibold text-white">API usage и контроль перерасхода</h2>
        <p class="text-xs text-gray-500 mt-1">Фактические обращения к моделям по ledger за последние 30 дней</p>
      </div>
      <button class="btn-ghost text-xs" :disabled="loading" @click="load">
        {{ loading ? 'Обновляем…' : 'Обновить' }}
      </button>
    </div>

    <div v-if="error" class="rounded-lg border border-red-800/70 bg-red-950/40 px-3 py-2 text-sm text-red-300 mb-4">
      {{ error }}
    </div>

    <template v-if="usage">
      <div v-if="usage.data_quality?.note" class="mb-4 rounded-lg border border-amber-800/70 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
        {{ usage.data_quality.note }}
      </div>
      <div v-if="usage.historical_task_stages?.approximate && !usage.totals.requests" class="mb-4 rounded-lg border border-cyan-800/70 bg-cyan-950/30 px-3 py-2 text-xs text-cyan-200">
        Ledger новых API-вызовов пока пуст. Ниже показан исторический учёт из task_stages: {{ fmtNum(historical.calls) }} calls, {{ fmtCost(historical.cost_usd) }}. Эти значения приблизительные и не включают неуспешные provider attempts.
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
        <div class="rounded-lg bg-gray-900/70 p-3"><div class="text-xl font-bold text-white">{{ fmtNum(displayRequests) }}</div><div class="text-[11px] text-gray-500">API-запросов / stage calls</div></div>
        <div class="rounded-lg bg-gray-900/70 p-3"><div class="text-xl font-bold text-emerald-400">{{ fmtNum(usage.totals.successful) }}</div><div class="text-[11px] text-gray-500">Успешных</div></div>
        <div class="rounded-lg bg-gray-900/70 p-3"><div class="text-xl font-bold text-red-400">{{ fmtNum(usage.totals.failed) }}</div><div class="text-[11px] text-gray-500">Ошибок</div></div>
        <div class="rounded-lg bg-gray-900/70 p-3"><div class="text-xl font-bold text-blue-400">{{ fmtNum(usage.totals.retries) }}</div><div class="text-[11px] text-gray-500">Повторов</div></div>
        <div class="rounded-lg bg-gray-900/70 p-3"><div class="text-xl font-bold text-amber-300">{{ fmtNum(usage.totals.outside_task) }}</div><div class="text-[11px] text-gray-500">Вне задач</div></div>
        <div class="rounded-lg bg-gray-900/70 p-3"><div class="text-xl font-bold text-orange-300">{{ fmtNum(usage.totals.partial_attribution) }}</div><div class="text-[11px] text-gray-500">Неполная привязка</div></div>
        <div class="rounded-lg bg-gray-900/70 p-3"><div class="text-xl font-bold text-cyan-300">{{ fmtNum(displayTokensIn) }}</div><div class="text-[11px] text-gray-500">Input tokens</div></div>
        <div class="rounded-lg bg-gray-900/70 p-3"><div class="text-xl font-bold text-violet-300">{{ fmtNum(displayTokensOut) }}</div><div class="text-[11px] text-gray-500">Output tokens</div></div>
        <div class="rounded-lg bg-gray-900/70 p-3"><div class="text-xl font-bold text-purple-300">{{ fmtNum(usage.totals.thoughts_tokens) }}</div><div class="text-[11px] text-gray-500">Thinking tokens</div></div>
        <div class="rounded-lg bg-gray-900/70 p-3"><div class="text-xl font-bold text-fuchsia-300">{{ fmtCost(displayCost) }}</div><div class="text-[11px] text-gray-500">Стоимость / legacy estimate</div></div>
      </div>

      <div v-if="usage.totals.outside_task || usage.totals.partial_attribution || usage.totals.failed || Math.abs(reconciliationDelta) > 0.000001" class="mt-4 rounded-lg border border-amber-800/70 bg-amber-950/30 p-3 text-sm text-amber-200">
        <div class="font-medium">Требует внимания</div>
        <div class="text-xs text-amber-300/80 mt-1">
          Вне задач: {{ fmtNum(usage.totals.outside_task) }} · Неполная привязка: {{ fmtNum(usage.totals.partial_attribution) }} · Ошибки: {{ fmtNum(usage.totals.failed) }} ·
          Расхождение ledger и task_stages: {{ fmtCost(reconciliationDelta) }}
        </div>
      </div>

      <div class="grid lg:grid-cols-2 gap-5 mt-5">
        <div>
          <h3 class="text-sm font-medium text-gray-300 mb-3">Стоимость по дням</h3>
          <div v-if="usage.daily?.length" class="space-y-2">
            <div v-for="row in usage.daily" :key="row.day" class="flex items-center gap-2 text-xs">
              <span class="w-20 text-gray-500 font-mono">{{ row.day }}</span>
              <div class="flex-1 h-2 rounded-full bg-gray-800 overflow-hidden">
                <div class="h-full rounded-full bg-gradient-to-r from-cyan-500 to-fuchsia-500" :style="{ width: dailyMax ? `${Math.max(3, (Number(row.cost_usd) / dailyMax) * 100)}%` : '0%' }"></div>
              </div>
              <span class="w-20 text-right text-gray-300">{{ fmtCost(row.cost_usd) }}</span>
              <span class="w-16 text-right text-gray-500">{{ fmtNum(row.requests) }} req</span>
            </div>
          </div>
          <div v-else class="text-sm text-gray-500">Ledger ещё не накопил данные.</div>
        </div>

        <div>
          <h3 class="text-sm font-medium text-gray-300 mb-3">Группировка по pipeline</h3>
          <div v-if="usage.by_pipeline?.length" class="space-y-2">
            <div v-for="row in usage.by_pipeline" :key="row.pipeline" class="flex items-center justify-between gap-3 rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-2 text-xs">
              <div><span class="font-medium text-gray-200">{{ row.pipeline }}</span><span class="text-gray-500 ml-2">{{ fmtNum(row.requests) }} req</span></div>
              <div class="text-right"><span class="text-fuchsia-300">{{ fmtCost(row.cost_usd) }}</span><span v-if="row.outside_task" class="text-amber-300 ml-2">{{ fmtNum(row.outside_task) }} вне задач</span></div>
            </div>
          </div>
          <div v-else class="text-sm text-gray-500">Нет группировки.</div>
        </div>
      </div>

      <div class="grid lg:grid-cols-2 gap-5 mt-5">
        <div>
          <h3 class="text-sm font-medium text-gray-300 mb-3">По provider/model</h3>
          <div class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead><tr class="border-b border-gray-800 text-left text-gray-500"><th class="py-2 pr-3">Provider</th><th class="py-2 pr-3">Model</th><th class="py-2 pr-3">Запросы</th><th class="py-2 pr-3">Tokens</th><th class="py-2">Стоимость</th></tr></thead>
              <tbody>
                <tr v-for="row in (usage.by_model || []).slice(0, 8)" :key="`${row.provider}-${row.model}`" class="border-b border-gray-900 text-gray-300"><td class="py-2 pr-3">{{ row.provider }}</td><td class="py-2 pr-3 max-w-44 truncate">{{ row.model }}</td><td class="py-2 pr-3">{{ fmtNum(row.requests) }}</td><td class="py-2 pr-3">{{ fmtNum((Number(row.tokens_in) || 0) + (Number(row.tokens_out) || 0)) }}</td><td class="py-2 text-fuchsia-300">{{ fmtCost(row.cost_usd) }}</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <h3 class="text-sm font-medium text-gray-300 mb-3">Сверка стоимости</h3>
          <div class="rounded-lg border border-gray-800 bg-gray-900/40 p-3 text-sm space-y-2">
            <div class="flex justify-between"><span class="text-gray-500">API ledger</span><span class="text-fuchsia-300">{{ fmtCost(usage.reconciliation?.ledger_cost_usd) }}</span></div>
            <div class="flex justify-between"><span class="text-gray-500">Сохранённые task stages</span><span class="text-gray-300">{{ fmtCost(usage.reconciliation?.task_stage_cost_usd) }}</span></div>
            <div class="flex justify-between"><span class="text-gray-500">Исторические stage calls</span><span class="text-gray-300">{{ fmtNum(legacyStageCalls) }}</span></div>
            <div class="flex justify-between"><span class="text-gray-500">Ledger tokens (input + output + thinking)</span><span class="text-gray-300">{{ fmtNum(ledgerTokenTotal) }}</span></div>
            <div class="flex justify-between border-t border-gray-800 pt-2"><span class="text-gray-300">Разница</span><span :class="Math.abs(reconciliationDelta) > 0.000001 ? 'text-amber-300' : 'text-emerald-300'">{{ fmtCost(reconciliationDelta) }}</span></div>
            <p class="text-[11px] text-gray-600">Ledger учитывает каждый provider attempt, включая retry и ошибки. Task stages содержит только успешно сохранённые этапы.</p>
          </div>
        </div>
      </div>

      <div class="mt-5">
        <div class="flex items-center justify-between gap-3 mb-3">
          <div>
            <h3 class="text-sm font-medium text-gray-300">Расход по задачам</h3>
            <p class="text-[11px] text-gray-600 mt-1">Ledger-authoritative: включает успешные вызовы, retry, repair и provider errors с usage.</p>
          </div>
          <span class="text-[11px] text-gray-600">{{ fmtNum((usage.by_task || []).length) }} групп</span>
        </div>
        <div v-if="usage.by_task?.length" class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead><tr class="border-b border-gray-800 text-left text-gray-500"><th class="py-2 pr-3">Task</th><th class="py-2 pr-3">Pipeline</th><th class="py-2 pr-3">Запросы</th><th class="py-2 pr-3">Tokens</th><th class="py-2 pr-3">Retry/ошибки</th><th class="py-2">Стоимость</th></tr></thead>
            <tbody>
              <tr v-for="row in usage.by_task" :key="`${row.task_ref}-${row.pipeline}`" class="border-b border-gray-900 text-gray-300">
                <td class="py-2 pr-3 font-mono text-gray-400">{{ shortId(row.task_ref) }}</td>
                <td class="py-2 pr-3">{{ row.pipeline || '—' }}</td>
                <td class="py-2 pr-3">{{ fmtNum(row.requests) }}</td>
                <td class="py-2 pr-3">{{ fmtNum((Number(row.tokens_in) || 0) + (Number(row.tokens_out) || 0) + (Number(row.thoughts_tokens) || 0)) }}</td>
                <td class="py-2 pr-3"><span :class="row.failed ? 'text-red-300' : 'text-gray-400'">{{ fmtNum(row.failed) }}</span><span class="text-gray-600"> / {{ fmtNum(row.retries) }}</span></td>
                <td class="py-2 text-fuchsia-300">{{ fmtCost(row.cost_usd) }}<span v-if="row.pricing_unknown" class="text-amber-300 ml-1" title="Есть вызовы с неизвестным тарифом">?</span></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="text-sm text-gray-500">Привязанных обращений за период нет.</div>
      </div>

      <div class="mt-5">
        <h3 class="text-sm font-medium text-gray-300 mb-3">Аномальные обращения</h3>
        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead><tr class="border-b border-gray-800 text-left text-gray-500"><th class="py-2 pr-3">Время</th><th class="py-2 pr-3">Тип</th><th class="py-2 pr-3">Pipeline/stage</th><th class="py-2 pr-3">Task</th><th class="py-2 pr-3">Attempt</th><th class="py-2 pr-3">Tokens</th><th class="py-2">Ошибка/стоимость</th></tr></thead>
            <tbody>
              <tr v-for="row in (usage.anomalies || []).slice(0, 20)" :key="row.id" class="border-b border-gray-900 align-top">
                <td class="py-2 pr-3 text-gray-500 whitespace-nowrap">{{ fmtDate(row.created_at) }}</td>
                <td class="py-2 pr-3"><span class="inline-flex rounded-full border px-2 py-0.5 text-[10px]" :class="anomalyClass(row.anomaly_type)">{{ anomalyLabel(row.anomaly_type) }}</span></td>
                <td class="py-2 pr-3 text-gray-300">{{ row.pipeline || '—' }}<span class="block text-gray-600">{{ row.stage_name || row.call_label || '—' }}</span></td>
                <td class="py-2 pr-3 font-mono text-gray-400">{{ shortId(row.task_id || row.trace_task_id) }}</td>
                <td class="py-2 pr-3 text-gray-400">{{ row.attempt }}</td>
                <td class="py-2 pr-3 text-gray-400">{{ fmtNum((Number(row.tokens_in) || 0) + (Number(row.tokens_out) || 0)) }}</td>
                <td class="py-2 max-w-64 text-gray-400"><span v-if="row.error_message" class="text-red-300">{{ row.error_message }}</span><span v-else>{{ fmtCost(row.cost_usd) }}</span></td>
              </tr>
              <tr v-if="!(usage.anomalies || []).length"><td colspan="7" class="py-5 text-center text-gray-600">Аномалий не обнаружено.</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <p v-if="usage.note" class="text-xs text-gray-600 mt-4">{{ usage.note }}</p>
    </template>
    <div v-else-if="loading" class="text-sm text-gray-500">Загрузка API usage…</div>
  </section>
</template>
