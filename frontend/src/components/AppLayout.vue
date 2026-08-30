<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { useViewModeStore, VIEW_MODES } from '../stores/viewMode.js';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const viewMode = useViewModeStore();

const sidebarOpen = ref(false);
const sidebarCollapsed = ref(false);
const sidebarRef = ref(null);

const NAV_GROUPS = [
  {
    label: 'Рабочая область',
    items: [
      { key: 'dashboard', label: 'Центр задач', shortLabel: 'Задачи', icon: '⌁', path: '/dashboard', hint: 'Все задачи, статусы и готовые результаты' },
      { key: 'projects', label: 'Проекты', shortLabel: 'Проекты', icon: '▣', path: '/projects', hint: 'Контекст, позиции и аналитика проектов' },
      { key: 'reports', label: 'Отчёты', shortLabel: 'Отчёты', icon: '▤', path: '/reports', hint: 'Онлайн-отчёты и публикация результатов' },
    ],
  },
  {
    label: 'Создание контента',
    items: [
      { key: 'seo-text', label: 'SEO-текст', shortLabel: 'SEO', icon: '✦', path: '/tasks/new', hint: 'Текст по техническому заданию' },
      { key: 'info-article', label: 'Статья для блога', shortLabel: 'Блог', icon: '▥', path: '/info-article', hint: 'Экспертный материал для блога' },
      { key: 'link-article', label: 'Ссылочная статья', shortLabel: 'Ссылки', icon: '↗', path: '/link-article', hint: 'Материал с анкорами и ссылками' },
      { key: 'meta-tags', label: 'Мета-теги', shortLabel: 'Мета', icon: '#', path: '/meta-tags', hint: 'Title и Description для категорий' },
      { key: 'article-topics', label: 'Темы статей', shortLabel: 'Темы', icon: '◈', path: '/article-topics', hint: 'Спрос, интенты и контентные идеи' },
      { key: 'copilot', label: 'AI-редактор', shortLabel: 'Редактор', icon: '◎', path: '/copilot', hint: 'Редактирование готового материала' },
    ],
  },
  {
    label: 'Исследование',
    items: [
      { key: 'relevance', label: 'Релевантность', shortLabel: 'Релевантность', icon: '⌕', path: '/relevance', hint: 'Выдача, конкуренты и семантика' },
      { key: 'forecaster', label: 'Прогнозатор', shortLabel: 'Прогноз', icon: '↗', path: '/forecaster', hint: 'Спрос, темы и прогноз развития' },
      { key: 'parsers', label: 'Парсеры', shortLabel: 'Парсеры', icon: '⌘', path: '/parsers', hint: 'Сбор и анализ данных сайтов' },
      { key: 'audits', label: 'Аудиты', shortLabel: 'Аудиты', icon: '◌', path: '/audits', hint: 'Технические и SEO-проверки' },
      { key: 'category-lead', label: 'Lead-text', shortLabel: 'Lead-text', icon: '◇', path: '/category-lead', hint: 'Тексты для категорий и лидов' },
    ],
  },
  {
    label: 'Коммуникации и данные',
    items: [
      { key: 'outreach', label: 'Рассылка', shortLabel: 'Рассылка', icon: '✉', path: '/outreach', hint: 'Email-кампании и лиды' },
      { key: 'acf-json', label: 'JSON', shortLabel: 'JSON', icon: '{}', path: '/acf-json', hint: 'Структурированные данные' },
    ],
  },
];

const isInternal = computed(() => ['admin', 'employee'].includes(String(auth.user?.role || '').toLowerCase()));
const visibleGroups = computed(() => NAV_GROUPS.map((group) => ({
  ...group,
  items: group.items.filter((item) => item.key !== 'copilot' || isInternal.value),
})).filter((group) => group.items.length));

const activeKey = computed(() => {
  const p = String(route.path || '');
  if (p === '/tasks/new' || /\/tasks\/[^/]+\/edit$/.test(p)) return 'seo-text';
  if (p === '/dashboard' || /\/tasks\/[^/]+\/(monitor|result|copilot)$/.test(p)) return 'dashboard';
  if (p.startsWith('/meta-tags')) return 'meta-tags';
  if (p.startsWith('/link-article')) return 'link-article';
  if (p.startsWith('/info-article')) return 'info-article';
  if (p.startsWith('/article-topics')) return 'article-topics';
  if (p.startsWith('/forecaster') || p.startsWith('/proposals')) return 'forecaster';
  if (p.startsWith('/category-lead')) return 'category-lead';
  if (p.startsWith('/parsers')) return 'parsers';
  if (p.startsWith('/serp-b2b') || p.startsWith('/outreach')) return 'outreach';
  if (p.startsWith('/site-crawler') || p.startsWith('/audits')) return 'audits';
  if (p.startsWith('/position-tracker')) return 'projects';
  if (p.startsWith('/projects')) return 'projects';
  if (p.startsWith('/reports')) return 'reports';
  if (p.startsWith('/acf-json')) return 'acf-json';
  if (p.startsWith('/relevance')) return 'relevance';
  if (p.startsWith('/copilot')) return 'copilot';
  return 'dashboard';
});

const activeItem = computed(() => visibleGroups.value.flatMap((group) => group.items).find((item) => item.key === activeKey.value) || visibleGroups.value[0]?.items[0]);
const roleLabel = computed(() => ({ admin: 'Администратор', employee: 'Сотрудник', client: 'Клиент' }[String(auth.user?.role || '').toLowerCase()] || 'Пользователь'));
const planLabel = computed(() => auth.user?.plan_name || auth.user?.plan || 'Бесплатный доступ');
const showViewModeToggle = computed(() => String(route.path || '').startsWith('/projects'));

function setMode(mode) {
  viewMode.setMode(mode);
}

function go(item) {
  sidebarOpen.value = false;
  router.push(item.path);
}

function toggleSidebar() {
  sidebarOpen.value = !sidebarOpen.value;
}

function handleClickOutside(event) {
  if (sidebarOpen.value && sidebarRef.value && !sidebarRef.value.contains(event.target)) sidebarOpen.value = false;
}

function handleEsc(event) {
  if (event.key === 'Escape') sidebarOpen.value = false;
}

function handleLogout() {
  auth.logout();
  router.push('/login');
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside);
  document.addEventListener('keydown', handleEsc);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', handleClickOutside);
  document.removeEventListener('keydown', handleEsc);
});
</script>

<template>
  <div class="app-shell min-h-screen bg-gray-950 text-gray-100">
    <div
      v-if="sidebarOpen"
      class="app-sidebar-backdrop fixed inset-0 bg-black/60 z-[var(--app-overlay-z)] lg:hidden"
      aria-hidden="true"
      @click="sidebarOpen = false"
    />

    <aside
      ref="sidebarRef"
      :class="[
        'app-sidebar fixed inset-y-0 left-0 z-[calc(var(--app-overlay-z)+1)] flex flex-col',
        'bg-gray-900 border-r border-gray-800 shadow-2xl shadow-black/30 transition-transform duration-200',
        'lg:sticky lg:top-0 lg:z-40 lg:h-screen lg:translate-x-0 lg:shadow-none lg:transition-[width]',
        sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        sidebarCollapsed ? 'lg:w-[76px]' : 'lg:w-[264px]',
        'w-[min(86vw,300px)]',
      ]"
    >
      <div class="app-sidebar-brand flex items-center gap-3 px-4 py-4 border-b border-gray-800/80">
        <svg viewBox="0 0 32 32" class="w-8 h-8 flex-shrink-0" fill="none" aria-hidden="true">
          <rect width="32" height="32" rx="9" fill="#6366f1"/>
          <path d="M8 16a8 8 0 1 1 10.6 7.6" stroke="white" stroke-width="2" stroke-linecap="round"/>
          <circle cx="16" cy="16" r="3" fill="white"/>
          <path d="M22 22l4 4" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
        </svg>
        <div v-if="!sidebarCollapsed" class="min-w-0">
          <p class="text-sm font-semibold text-white truncate">SEO Genius</p>
          <p class="text-[11px] text-gray-500 truncate">рабочий кабинет</p>
        </div>
        <button
          class="ml-auto hidden lg:inline-flex w-7 h-7 items-center justify-center rounded-lg text-gray-500 hover:text-white hover:bg-gray-800 transition-colors"
          :aria-label="sidebarCollapsed ? 'Развернуть меню' : 'Свернуть меню'"
          :title="sidebarCollapsed ? 'Развернуть меню' : 'Свернуть меню'"
          @click="sidebarCollapsed = !sidebarCollapsed"
        >
          {{ sidebarCollapsed ? '»' : '«' }}
        </button>
      </div>

      <nav class="flex-1 overflow-y-auto px-3 py-4 space-y-5" aria-label="Навигация личного кабинета">
        <section v-for="group in visibleGroups" :key="group.label">
          <p v-if="!sidebarCollapsed" class="px-3 mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-600">
            {{ group.label }}
          </p>
          <div class="space-y-1">
            <button
              v-for="item in group.items"
              :key="item.key"
              type="button"
              :title="sidebarCollapsed ? `${item.label}: ${item.hint}` : item.hint"
              :class="[
                'app-nav-item w-full flex items-center gap-3 rounded-xl text-left transition-all duration-150',
                sidebarCollapsed ? 'justify-center px-2 py-3' : 'px-3 py-2.5',
                activeKey === item.key
                  ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-950/30'
                  : 'text-gray-400 hover:bg-gray-800/80 hover:text-gray-100',
              ]"
              :aria-current="activeKey === item.key ? 'page' : undefined"
              @click="go(item)"
            >
              <span class="app-nav-icon inline-flex h-5 w-5 items-center justify-center text-sm font-semibold" aria-hidden="true">{{ item.icon }}</span>
              <span v-if="!sidebarCollapsed" class="min-w-0 flex-1 truncate text-[13px] font-medium">{{ item.label }}</span>
              <span v-if="!sidebarCollapsed && activeKey === item.key" class="w-1.5 h-1.5 rounded-full bg-white/80" aria-hidden="true" />
            </button>
          </div>
        </section>
      </nav>

      <div class="border-t border-gray-800/80 p-3">
        <div v-if="!sidebarCollapsed" class="rounded-xl bg-gray-950/60 border border-gray-800 px-3 py-2.5 mb-2">
          <p class="text-[10px] uppercase tracking-wider text-gray-600">Текущий доступ</p>
          <p class="mt-1 text-xs font-semibold text-gray-200 truncate">{{ planLabel }}</p>
          <p class="mt-0.5 text-[11px] text-gray-500 truncate">{{ roleLabel }}</p>
        </div>
        <button
          type="button"
          class="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
          :class="sidebarCollapsed ? 'justify-center' : ''"
          title="Выйти из кабинета"
          @click="handleLogout"
        >
          <span class="text-base" aria-hidden="true">↪</span>
          <span v-if="!sidebarCollapsed" class="text-[13px] font-medium">Выйти</span>
        </button>
      </div>
    </aside>

    <div class="app-shell-main min-w-0 flex-1 flex flex-col min-h-screen">
      <header class="app-header border-b border-gray-800/90 bg-gray-900/90 backdrop-blur-xl px-4 sm:px-6 py-3 flex items-center justify-between gap-4 flex-shrink-0">
        <div class="flex items-center gap-3 min-w-0">
          <button
            type="button"
            class="lg:hidden inline-flex h-9 w-9 items-center justify-center rounded-xl border border-gray-700 bg-gray-800 text-gray-200 hover:bg-gray-700 transition-colors"
            aria-label="Открыть навигацию"
            :aria-expanded="sidebarOpen"
            @click="toggleSidebar"
          >
            <span class="text-lg" aria-hidden="true">☰</span>
          </button>
          <div class="min-w-0">
            <p class="text-[10px] uppercase tracking-[0.16em] text-gray-600 hidden sm:block">SEO Genius · рабочий кабинет</p>
            <div class="flex items-center gap-2 min-w-0">
              <span class="text-sm font-semibold text-white truncate">{{ activeItem?.label || 'Центр задач' }}</span>
              <span class="text-gray-700 hidden sm:inline">/</span>
              <span class="text-xs text-gray-500 truncate hidden sm:inline">{{ activeItem?.hint }}</span>
            </div>
          </div>
        </div>

        <div class="flex items-center gap-2 sm:gap-3 flex-shrink-0">
          <div
            v-if="showViewModeToggle"
            role="group"
            aria-label="Режим отображения проекта"
            class="hidden sm:inline-flex items-center rounded-xl border border-gray-700 bg-gray-950 p-0.5 text-xs"
          >
            <button
              type="button"
              class="px-2.5 py-1.5 rounded-lg font-medium transition-colors"
              :class="viewMode.isAnalyst ? 'bg-indigo-600 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'"
              :aria-pressed="viewMode.isAnalyst"
              @click="setMode(VIEW_MODES.ANALYST)"
            >Аналитик</button>
            <button
              type="button"
              class="px-2.5 py-1.5 rounded-lg font-medium transition-colors"
              :class="viewMode.isClient ? 'bg-indigo-600 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'"
              :aria-pressed="viewMode.isClient"
              @click="setMode(VIEW_MODES.CLIENT)"
            >Клиент</button>
          </div>
          <div class="hidden md:flex items-center gap-2 rounded-xl border border-gray-800 bg-gray-950/40 px-3 py-2 max-w-[220px]">
            <span class="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-indigo-950 text-xs text-indigo-300" aria-hidden="true">{{ (auth.user?.name || auth.user?.email || 'П').slice(0, 1).toUpperCase() }}</span>
            <span class="text-xs text-gray-400 truncate">{{ auth.user?.name || auth.user?.email }}</span>
          </div>
          <button type="button" class="lg:hidden btn-ghost text-xs" @click="handleLogout">Выйти</button>
        </div>
      </header>

      <main class="app-main flex-1 min-w-0">
        <slot />
      </main>
    </div>
  </div>
</template>
