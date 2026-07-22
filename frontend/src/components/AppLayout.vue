<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { useViewModeStore, VIEW_MODES } from '../stores/viewMode.js';

const route  = useRoute();
const router = useRouter();
const auth   = useAuthStore();
const viewMode = useViewModeStore();

function setMode(mode) {
  viewMode.setMode(mode);
}

// Тумблер «Аналитик/Клиент» имеет смысл ТОЛЬКО в модуле «Проекты»: именно там
// backend-санитайзер (services/projects/viewMode.js) реально срезает
// технические поля из ответа по заголовку X-Client-Mode. В остальных модулях
// кнопка была «мёртвой» и лишь сбивала пользователя, поэтому показываем тумблер
// строго на маршрутах /projects/*. В отчётах режим клиента задаётся в модалке
// публикации (shared_reports.view_mode) отдельной кнопкой «🔍 Превью».
const showViewModeToggle = computed(() => String(route.path || '').startsWith('/projects'));

// «Съём позиций» намеренно убран из верхнего меню: этот раздел живёт внутри
// модуля «Проекты» (вкладка «📈 Съём позиций» → PositionsSection), поэтому
// дублировать его отдельной кнопкой не нужно. Маршрут /position-tracker
// остаётся рабочим для переходов из карточек проектов.
const TABS = [
  { key: 'seo-text',       label: 'SEO текст',        icon: '📝', path: '/dashboard' },
  { key: 'copilot',        label: 'AI-редактор',      icon: '🤖', path: '/copilot' },
  { key: 'meta-tags',      label: 'Мета-теги',        icon: '🏷️', path: '/meta-tags' },
  { key: 'link-article',   label: 'Ссылочная статья', icon: '🔗', path: '/link-article' },
  { key: 'info-article',   label: 'Статья в блог',    icon: '📰', path: '/info-article' },
  { key: 'article-topics', label: 'Темы статей',      icon: '🔮', path: '/article-topics' },
  { key: 'forecaster',     label: 'Создать КП',       icon: '📈', path: '/forecaster' },
  { key: 'category-lead',  label: 'Lead-text',        icon: '🧭', path: '/category-lead' },
  { key: 'outreach',       label: 'Outreach',         icon: '📨', path: '/outreach' },
  { key: 'audits',         label: 'Аудиты',           icon: '🕷️', path: '/audits' },
  { key: 'projects',       label: 'Проекты',          icon: '🗂️', path: '/projects' },
  { key: 'reports',        label: 'Отчёты',           icon: '📑', path: '/reports' },
  { key: 'acf-json',       label: 'JSON',             icon: '🧩', path: '/acf-json' },
  { key: 'relevance',      label: 'Релевантность',    icon: '📊', path: '/relevance' },
];

const activeTabKey = computed(() => {
  const p = route.path;
  if (p.startsWith('/meta-tags'))      return 'meta-tags';
  if (p.startsWith('/link-article'))   return 'link-article';
  if (p.startsWith('/info-article'))   return 'info-article';
  if (p.startsWith('/article-topics')) return 'article-topics';
  if (p.startsWith('/forecaster'))     return 'forecaster';
  if (p.startsWith('/proposals'))      return 'forecaster';
  if (p.startsWith('/category-lead'))  return 'category-lead';
  if (p.startsWith('/serp-b2b'))       return 'outreach';
  if (p.startsWith('/outreach'))       return 'outreach';
  if (p.startsWith('/position-tracker')) return 'position-tracker';
  if (p.startsWith('/site-crawler'))   return 'audits';
  if (p.startsWith('/audits'))         return 'audits';
  if (p.startsWith('/projects'))       return 'projects';
  if (p.startsWith('/reports'))        return 'reports';
  if (p.startsWith('/acf-json'))       return 'acf-json';
  if (p.startsWith('/relevance'))      return 'relevance';
  if (p.startsWith('/copilot') || /\/tasks\/[^/]+\/copilot/.test(p)) return 'copilot';
  return 'seo-text';
});

const activeTab = computed(() =>
  TABS.find((t) => t.key === activeTabKey.value) || TABS[0]
);

const menuOpen = ref(false);
const menuRef  = ref(null);

function toggleMenu() {
  menuOpen.value = !menuOpen.value;
}

function goTab(tab) {
  menuOpen.value = false;
  router.push(tab.path);
}

function handleClickOutside(e) {
  if (menuRef.value && !menuRef.value.contains(e.target)) {
    menuOpen.value = false;
  }
}

function handleEsc(e) {
  if (e.key === 'Escape') menuOpen.value = false;
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside);
  document.addEventListener('keydown', handleEsc);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', handleClickOutside);
  document.removeEventListener('keydown', handleEsc);
});

function handleLogout() {
  auth.logout();
  router.push('/login');
}
</script>

<template>
  <div class="min-h-screen bg-gray-950 flex flex-col">
    <!-- Шапка -->
    <header class="border-b border-gray-800 bg-gray-900 px-6 py-3 flex items-center justify-between gap-4 flex-shrink-0">
      <div class="flex items-center gap-3 min-w-0">
        <svg viewBox="0 0 32 32" class="w-7 h-7 flex-shrink-0" fill="none">
          <rect width="32" height="32" rx="8" fill="#6366f1"/>
          <path d="M8 16a8 8 0 1 1 10.6 7.6" stroke="white" stroke-width="2" stroke-linecap="round"/>
          <circle cx="16" cy="16" r="3" fill="white"/>
          <path d="M22 22l4 4" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
        </svg>
        <span class="font-bold text-white truncate">SEO Genius <span class="text-indigo-400">v4.0</span></span>

        <!-- Навигация: выпадающее меню (всегда в видимой области) -->
        <div ref="menuRef" class="relative ml-2 sm:ml-4">
          <button
            type="button"
            @click="toggleMenu"
            :aria-expanded="menuOpen"
            class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium
                   bg-gray-800 hover:bg-gray-700 text-gray-100 border border-gray-700
                   transition-colors"
          >
            <span class="text-base leading-none">{{ activeTab.icon }}</span>
            <!-- Фиксированная ширина ярлыка: не даём кнопке «прыгать» при смене
                 активной вкладки (у ярлыков разная длина). -->
            <span class="hidden sm:inline sm:w-32 truncate text-left">{{ activeTab.label }}</span>
            <svg
              class="w-4 h-4 text-gray-400 transition-transform duration-200"
              :class="{ 'rotate-180': menuOpen }"
              viewBox="0 0 20 20" fill="currentColor"
            >
              <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.24a.75.75 0 01-1.06 0L5.21 8.29a.75.75 0 01.02-1.08z" clip-rule="evenodd"/>
            </svg>
          </button>

          <transition
            enter-active-class="transition ease-out duration-150"
            enter-from-class="opacity-0 -translate-y-1"
            enter-to-class="opacity-100 translate-y-0"
            leave-active-class="transition ease-in duration-100"
            leave-from-class="opacity-100 translate-y-0"
            leave-to-class="opacity-0 -translate-y-1"
          >
            <div
              v-if="menuOpen"
              class="absolute left-0 mt-2 w-72 max-w-[90vw] z-50 rounded-xl border border-gray-700
                     bg-gray-900 shadow-2xl shadow-black/40 p-1.5 grid grid-cols-1 gap-0.5"
            >
              <button
                v-for="tab in TABS"
                :key="tab.key"
                @click="goTab(tab)"
                :class="[
                  'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-left transition-colors',
                  activeTabKey === tab.key
                    ? 'bg-indigo-600 text-white'
                    : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                ]"
              >
                <span class="text-base w-5 text-center">{{ tab.icon }}</span>
                <span class="truncate">{{ tab.label }}</span>
              </button>
            </div>
          </transition>
        </div>
      </div>

      <div class="flex items-center gap-3 flex-shrink-0">
        <!--
          PR-3: тумблер режима «Аналитик/Клиент» (state в PR-2,
          stores/viewMode.js). При клиентском режиме axios-перехватчик
          в api.js добавляет заголовок X-Client-Mode: 1, и backend
          (viewMode.js#resolveViewMode) срезает технические поля из ответа.
        -->
        <div
          v-if="showViewModeToggle"
          role="group"
          aria-label="Режим отображения"
          class="inline-flex items-center rounded-lg border border-gray-700 bg-gray-950 p-0.5 text-xs"
        >
          <button
            type="button"
            :class="[
              'px-2.5 py-1 rounded-md font-medium transition-colors',
              viewMode.isAnalyst
                ? 'bg-indigo-600 text-white shadow-sm'
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
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-gray-400 hover:text-gray-200',
            ]"
            :aria-pressed="viewMode.isClient"
            @click="setMode(VIEW_MODES.CLIENT)"
            data-testid="view-mode-client"
          >Клиент</button>
        </div>

        <span class="hidden sm:inline text-sm text-gray-400 truncate max-w-[12rem]">{{ auth.user?.name || auth.user?.email }}</span>
        <button @click="handleLogout" class="btn-ghost text-xs">Выйти</button>
      </div>
    </header>

    <!-- Контент вкладки -->
    <main class="flex-1">
      <slot />
    </main>
  </div>
</template>
