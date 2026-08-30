<script setup>
import { ref, onMounted, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAdminStore } from '../../stores/admin.js';
import AdminLayout from '../../components/AdminLayout.vue';

const route  = useRoute();
const router = useRouter();
const admin  = useAdminStore();

const userId = route.params.id;

const userDetail   = ref(null);
const access        = ref(null);
const plans         = ref([]);
const accessForm    = ref({ role: 'client', plan_key: 'trial', status: 'active', period_start: '', period_end: '', overrides: {} });
const accessSaving  = ref(false);
const accessMessage = ref('');
const tasks        = ref([]);
const tasksTotal   = ref(0);
const currentPage  = ref(1);
const pageLimit    = 20;
const loading      = ref(true);
const error        = ref(null);

onMounted(async () => {
  try {
    const [user, tasksData, accessData, planData] = await Promise.all([
      admin.fetchUserDetail(userId),
      admin.fetchUserAllTasks(userId, { page: 1, limit: pageLimit }),
      admin.fetchUserAccess(userId),
      admin.fetchAccessPlans(),
    ]);
    userDetail.value = user;
    access.value = accessData || user.access || null;
    plans.value = planData || [];
    syncAccessForm();
    tasks.value      = tasksData.tasks;
    tasksTotal.value = tasksData.total;
  } catch (e) {
    error.value = e.response?.data?.error || 'Ошибка загрузки';
  } finally {
    loading.value = false;
  }
});

async function loadTasks() {
  const data = await admin.fetchUserAllTasks(userId, { page: currentPage.value, limit: pageLimit });
  tasks.value      = data.tasks;
  tasksTotal.value = data.total;
}

const totalPages = computed(() => Math.ceil(tasksTotal.value / pageLimit));

const ACCESS_FIELDS = [
  ['article_generations', 'Бесплатные генерации'],
  ['seo_articles', 'SEO-тексты'],
  ['blog_articles', 'Статьи для блога'],
  ['link_articles', 'Ссылочные статьи'],
  ['meta_categories', 'Категории мета-тегов'],
  ['relevance_runs', 'Съёмы релевантности'],
  ['article_topics', 'Задачи тем статей'],
  ['projects_reports', 'Проекты и отчёты'],
  ['max_concurrent', 'Одновременные задачи'],
];

function toLocalDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function syncAccessForm() {
  if (!access.value) return;
  const overrides = {};
  for (const [key] of ACCESS_FIELDS) {
    if (access.value.overrides && Object.prototype.hasOwnProperty.call(access.value.overrides, key)) {
      overrides[key] = String(access.value.overrides[key]);
    }
  }
  accessForm.value = {
    role: access.value.role || 'client',
    plan_key: access.value.plan || 'trial',
    status: access.value.status || 'active',
    period_start: toLocalDateTime(access.value.periodStart),
    period_end: toLocalDateTime(access.value.periodEnd),
    overrides,
  };
}

function displayLimit(value) {
  return value == null ? 'Безлимитно' : String(value);
}

function onRoleChange() {
  if (accessForm.value.role !== 'client') accessForm.value.plan_key = 'internal';
  else if (accessForm.value.plan_key === 'internal') accessForm.value.plan_key = 'trial';
}

async function saveAccess() {
  accessSaving.value = true;
  accessMessage.value = '';
  try {
    const overrides = {};
    for (const [key] of ACCESS_FIELDS) {
      const value = accessForm.value.overrides?.[key];
      if (value !== undefined && value !== null && String(value).trim() !== '') overrides[key] = Number(value);
    }
    const payload = {
      role: accessForm.value.role,
      plan_key: accessForm.value.plan_key,
      status: accessForm.value.status,
      overrides,
      period_start: accessForm.value.period_start ? new Date(accessForm.value.period_start).toISOString() : null,
      period_end: accessForm.value.period_end ? new Date(accessForm.value.period_end).toISOString() : null,
    };
    access.value = await admin.updateUserAccess(userId, payload);
    if (userDetail.value) userDetail.value.access = access.value;
    syncAccessForm();
    accessMessage.value = 'Права доступа сохранены';
  } catch (e) {
    accessMessage.value = e.response?.data?.error || 'Не удалось сохранить права доступа';
  } finally {
    accessSaving.value = false;
  }
}

function goPage(p) {
  if (p < 1 || p > totalPages.value) return;
  currentPage.value = p;
  loadTasks();
}

// ── Статистика статусов (для простой визуализации) ──────────────────
const statusStats = computed(() => {
  if (!userDetail.value) return [];
  const u = userDetail.value;
  return [
    { label: 'Завершено', count: Number(u.tasks_completed) || 0, color: 'bg-green-500' },
    { label: 'Ошибок',    count: Number(u.tasks_failed) || 0,    color: 'bg-red-500' },
    { label: 'В процессе', count: Number(u.tasks_processing) || 0, color: 'bg-yellow-500' },
    { label: 'В очереди',  count: Number(u.tasks_queued) || 0,     color: 'bg-blue-500' },
    { label: 'Черновики',  count: Number(u.tasks_draft) || 0,      color: 'bg-gray-500' },
  ];
});

const barTotal = computed(() => {
  return statusStats.value.reduce((s, v) => s + v.count, 0) || 1;
});

// ── Дни с регистрации ──────────────────────────────────────────────
const daysSinceRegistration = computed(() => {
  if (!userDetail.value?.created_at) return 0;
  const diff = Date.now() - new Date(userDetail.value.created_at).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
});

// ── Форматирование ─────────────────────────────────────────────────
const STATUS_META = {
  draft:      { label: 'Черновик',     cls: 'bg-gray-700 text-gray-300' },
  pending:    { label: 'Ожидает',      cls: 'bg-yellow-900 text-yellow-300' },
  queued:     { label: 'В очереди',    cls: 'bg-yellow-900 text-yellow-300' },
  processing: { label: 'Выполняется',  cls: 'bg-indigo-900 text-indigo-300' },
  running:    { label: 'Выполняется',  cls: 'bg-indigo-900 text-indigo-300' },
  completed:  { label: 'Завершена',    cls: 'bg-green-900 text-green-300' },
  done:       { label: 'Завершена',    cls: 'bg-green-900 text-green-300' },
  failed:     { label: 'Ошибка',       cls: 'bg-red-900 text-red-300' },
  error:      { label: 'Ошибка',       cls: 'bg-red-900 text-red-300' },
  cancelled:  { label: 'Отменена',     cls: 'bg-gray-700 text-gray-400' },
  partial:    { label: 'Частично',      cls: 'bg-amber-900 text-amber-300' },
  timeout:    { label: 'Тайм-аут',      cls: 'bg-red-900 text-red-300' },
};

const MODULE_META = {
  seo:           { label: 'SEO-текст',         cls: 'bg-emerald-900 text-emerald-300' },
  meta_tag:      { label: 'Мета-теги',         cls: 'bg-sky-900 text-sky-300' },
  link_article:  { label: 'Ссылочная статья',  cls: 'bg-violet-900 text-violet-300' },
  article_topic: { label: 'Темы статей',       cls: 'bg-pink-900 text-pink-300' },
  info_article:  { label: 'Инфо-статья',       cls: 'bg-amber-900 text-amber-300' },
  relevance:     { label: 'Релевантность',     cls: 'bg-teal-900 text-teal-300' },
  forecaster:    { label: 'Прогнозатор',       cls: 'bg-orange-900 text-orange-300' },
  serp_b2b:      { label: 'SERP B2B',           cls: 'bg-cyan-900 text-cyan-300' },
  category_lead: { label: 'Category Lead',      cls: 'bg-lime-900 text-lime-300' },
  parser:        { label: 'Парсер контента',    cls: 'bg-fuchsia-900 text-fuchsia-300' },
  site_crawl:   { label: 'Site Crawl',         cls: 'bg-orange-900 text-orange-300' },
};

function statusMeta(status) {
  return STATUS_META[status] || { label: status || '—', cls: 'bg-gray-700 text-gray-400' };
}

function moduleMeta(source) {
  return MODULE_META[source] || { label: source || '—', cls: 'bg-gray-700 text-gray-400' };
}

function openTask(t) {
  // SEO-задачи открываются в старом detail (по id), не-SEO — через source-aware route.
  if (!t.source || t.source === 'seo') {
    router.push(`/admin/tasks/${t.id}`);
  } else {
    router.push(`/admin/tasks/${t.id}?source=${encodeURIComponent(t.source)}`);
  }
}

function fmtDate(dt) {
  if (!dt) return '—';
  return new Date(dt).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtCost(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n)) return '—';
  return '$' + n.toFixed(Math.abs(n) < 0.01 ? 6 : 4);
}
</script>

<template>
  <AdminLayout>
    <div class="max-w-7xl mx-auto px-6 py-6">

      <!-- Назад -->
      <button @click="router.push('/admin')" class="btn-ghost text-xs mb-4">
        ← Назад к списку
      </button>

      <!-- Загрузка / Ошибка -->
      <div v-if="loading" class="flex justify-center py-16">
        <svg class="animate-spin w-8 h-8 text-emerald-500" viewBox="0 0 24 24" fill="none">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
        </svg>
      </div>

      <div v-else-if="error" class="bg-red-950 border border-red-800 text-red-400 text-sm px-4 py-3 rounded-lg">
        {{ error }}
      </div>

      <template v-else-if="userDetail">
        <!-- Карточка пользователя -->
        <div class="card mb-6">
          <div class="flex flex-col sm:flex-row sm:items-center gap-4">
            <div class="w-12 h-12 rounded-full bg-emerald-900 flex items-center justify-center text-emerald-300 text-xl font-bold flex-shrink-0">
              {{ (userDetail.name || userDetail.email)[0].toUpperCase() }}
            </div>
            <div class="flex-1">
              <h2 class="text-xl font-bold text-white">{{ userDetail.name || 'Без имени' }}</h2>
              <p class="text-gray-400 text-sm">{{ userDetail.email }}</p>
            </div>
            <div class="flex gap-6 text-sm flex-wrap">
              <div>
                <span class="text-gray-500">Регистрация:</span>
                <span class="text-gray-300 ml-1">{{ fmtDate(userDetail.created_at) }}</span>
              </div>
              <div>
                <span class="text-gray-500">Дней в системе:</span>
                <span class="text-gray-300 ml-1">{{ daysSinceRegistration }}</span>
              </div>
              <div>
                <span class="text-gray-500">Роль:</span>
                <span class="text-gray-300 ml-1">{{ ({ admin: 'Администратор', employee: 'Сотрудник', client: 'Клиент' }[access?.role || userDetail.account_role || userDetail.role] || 'Клиент') }}</span>
              </div>
              <div v-if="access">
                <span class="text-gray-500">Тариф:</span>
                <span class="text-gray-300 ml-1">{{ access.planName }}</span>
              </div>
              <div>
                <span class="text-gray-500">Пароль:</span>
                <span
                  v-if="userDetail.password_plain"
                  class="text-gray-200 ml-1 font-mono select-all"
                >{{ userDetail.password_plain }}</span>
                <span v-else class="text-gray-600 ml-1">— (не сохранён до миграции 086 — будет записан после следующего логина)</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Коммерческий доступ: ручное назначение администратором -->
        <div v-if="access" class="card mb-6">
          <div class="flex items-center justify-between gap-3 mb-4">
            <div>
              <h3 class="text-sm font-medium text-gray-300 uppercase tracking-wide">Коммерческий доступ</h3>
              <p class="text-xs text-gray-500 mt-1">Платёжный checkout не входит в этот этап: тариф назначается вручную.</p>
            </div>
            <span v-if="accessMessage" class="text-xs" :class="accessMessage.includes('сохран') ? 'text-emerald-400' : 'text-red-400'">{{ accessMessage }}</span>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
            <label class="block text-xs text-gray-400">Роль
              <select v-model="accessForm.role" @change="onRoleChange" class="input mt-1 w-full">
                <option value="admin">Администратор</option>
                <option value="employee">Сотрудник</option>
                <option value="client">Клиент</option>
              </select>
            </label>
            <label class="block text-xs text-gray-400">Тариф
              <select v-model="accessForm.plan_key" class="input mt-1 w-full">
                <option v-if="accessForm.role !== 'client'" value="internal">Внутренний доступ</option>
                <template v-for="plan in plans" :key="plan.key">
                  <option v-if="accessForm.role === 'client'" :value="plan.key">
                    {{ plan.name }}{{ plan.priceRub ? ` — ${plan.priceRub.toLocaleString('ru-RU')} ₽/мес.` : '' }}
                  </option>
                </template>
              </select>
            </label>
            <label class="block text-xs text-gray-400">Статус
              <select v-model="accessForm.status" class="input mt-1 w-full">
                <option value="active">Активен</option>
                <option value="paused">Пауза</option>
                <option value="expired">Истёк</option>
              </select>
            </label>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
            <label class="block text-xs text-gray-400">Начало периода
              <input v-model="accessForm.period_start" type="datetime-local" class="input mt-1 w-full" />
            </label>
            <label class="block text-xs text-gray-400">Конец периода (для paid-тарифа)
              <input v-model="accessForm.period_end" type="datetime-local" class="input mt-1 w-full" />
            </label>
          </div>

          <div class="rounded-lg border border-gray-800 bg-gray-900/40 p-3 mb-4">
            <div class="flex items-center justify-between mb-3">
              <div>
                <h4 class="text-xs font-medium text-gray-300 uppercase tracking-wide">Индивидуальные лимиты</h4>
                <p class="text-[11px] text-gray-500 mt-1">Пустое поле = лимит тарифа; значения применяются только backend.</p>
              </div>
              <span class="text-[11px] text-gray-500">0–50 для concurrency</span>
            </div>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
              <label v-for="field in ACCESS_FIELDS" :key="field[0]" class="block text-[11px] text-gray-500">
                {{ field[1] }}
                <input v-model="accessForm.overrides[field[0]]" type="number" min="0" :max="field[0] === 'max_concurrent' ? 50 : 1000000" class="input mt-1 w-full text-xs" placeholder="По тарифу" />
              </label>
            </div>
          </div>

          <div class="overflow-x-auto mb-4">
            <table class="w-full text-xs">
              <thead><tr class="border-b border-gray-800 text-left"><th class="py-2 text-gray-500">Ресурс</th><th class="py-2 text-gray-500">Использовано</th><th class="py-2 text-gray-500">Лимит</th><th class="py-2 text-gray-500">Остаток</th></tr></thead>
              <tbody>
                <tr v-for="field in ACCESS_FIELDS.filter((x) => x[0] !== 'max_concurrent')" :key="field[0]" class="border-b border-gray-800/50">
                  <td class="py-2 text-gray-300">{{ field[1] }}</td>
                  <td class="py-2 text-gray-400">{{ access.used?.[field[0]] || 0 }}</td>
                  <td class="py-2 text-gray-300">{{ displayLimit(access.limits?.[field[0]]) }}</td>
                  <td class="py-2 text-emerald-300">{{ displayLimit(access.remaining?.[field[0]]) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <button class="btn-primary text-sm" :disabled="accessSaving" @click="saveAccess">
            {{ accessSaving ? 'Сохраняем…' : 'Сохранить права доступа' }}
          </button>
        </div>

        <!-- Статистика задач: бар -->
        <div class="card mb-6">
          <h3 class="text-sm font-medium text-gray-400 uppercase tracking-wide mb-4">Статистика задач</h3>
          <div class="flex items-center gap-6 mb-4">
            <div v-for="s in statusStats" :key="s.label" class="flex items-center gap-2">
              <span class="w-3 h-3 rounded-full" :class="s.color"></span>
              <span class="text-xs text-gray-400">{{ s.label }}: <span class="text-white font-medium">{{ s.count }}</span></span>
            </div>
          </div>
          <!-- Визуальный бар -->
          <div class="flex h-4 rounded-full overflow-hidden bg-gray-800">
            <div
              v-for="s in statusStats"
              :key="s.label"
              :class="s.color"
              :style="{ width: (s.count / barTotal * 100) + '%' }"
              class="transition-all duration-300"
            ></div>
          </div>
          <div class="mt-3 text-sm text-gray-400">
            Общая стоимость генерации: <span class="text-white font-medium">{{ fmtCost(userDetail.total_cost_usd) }}</span>
          </div>
        </div>

        <!-- Таблица задач -->
        <div class="card overflow-x-auto">
          <h3 class="text-sm font-medium text-gray-400 uppercase tracking-wide mb-4">Задачи пользователя ({{ tasksTotal }})</h3>
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-gray-800 text-left">
                <th class="py-3 px-3 text-gray-400 font-medium">Модуль</th>
                <th class="py-3 px-3 text-gray-400 font-medium">Название / тема</th>
                <th class="py-3 px-3 text-gray-400 font-medium">Статус</th>
                <th class="py-3 px-3 text-gray-400 font-medium">Создана</th>
                <th class="py-3 px-3 text-gray-400 font-medium">Завершена</th>
                <th class="py-3 px-3 text-gray-400 font-medium">Стоимость</th>
                <th class="py-3 px-3 text-gray-400 font-medium">Ошибка</th>
                <th class="py-3 px-3 text-gray-400 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="t in tasks"
                :key="`${t.source}:${t.id}`"
                class="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors"
              >
                <td class="py-3 px-3">
                  <span class="badge" :class="moduleMeta(t.source).cls">
                    {{ moduleMeta(t.source).label }}
                  </span>
                </td>
                <td class="py-3 px-3 text-gray-200 max-w-[320px] truncate" :title="t.title">{{ t.title || '—' }}</td>
                <td class="py-3 px-3">
                  <span class="badge" :class="statusMeta(t.status).cls">
                    {{ statusMeta(t.status).label }}
                  </span>
                </td>
                <td class="py-3 px-3 text-gray-400">{{ fmtDate(t.created_at) }}</td>
                <td class="py-3 px-3 text-gray-400">{{ fmtDate(t.completed_at) }}</td>
                <td class="py-3 px-3 text-gray-300">{{ fmtCost(t.cost_usd) }}</td>
                <td class="py-3 px-3 text-red-400 max-w-[200px] truncate" :title="t.error_message">
                  {{ t.error_message || '—' }}
                </td>
                <td class="py-3 px-3">
                  <button
                    class="btn-ghost text-xs"
                    @click="openTask(t)"
                    title="Открыть подробности задачи (результат + логи)"
                  >Открыть</button>
                </td>
              </tr>
              <tr v-if="!tasks.length">
                <td colspan="8" class="py-8 text-center text-gray-500">У пользователя нет задач</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Пагинация -->
        <div v-if="totalPages > 1" class="flex items-center justify-center gap-2 mt-4">
          <button class="btn-ghost text-xs" :disabled="currentPage <= 1" @click="goPage(currentPage - 1)">
            ← Назад
          </button>
          <span class="text-sm text-gray-400">Страница {{ currentPage }} из {{ totalPages }}</span>
          <button class="btn-ghost text-xs" :disabled="currentPage >= totalPages" @click="goPage(currentPage + 1)">
            Вперёд →
          </button>
        </div>
      </template>

    </div>
  </AdminLayout>
</template>
