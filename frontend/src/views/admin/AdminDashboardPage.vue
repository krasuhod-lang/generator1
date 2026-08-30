<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAdminStore } from '../../stores/admin.js';
import AdminLayout from '../../components/AdminLayout.vue';

const router = useRouter();
const admin = useAdminStore();
const dashboardError = ref(null);
const refreshing = ref(false);

const quickLinks = [
  { title: 'Пользователи', description: 'Роли, тарифы и индивидуальные лимиты', to: '/admin/users', tone: 'emerald', icon: '◎' },
  { title: 'Все задачи', description: 'Поиск генераций по статусу и пользователю', to: '/admin/tasks', tone: 'blue', icon: '▦' },
  { title: 'API и расходы', description: 'Токены, стоимость, воронки и аномалии', to: '/admin/usage', tone: 'violet', icon: '◈' },
  { title: 'Хранилище', description: 'Диск, PostgreSQL, Redis и очистка', to: '/admin/storage', tone: 'amber', icon: '▤' },
];

const statCards = computed(() => {
  const stats = admin.stats || {};
  return [
    { label: 'Пользователи', value: stats.total_users ?? '—', hint: `+${stats.users_today ?? 0} сегодня`, tone: 'text-emerald-300', icon: '◎' },
    { label: 'Всего задач', value: stats.total_tasks ?? '—', hint: `${stats.tasks_processing ?? 0} в работе`, tone: 'text-blue-300', icon: '▦' },
    { label: 'Завершено', value: stats.tasks_completed ?? '—', hint: `${stats.tasks_failed ?? 0} с ошибкой`, tone: 'text-green-300', icon: '✓' },
    { label: 'Расходы', value: fmtCost(stats.total_cost_usd), hint: 'за весь период', tone: 'text-cyan-300', icon: '$' },
    { label: 'Средний E-E-A-T', value: stats.avg_eeat_score ?? '—', hint: `LSI ${stats.avg_lsi_coverage ?? 0}%`, tone: 'text-amber-300', icon: '✦' },
  ];
});

const attentionItems = computed(() => {
  const stats = admin.stats;
  const items = [];
  if (!stats) {
    items.push({ tone: 'amber', title: 'Статистика недоступна', text: 'Проверьте соединение с административным API и повторите обновление.', to: '/admin/usage' });
    return items;
  }
  if (Number(stats.tasks_failed) > 0) {
    items.push({ tone: 'amber', title: `${stats.tasks_failed} задач с ошибкой`, text: 'Откройте общий список задач и отфильтруйте ошибки.', to: '/admin/tasks?status=failed' });
  }
  if (Number(stats.tasks_processing) > 0) {
    items.push({ tone: 'blue', title: `${stats.tasks_processing} задач в работе`, text: 'Проверьте длительные генерации и их логи.', to: '/admin/tasks?status=processing' });
  }
  if (!items.length) {
    items.push({ tone: 'emerald', title: 'Критичных сигналов нет', text: 'Сервис не сообщает о незавершённых проблемах.', to: '/admin/usage' });
  }
  return items;
});

function fmtCost(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n)) return '—';
  return '$' + n.toFixed(Math.abs(n) < 0.01 ? 6 : 4);
}

async function loadOverview() {
  dashboardError.value = null;
  refreshing.value = true;
  try {
    await admin.fetchStats();
  } catch (e) {
    dashboardError.value = e.response?.data?.error || e.message || 'Не удалось загрузить административную статистику';
  } finally {
    refreshing.value = false;
  }
}

function go(to) {
  router.push(to);
}

onMounted(loadOverview);
</script>

<template>
  <AdminLayout>
    <div class="app-page">
      <div class="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p class="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-emerald-400/80">Control center</p>
          <h2 class="text-2xl font-semibold tracking-tight text-white sm:text-3xl">Обзор сервиса</h2>
          <p class="mt-2 max-w-2xl text-sm leading-6 text-gray-500">Ключевые показатели и быстрый доступ к управлению. Детальные таблицы и мониторинги вынесены в отдельные разделы.</p>
        </div>
        <button type="button" class="btn-ghost border border-gray-800" :disabled="refreshing" @click="loadOverview">
          <span :class="refreshing ? 'animate-spin' : ''">↻</span>
          {{ refreshing ? 'Обновление…' : 'Обновить данные' }}
        </button>
      </div>

      <div v-if="dashboardError" class="mb-6 rounded-xl border border-red-800/80 bg-red-950/40 px-4 py-3 text-sm text-red-300" role="alert">
        {{ dashboardError }}
      </div>

      <div v-if="admin.stats" class="mb-7 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <button
          v-for="card in statCards"
          :key="card.label"
          type="button"
          class="card group text-left transition duration-150 hover:-translate-y-0.5 hover:border-gray-700"
          @click="card.label === 'Пользователи' ? go('/admin/users') : card.label === 'Всего задач' ? go('/admin/tasks') : card.label === 'Расходы' ? go('/admin/usage') : undefined"
        >
          <div class="mb-5 flex items-center justify-between">
            <span class="flex h-9 w-9 items-center justify-center rounded-lg bg-gray-800 text-sm text-gray-400 transition group-hover:bg-gray-700" :class="card.tone">{{ card.icon }}</span>
            <span class="text-[10px] font-semibold uppercase tracking-wider text-gray-600">KPI</span>
          </div>
          <div class="text-2xl font-semibold tabular-nums" :class="card.tone">{{ card.value }}</div>
          <div class="mt-1 text-sm text-gray-300">{{ card.label }}</div>
          <div class="mt-2 text-xs text-gray-600">{{ card.hint }}</div>
        </button>
      </div>

      <div v-else-if="!refreshing" class="mb-7 rounded-xl border border-gray-800 bg-gray-900/50 px-4 py-5 text-sm text-gray-500">Статистика пока недоступна.</div>

      <div class="grid grid-cols-1 gap-5 xl:grid-cols-[1.25fr_0.75fr]">
        <section class="card">
          <div class="mb-5 flex items-start justify-between gap-4">
            <div>
              <p class="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-600">Navigation</p>
              <h3 class="mt-1 text-lg font-semibold text-white">Быстрый доступ</h3>
              <p class="mt-1 text-sm text-gray-500">Основные операции теперь открываются отдельными экранами.</p>
            </div>
            <span class="hidden rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300 sm:inline-flex">7 разделов</span>
          </div>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <button
              v-for="link in quickLinks"
              :key="link.to"
              type="button"
              class="group flex items-start gap-3 rounded-xl border border-gray-800/80 bg-gray-950/40 p-4 text-left transition duration-150 hover:border-gray-700 hover:bg-gray-800/60"
              @click="go(link.to)"
            >
              <span class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-gray-800 text-sm text-gray-400 transition group-hover:bg-emerald-500/15 group-hover:text-emerald-300">{{ link.icon }}</span>
              <span class="min-w-0">
                <span class="block text-sm font-medium text-gray-200">{{ link.title }}</span>
                <span class="mt-1 block text-xs leading-5 text-gray-600 group-hover:text-gray-500">{{ link.description }}</span>
              </span>
              <span class="ml-auto text-gray-700 transition group-hover:translate-x-0.5 group-hover:text-gray-400">→</span>
            </button>
          </div>
        </section>

        <section class="card">
          <div class="mb-5">
            <p class="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-600">Operations</p>
            <h3 class="mt-1 text-lg font-semibold text-white">Состояние внимания</h3>
            <p class="mt-1 text-sm text-gray-500">Сигналы, которые стоит проверить в первую очередь.</p>
          </div>
          <div class="space-y-3">
            <button
              v-for="item in attentionItems"
              :key="item.title"
              type="button"
              class="flex w-full items-start gap-3 rounded-xl border border-gray-800/70 bg-gray-950/40 p-3 text-left transition hover:border-gray-700 hover:bg-gray-800/60"
              @click="go(item.to)"
            >
              <span class="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full" :class="item.tone === 'emerald' ? 'bg-emerald-400' : item.tone === 'amber' ? 'bg-amber-400' : 'bg-blue-400'" />
              <span class="min-w-0 flex-1">
                <span class="block text-sm font-medium text-gray-200">{{ item.title }}</span>
                <span class="mt-1 block text-xs leading-5 text-gray-600">{{ item.text }}</span>
              </span>
              <span class="text-gray-700">→</span>
            </button>
          </div>
        </section>
      </div>

      <section class="mt-5 rounded-xl border border-emerald-500/15 bg-emerald-500/[0.04] p-4 sm:p-5">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p class="text-sm font-medium text-emerald-200">Нужна полная картина?</p>
            <p class="mt-1 text-xs leading-5 text-gray-500">В разделе «API и расходы» собраны расходы моделей, воронки и полный ledger обращений.</p>
          </div>
          <button type="button" class="btn-primary flex-shrink-0 bg-emerald-600 hover:bg-emerald-500" @click="go('/admin/usage')">Открыть мониторинг →</button>
        </div>
      </section>
    </div>
  </AdminLayout>
</template>
