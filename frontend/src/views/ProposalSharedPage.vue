<script setup>
/**
 * ProposalSharedPage — публичная read-only страница КП по share-ссылке.
 *
 * Клиент видит фронт работ в трёх форматах (переключатель):
 *   • Медиа-план — работы слева, месяцы сверху, закрашенные ячейки
 *     (главный формат: сразу видно, что и когда делаем и что повторяется);
 *   • Канбан — карточки по месяцам;
 *   • Таблица — детальный перечень по месяцам.
 * Отдельная вкладка «Стоимость» + кнопка «Скачать PDF».
 *
 * Без авторизации; данные отдаёт GET /api/public/proposal/:token,
 * PDF — GET /api/public/proposal/:token/export/pdf.
 * Медиа-план (свёртку «работа → месяцы» и периодичность) считает бэкенд —
 * тот же билдер используется в PDF/Excel, поэтому расхождений нет.
 */
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import axios from 'axios';

const route = useRoute();

const loading = ref(true);
const error = ref(null);
const data = ref(null);
const tab = ref('work');          // work | pricing
const workView = ref('mediaplan'); // mediaplan | kanban | table
const downloading = ref(false);

const WORK_VIEWS = [
  ['mediaplan', '🗓 Медиа-план'],
  ['kanban', '🧩 Канбан'],
  ['table', '📋 Таблица'],
];
const WORK_VIEW_KEYS = WORK_VIEWS.map((v) => v[0]);

// Склонение: 1 работа / 2 работы / 5 работ.
function plural(n, forms) {
  const abs = Math.abs(Number(n) || 0) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}
function worksWord(n) { return plural(n, ['работа', 'работы', 'работ']); }

const PRIORITY_BADGE = {
  high: { label: '🔴 Высокий', cls: 'bg-red-900/50 text-red-300' },
  medium: { label: '🟡 Средний', cls: 'bg-yellow-900/50 text-yellow-300' },
  low: { label: '🟢 Низкий', cls: 'bg-emerald-900/50 text-emerald-300' },
};

const plan = computed(() => data.value?.media_plan || null);

// Месяцы берём из медиа-плана (он уже учитывает задачи за пределами горизонта),
// с запасным вариантом по горизонту — на случай старого ответа API.
const months = computed(() => {
  if (plan.value?.months?.length) return plan.value.months;
  const horizon = Number(data.value?.proposal?.horizon) || 3;
  const maxMonth = (data.value?.tasks || []).reduce((mx, t) => Math.max(mx, Number(t.month) || 1), 0);
  return Array.from({ length: Math.max(horizon, maxMonth, 1) }, (_, i) => i + 1);
});

const planModules = computed(() => plan.value?.modules || []);
const tasksTotal = computed(() => plan.value?.total_tasks ?? (data.value?.tasks || []).length);
const countsByMonth = computed(() => {
  if (plan.value?.counts_by_month) return plan.value.counts_by_month;
  const counts = {};
  for (const t of data.value?.tasks || []) {
    const m = Number(t.month) || 1;
    counts[m] = (counts[m] || 0) + 1;
  }
  return counts;
});

function tasksOfMonth(m) {
  return (data.value?.tasks || []).filter((t) => Number(t.month) === m);
}

function fmtMoney(v) { return Number(v || 0).toLocaleString('ru-RU'); }
function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('ru-RU');
}
function rowTotal(p) {
  return (Number(p.base_budget) || 0) + (Number(p.additional_budget) || 0);
}

// Подпись месяца датой начала: «Месяц 2 · сентябрь 2026».
function monthLabel(m) {
  const start = data.value?.proposal?.start_date;
  if (!start) return `Месяц ${m}`;
  const d = new Date(start);
  if (Number.isNaN(d.getTime())) return `Месяц ${m}`;
  d.setDate(1);
  d.setMonth(d.getMonth() + (Number(m) - 1));
  const label = d.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }).replace(/\s*г\.$/, '');
  return `Месяц ${m} · ${label}`;
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

async function downloadPdf() {
  downloading.value = true;
  try {
    const { data: blob } = await axios.get(`/api/public/proposal/${route.params.token}/export/pdf`, {
      responseType: 'blob',
      timeout: 60000,
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(data.value?.proposal?.title || 'Коммерческое предложение').replace(/[\\/:*?"<>|]+/g, '_')}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    error.value = 'Не удалось скачать PDF. Попробуйте позже.';
  } finally {
    downloading.value = false;
  }
}

onMounted(async () => {
  // ?view=kanban|table|mediaplan — можно прислать клиенту ссылку сразу
  // на нужный формат показа.
  const q = String(route.query.view || '');
  if (WORK_VIEW_KEYS.includes(q)) workView.value = q;
  try {
    // Публичный эндпоинт — сырой axios, чтобы не подставлять Bearer-токен.
    const { data: resp } = await axios.get(`/api/public/proposal/${route.params.token}`, { timeout: 30000 });
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
      <div v-else-if="error && !data" class="text-center py-20 text-red-400">{{ error }}</div>

      <template v-else>
        <!-- Шапка -->
        <header class="mb-6">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 class="text-2xl font-semibold">{{ data.proposal.title }}</h1>
              <div class="flex flex-wrap gap-x-6 gap-y-1 mt-2 text-sm text-gray-400">
                <span v-if="data.proposal.client">Клиент: <span class="text-gray-200">{{ data.proposal.client }}</span></span>
                <span v-if="data.proposal.manager">Менеджер: <span class="text-gray-200">{{ data.proposal.manager }}</span></span>
                <span>Горизонт: <span class="text-gray-200">{{ data.proposal.horizon }} мес.</span></span>
                <span>Дата начала: <span class="text-gray-200">{{ fmtDate(data.proposal.start_date) }}</span></span>
              </div>
            </div>
            <button @click="downloadPdf" :disabled="downloading"
              class="px-4 py-2 text-sm rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50 transition">
              {{ downloading ? 'Готовлю PDF…' : '📄 Скачать PDF' }}
            </button>
          </div>
        </header>

        <div v-if="error" class="mb-4 p-2.5 rounded-lg bg-red-900/40 border border-red-800 text-red-300 text-sm">{{ error }}</div>

        <!-- Сводка -->
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
          <div class="bg-gray-900 border border-gray-800 rounded-xl p-3">
            <div class="text-[11px] text-gray-500 uppercase">Работ в плане</div>
            <div class="text-xl font-semibold mt-1">{{ tasksTotal }}</div>
          </div>
          <div class="bg-gray-900 border border-gray-800 rounded-xl p-3">
            <div class="text-[11px] text-gray-500 uppercase">Направлений</div>
            <div class="text-xl font-semibold mt-1">{{ planModules.length }}</div>
          </div>
          <div class="bg-gray-900 border border-gray-800 rounded-xl p-3">
            <div class="text-[11px] text-gray-500 uppercase">Период</div>
            <div class="text-xl font-semibold mt-1">{{ months.length }} мес.</div>
          </div>
          <div class="bg-gray-900 border border-gray-800 rounded-xl p-3">
            <div class="text-[11px] text-gray-500 uppercase">Бюджет за период</div>
            <div class="text-xl font-semibold mt-1">{{ fmtMoney(data.totals.grand) }} ₽</div>
          </div>
        </div>

        <!-- Вкладки: Фронт работ / Стоимость -->
        <div class="flex flex-wrap items-center justify-between gap-3 mb-5">
          <div class="flex rounded-lg overflow-hidden border border-gray-700 text-sm w-fit">
            <button @click="tab = 'work'" class="px-5 py-2 font-medium transition"
              :class="tab === 'work' ? 'bg-indigo-600 text-white' : 'bg-gray-900 text-gray-400 hover:text-gray-200'">
              🧱 Фронт работ
            </button>
            <button @click="tab = 'pricing'" class="px-5 py-2 font-medium transition"
              :class="tab === 'pricing' ? 'bg-indigo-600 text-white' : 'bg-gray-900 text-gray-400 hover:text-gray-200'">
              💰 Стоимость
            </button>
          </div>
          <!-- Формат показа работ -->
          <div v-if="tab === 'work' && data.tasks.length" class="flex rounded-lg overflow-hidden border border-gray-700 text-sm w-fit">
            <button v-for="v in WORK_VIEWS" :key="v[0]" @click="workView = v[0]"
              class="px-4 py-1.5 font-medium transition"
              :class="workView === v[0] ? 'bg-indigo-600 text-white' : 'bg-gray-900 text-gray-400 hover:text-gray-200'">
              {{ v[1] }}
            </button>
          </div>
        </div>

        <!-- Вкладка «Фронт работ» -->
        <section v-if="tab === 'work'">
          <div v-if="!data.tasks.length" class="text-gray-500 py-10 text-center">Задачи не заполнены.</div>

          <!-- Медиа-план: работы слева, месяцы сверху -->
          <template v-else-if="workView === 'mediaplan'">
            <div class="overflow-x-auto rounded-xl border border-gray-800">
              <table class="min-w-full text-sm">
                <thead class="bg-gray-900 text-gray-400 text-left">
                  <tr>
                    <th class="px-3 py-2 font-medium sticky left-0 bg-gray-900 min-w-[300px]">Работа</th>
                    <th class="px-3 py-2 font-medium min-w-[130px]">Периодичность</th>
                    <th v-for="m in months" :key="m" class="px-2 py-2 font-medium text-center whitespace-nowrap">М{{ m }}</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-800 bg-gray-950">
                  <template v-for="mod in planModules" :key="mod.module_id ?? mod.module_name">
                    <tr class="bg-gray-900/60">
                      <td :colspan="months.length + 2" class="px-3 py-1.5 text-xs font-semibold text-indigo-300 sticky left-0 bg-gray-900/60">
                        {{ mod.module_name }} · {{ mod.rows.length }} {{ worksWord(mod.rows.length) }}
                      </td>
                    </tr>
                    <tr v-for="(row, i) in mod.rows" :key="`${mod.module_id}-${i}`">
                      <td class="px-3 py-2 sticky left-0 bg-gray-950">
                        <span class="text-gray-100">{{ row.task_title }}</span>
                        <span class="ml-1 text-xs px-1.5 py-0.5 rounded" :class="PRIORITY_BADGE[row.priority]?.cls">{{ PRIORITY_BADGE[row.priority]?.label }}</span>
                        <span v-if="row.task_description" class="block text-xs text-gray-500 mt-0.5 max-w-md">{{ row.task_description }}</span>
                      </td>
                      <td class="px-3 py-2 text-xs text-gray-400 whitespace-nowrap">{{ row.recurrence_label }}</td>
                      <td v-for="m in months" :key="m" class="px-1.5 py-1.5 text-center align-middle">
                        <div class="h-7 rounded-md mx-auto"
                          :class="row.months.includes(m) ? 'bg-indigo-500/80 shadow-[0_0_8px_rgba(99,102,241,0.35)]' : 'bg-gray-900 border border-gray-800/60'"
                          :title="row.months.includes(m) ? `${monthLabel(m)}: работа выполняется` : ''"></div>
                      </td>
                    </tr>
                  </template>
                </tbody>
                <tfoot>
                  <tr class="bg-gray-900 text-gray-400">
                    <td class="px-3 py-2 text-xs font-medium sticky left-0 bg-gray-900">Работ в месяце</td>
                    <td class="px-3 py-2"></td>
                    <td v-for="m in months" :key="m" class="px-2 py-2 text-center text-xs text-gray-200">{{ countsByMonth[m] || 0 }}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p class="mt-2 text-xs text-gray-500">
              <span class="inline-block w-3 h-3 rounded bg-indigo-500/80 align-middle mr-1"></span>
              месяц, в котором выполняется работа
            </p>
          </template>

          <!-- Канбан по месяцам -->
          <div v-else-if="workView === 'kanban'" class="overflow-x-auto pb-2">
            <div class="grid gap-3" :style="{ gridTemplateColumns: `repeat(${months.length}, minmax(240px, 1fr))` }">
              <div v-for="m in months" :key="m" class="bg-gray-900 border border-gray-800 rounded-xl p-3 min-h-[140px]">
                <h3 class="text-xs font-semibold text-gray-300 mb-2">{{ monthLabel(m) }} · {{ countsByMonth[m] || 0 }}</h3>
                <div v-for="(t, i) in tasksOfMonth(m)" :key="i"
                  class="bg-gray-950 border border-gray-800 rounded-lg p-2 mb-2 text-xs">
                  <span class="text-gray-500 block">{{ t.module_name }}</span>
                  <span class="text-gray-100">{{ t.task_title }}</span>
                  <span v-if="t.task_description" class="block text-gray-500 mt-1">{{ t.task_description }}</span>
                  <span class="inline-block mt-1 px-1.5 py-0.5 rounded" :class="PRIORITY_BADGE[t.priority]?.cls">{{ PRIORITY_BADGE[t.priority]?.label }}</span>
                </div>
                <p v-if="!tasksOfMonth(m).length" class="text-xs text-gray-600">Работ нет</p>
              </div>
            </div>
          </div>

          <!-- Таблица по месяцам -->
          <div v-else>
            <div v-for="m in months" :key="m" class="mb-6">
              <template v-if="tasksOfMonth(m).length">
                <h2 class="text-lg font-semibold mb-3">{{ monthLabel(m) }}</h2>
                <div class="overflow-x-auto rounded-xl border border-gray-800">
                  <table class="min-w-full text-sm">
                    <thead class="bg-gray-900 text-gray-400 text-left">
                      <tr>
                        <th class="px-3 py-2 font-medium">Модуль</th>
                        <th class="px-3 py-2 font-medium">Задача</th>
                        <th class="px-3 py-2 font-medium">Описание</th>
                        <th class="px-3 py-2 font-medium">Приоритет</th>
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-gray-800">
                      <tr v-for="(t, i) in tasksOfMonth(m)" :key="i">
                        <td class="px-3 py-2 text-gray-300">{{ t.module_name }}</td>
                        <td class="px-3 py-2">{{ t.task_title }}</td>
                        <td class="px-3 py-2 text-gray-500 text-xs max-w-md">{{ t.task_description }}</td>
                        <td class="px-3 py-2"><span class="text-xs px-1.5 py-0.5 rounded" :class="PRIORITY_BADGE[t.priority]?.cls">{{ PRIORITY_BADGE[t.priority]?.label }}</span></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </template>
            </div>
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
