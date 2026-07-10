<script setup>
/**
 * ProposalSharedPage — публичная read-only страница КП по share-ссылке.
 * Фронт работ и стоимость — в отдельных вкладках (требование ТЗ).
 * Без авторизации; данные отдаёт GET /api/public/proposal/:token.
 */
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import api from '../api.js';

const route = useRoute();

const loading = ref(true);
const error = ref(null);
const data = ref(null);
const tab = ref('work'); // work | pricing

const PRIORITY_BADGE = {
  high: { label: '🔴 Высокий', cls: 'bg-red-900/50 text-red-300' },
  medium: { label: '🟡 Средний', cls: 'bg-yellow-900/50 text-yellow-300' },
  low: { label: '🟢 Низкий', cls: 'bg-emerald-900/50 text-emerald-300' },
};

const months = computed(() =>
  Array.from({ length: Number(data.value?.proposal?.horizon) || 3 }, (_, i) => i + 1));

function fmtMoney(v) { return Number(v || 0).toLocaleString('ru-RU'); }
function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('ru-RU');
}
function rowTotal(p) {
  return (Number(p.base_budget) || 0) + (Number(p.additional_budget) || 0);
}

const pricingByMonth = computed(() => {
  const byMonth = {};
  for (const p of data.value?.pricing || []) {
    const key = p.month == null ? 'total' : Number(p.month);
    if (!byMonth[key]) byMonth[key] = { base: 0, add: 0 };
    byMonth[key].base += Number(p.base_budget) || 0;
    byMonth[key].add += Number(p.additional_budget) || 0;
  }
  return byMonth;
});

onMounted(async () => {
  try {
    const { data: resp } = await api.get(`/public/proposal/${route.params.token}`);
    data.value = resp;
  } catch (e) {
    error.value = e.response?.status === 404
      ? 'Ссылка не найдена или отозвана.'
      : 'Не удалось загрузить КП. Попробуйте позже.';
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="min-h-screen bg-gray-950 text-gray-100">
    <div class="max-w-6xl mx-auto p-6">
      <div v-if="loading" class="text-center py-20 text-gray-400">Загрузка…</div>
      <div v-else-if="error" class="text-center py-20 text-red-400">{{ error }}</div>

      <template v-else>
        <!-- Шапка -->
        <header class="mb-6">
          <h1 class="text-2xl font-semibold">{{ data.proposal.title }}</h1>
          <div class="flex flex-wrap gap-x-6 gap-y-1 mt-2 text-sm text-gray-400">
            <span v-if="data.proposal.client">Клиент: <span class="text-gray-200">{{ data.proposal.client }}</span></span>
            <span v-if="data.proposal.manager">Менеджер: <span class="text-gray-200">{{ data.proposal.manager }}</span></span>
            <span>Горизонт: <span class="text-gray-200">{{ data.proposal.horizon }} мес.</span></span>
            <span>Дата начала: <span class="text-gray-200">{{ fmtDate(data.proposal.start_date) }}</span></span>
          </div>
        </header>

        <!-- Вкладки: Фронт работ / Стоимость -->
        <div class="flex rounded-lg overflow-hidden border border-gray-700 text-sm w-fit mb-5">
          <button @click="tab = 'work'" class="px-5 py-2 font-medium transition"
            :class="tab === 'work' ? 'bg-indigo-600 text-white' : 'bg-gray-900 text-gray-400 hover:text-gray-200'">
            🧱 Фронт работ
          </button>
          <button @click="tab = 'pricing'" class="px-5 py-2 font-medium transition"
            :class="tab === 'pricing' ? 'bg-indigo-600 text-white' : 'bg-gray-900 text-gray-400 hover:text-gray-200'">
            💰 Стоимость
          </button>
        </div>

        <!-- Вкладка «Фронт работ» -->
        <section v-if="tab === 'work'">
          <div v-if="!data.tasks.length" class="text-gray-500 py-10 text-center">Задачи не заполнены.</div>
          <div v-for="m in months" :key="m" class="mb-6">
            <template v-if="data.tasks.some((t) => Number(t.month) === m)">
              <h2 class="text-lg font-semibold mb-3">Месяц {{ m }}</h2>
              <div class="overflow-x-auto rounded-xl border border-gray-800">
                <table class="min-w-full text-sm">
                  <thead class="bg-gray-900 text-gray-400 text-left">
                    <tr>
                      <th class="px-3 py-2 font-medium">Модуль</th>
                      <th class="px-3 py-2 font-medium">Задача</th>
                      <th class="px-3 py-2 font-medium">Описание</th>
                      <th class="px-3 py-2 font-medium">Приоритет</th>
                      <th class="px-3 py-2 font-medium">Инструмент</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-gray-800">
                    <tr v-for="(t, i) in data.tasks.filter((x) => Number(x.month) === m)" :key="i">
                      <td class="px-3 py-2 text-gray-300">{{ t.module_name }}</td>
                      <td class="px-3 py-2">{{ t.task_id }} · {{ t.task_title }}</td>
                      <td class="px-3 py-2 text-gray-500 text-xs max-w-md">{{ t.task_description }}</td>
                      <td class="px-3 py-2"><span class="text-xs px-1.5 py-0.5 rounded" :class="PRIORITY_BADGE[t.priority]?.cls">{{ PRIORITY_BADGE[t.priority]?.label }}</span></td>
                      <td class="px-3 py-2 text-gray-400 text-xs">{{ t.tool }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </template>
          </div>
        </section>

        <!-- Вкладка «Стоимость» -->
        <section v-else>
          <div v-if="!data.pricing.length" class="text-gray-500 py-10 text-center">Стоимость не заполнена.</div>
          <template v-else>
            <div class="overflow-x-auto rounded-xl border border-gray-800">
              <table class="min-w-full text-sm">
                <thead class="bg-gray-900 text-gray-400 text-left">
                  <tr>
                    <th class="px-3 py-2 font-medium">Статья</th>
                    <th class="px-3 py-2 font-medium">Месяц</th>
                    <th class="px-3 py-2 font-medium text-right">Основной бюджет</th>
                    <th class="px-3 py-2 font-medium text-right">Доп. бюджет</th>
                    <th class="px-3 py-2 font-medium">Описание доп. бюджета</th>
                    <th class="px-3 py-2 font-medium text-right">Итого</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-800">
                  <tr v-for="(p, i) in data.pricing" :key="i">
                    <td class="px-3 py-2">{{ p.item_name }}</td>
                    <td class="px-3 py-2 text-gray-300">{{ p.month == null ? 'Общее' : `Месяц ${p.month}` }}</td>
                    <td class="px-3 py-2 text-right text-gray-300">{{ fmtMoney(p.base_budget) }}</td>
                    <td class="px-3 py-2 text-right text-gray-300">{{ Number(p.additional_budget) > 0 ? fmtMoney(p.additional_budget) : '—' }}</td>
                    <td class="px-3 py-2 text-gray-500 text-xs">{{ Number(p.additional_budget) > 0 ? (p.additional_note || '—') : '—' }}</td>
                    <td class="px-3 py-2 text-right font-medium">{{ fmtMoney(rowTotal(p)) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div class="mt-4 bg-gray-900 border border-gray-800 rounded-xl p-4 max-w-lg space-y-1.5 text-sm">
              <template v-for="m in months" :key="m">
                <div v-if="pricingByMonth[m]" class="flex justify-between text-gray-300">
                  <span>Месяц {{ m }}: основной {{ fmtMoney(pricingByMonth[m].base) }} / доп. {{ fmtMoney(pricingByMonth[m].add) }}</span>
                  <span class="font-medium text-gray-100">{{ fmtMoney(pricingByMonth[m].base + pricingByMonth[m].add) }} ₽</span>
                </div>
              </template>
              <div v-if="pricingByMonth.total" class="flex justify-between text-gray-300">
                <span>Общее: основной {{ fmtMoney(pricingByMonth.total.base) }} / доп. {{ fmtMoney(pricingByMonth.total.add) }}</span>
                <span class="font-medium text-gray-100">{{ fmtMoney(pricingByMonth.total.base + pricingByMonth.total.add) }} ₽</span>
              </div>
              <div class="flex justify-between pt-2 border-t border-gray-800 font-semibold">
                <span>Итого за весь период</span>
                <span class="text-indigo-400">{{ fmtMoney(data.totals.grand) }} ₽</span>
              </div>
            </div>
          </template>
        </section>

        <footer class="mt-10 text-xs text-gray-600">
          Документ сформирован {{ fmtDate(data.proposal.created_at) }} · read-only просмотр по публичной ссылке
        </footer>
      </template>
    </div>
  </div>
</template>
