<script setup>
/**
 * PremiumLayout.vue (PR-3 эпика premium-ui-and-client-mode-implementation).
 *
 * Базовый Sidebar + Topbar layout для премиум-страниц (Executive Summary в
 * PR-4, Works Log в PR-5, PDF-предпросмотр в PR-6). НЕ заменяет существующий
 * `AppLayout.vue`: тот остаётся «дропдаун-меню» для текущих инструментов,
 * а сюда переезжают только новые премиум-экраны. Это позволяет внедрять
 * новый дизайн постранично, без массового регресса.
 *
 * Состав:
 *   • Левый сайдбар: лого, навигация по премиум-разделам (передаётся через
 *     prop `nav` или дефолтный набор из ТЗ §6), коллапс для узких экранов.
 *   • Шапка: заголовок (slot `title`), индикатор свежести данных
 *     (slot `freshness` — обычно набор FreshnessBadge), тумблер
 *     Client/Analyst Mode (из PR-2, useViewModeStore), профиль пользователя.
 *   • Контент: `<slot />`.
 *
 * Внешний вид построен на surface-* и status-* токенах Tailwind, добавленных
 * в `tailwind.config.js` в PR-3 (slate-900/800 фон, brand-indigo акцент,
 * tabular-nums для цифр).
 */
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { useViewModeStore, VIEW_MODES } from '../stores/viewMode.js';

const props = defineProps({
  /**
   * Список ссылок сайдбара. Каждый элемент: { key, label, icon, path }.
   * По умолчанию — премиум-разделы из ТЗ §6.
   */
  nav: {
    type: Array,
    default: () => [
      { key: 'dashboard', label: 'Обзор',      icon: '📊', path: '/projects' },
      { key: 'reports',   label: 'Отчёты',     icon: '📑', path: '/reports'  },
      { key: 'positions', label: 'Позиции',    icon: '📍', path: '/position-tracker' },
      { key: 'aegis',     label: 'Aegis',      icon: '🧠', path: '/aegis'    },
    ],
  },
});

defineEmits(['toggle-mode']);

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const viewMode = useViewModeStore();

const collapsed = ref(false);

const activeKey = computed(() => {
  const p = route.path;
  const hit = props.nav.find((n) => p === n.path || p.startsWith(`${n.path}/`));
  return hit ? hit.key : null;
});

function go(item) {
  router.push(item.path);
}

function setMode(mode) {
  viewMode.setMode(mode);
}

// Тумблер «Аналитик/Клиент» скрываем на маршрутах /reports/* — там режим
// клиента задаётся в модалке публикации (shared_reports.view_mode), а превью
// открывается через отдельную кнопку, а не глобальным переключателем.
const showViewModeToggle = computed(() => !String(route.path || '').startsWith('/reports'));

function handleLogout() {
  auth.logout();
  router.push('/login');
}
</script>

<template>
  <div class="min-h-screen flex bg-surface-base text-gray-100 font-sans">
    <!-- Sidebar -->
    <aside
      :class="[
        'flex-shrink-0 border-r border-surface-muted bg-surface-raised',
        'flex flex-col transition-[width] duration-200 ease-out',
        collapsed ? 'w-16' : 'w-60',
      ]"
    >
      <div class="px-4 py-4 flex items-center gap-2.5">
        <svg viewBox="0 0 32 32" class="w-7 h-7 flex-shrink-0" fill="none" aria-hidden="true">
          <rect width="32" height="32" rx="8" fill="#6366f1" />
          <path d="M8 16a8 8 0 1 1 10.6 7.6" stroke="white" stroke-width="2" stroke-linecap="round" />
          <circle cx="16" cy="16" r="3" fill="white" />
          <path d="M22 22l4 4" stroke="white" stroke-width="2.5" stroke-linecap="round" />
        </svg>
        <span v-if="!collapsed" class="font-semibold text-white truncate">SEO Genius</span>
      </div>

      <nav class="flex-1 px-2 py-2 space-y-0.5" aria-label="Premium navigation">
        <button
          v-for="item in nav"
          :key="item.key"
          type="button"
          @click="go(item)"
          :class="[
            'w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-left transition-colors',
            activeKey === item.key
              ? 'bg-brand-indigo text-white shadow-sm shadow-brand-indigo/30'
              : 'text-gray-300 hover:bg-surface-muted/40 hover:text-white',
          ]"
          :aria-current="activeKey === item.key ? 'page' : undefined"
        >
          <span class="text-base w-5 text-center" aria-hidden="true">{{ item.icon }}</span>
          <span v-if="!collapsed" class="truncate">{{ item.label }}</span>
        </button>
      </nav>

      <button
        type="button"
        class="m-2 px-2 py-1.5 rounded-md text-xs text-gray-400 hover:text-gray-100 hover:bg-surface-muted/40 transition-colors flex items-center justify-center gap-2"
        @click="collapsed = !collapsed"
        :aria-label="collapsed ? 'Развернуть сайдбар' : 'Свернуть сайдбар'"
      >
        <span aria-hidden="true">{{ collapsed ? '»' : '«' }}</span>
        <span v-if="!collapsed">Свернуть</span>
      </button>
    </aside>

    <!-- Main column -->
    <div class="flex-1 flex flex-col min-w-0">
      <!-- Topbar -->
      <header
        class="border-b border-surface-muted bg-surface-raised/80 backdrop-blur px-6 py-3
               flex items-center justify-between gap-4 flex-shrink-0"
      >
        <div class="min-w-0 flex items-center gap-3">
          <slot name="title">
            <span class="text-sm font-semibold text-gray-200 truncate">Премиум-дашборд</span>
          </slot>
        </div>

        <div class="flex items-center gap-3 flex-shrink-0">
          <!-- Свежесть данных (FreshnessBadge[]) -->
          <div class="hidden md:flex items-center gap-2">
            <slot name="freshness" />
          </div>

          <!-- Client / Analyst toggle (см. PR-2, stores/viewMode.js).
               Скрыт на /reports/* — см. showViewModeToggle. -->
          <div
            v-if="showViewModeToggle"
            role="group"
            aria-label="Режим отображения"
            class="inline-flex items-center rounded-lg border border-surface-muted bg-surface-base p-0.5 text-xs"
          >
            <button
              type="button"
              :class="[
                'px-2.5 py-1 rounded-md font-medium transition-colors',
                viewMode.isAnalyst
                  ? 'bg-brand-indigo text-white shadow-sm'
                  : 'text-gray-400 hover:text-gray-200',
              ]"
              :aria-pressed="viewMode.isAnalyst"
              @click="setMode(VIEW_MODES.ANALYST)"
              data-testid="view-mode-analyst"
            >Аналитик</button>
            <button
              type="button"
              :class="[
                'px-2.5 py-1 rounded-md font-medium transition-colors',
                viewMode.isClient
                  ? 'bg-brand-indigo text-white shadow-sm'
                  : 'text-gray-400 hover:text-gray-200',
              ]"
              :aria-pressed="viewMode.isClient"
              @click="setMode(VIEW_MODES.CLIENT)"
              data-testid="view-mode-client"
            >Клиент</button>
          </div>

          <span class="hidden sm:inline text-sm text-gray-400 truncate max-w-[12rem]">
            {{ auth.user?.name || auth.user?.email }}
          </span>
          <button @click="handleLogout" class="btn-ghost text-xs">Выйти</button>
        </div>
      </header>

      <!-- Content -->
      <main class="flex-1 overflow-y-auto bg-surface-base">
        <slot />
      </main>
    </div>
  </div>
</template>
