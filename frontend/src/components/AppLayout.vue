<script setup>
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';

const route  = useRoute();
const router = useRouter();
const auth   = useAuthStore();

const TABS = [
  { key: 'seo-text',     label: 'Генератор SEO текста',         icon: '📝', path: '/dashboard' },
  { key: 'copilot',      label: 'AI-Редактор',                  icon: '🤖', path: '/copilot' },
  { key: 'meta-tags',    label: 'Генератор Мета-тегов',         icon: '🏷️', path: '/meta-tags' },
  { key: 'link-article', label: 'Генератор ссылочной статьи',   icon: '🔗', path: '/link-article' },
  { key: 'info-article', label: 'Генератор информационной статьи', icon: '📰', path: '/info-article' },
];

const activeTab = computed(() => {
  const p = route.path;
  if (p.startsWith('/meta-tags'))    return 'meta-tags';
  if (p.startsWith('/link-article')) return 'link-article';
  if (p.startsWith('/info-article')) return 'info-article';
  if (p.startsWith('/copilot') || /\/tasks\/[^/]+\/copilot/.test(p)) return 'copilot';
  return 'seo-text';
});

function goTab(tab) {
  router.push(tab.path);
}

function handleLogout() {
  auth.logout();
  router.push('/login');
}
</script>

<template>
  <div class="min-h-screen bg-gray-950 flex flex-col">
    <!-- Шапка -->
    <header class="border-b border-gray-800 bg-gray-900 px-6 py-3 flex items-center justify-between flex-shrink-0">
      <div class="flex items-center gap-3">
        <svg viewBox="0 0 32 32" class="w-7 h-7" fill="none">
          <rect width="32" height="32" rx="8" fill="#6366f1"/>
          <path d="M8 16a8 8 0 1 1 10.6 7.6" stroke="white" stroke-width="2" stroke-linecap="round"/>
          <circle cx="16" cy="16" r="3" fill="white"/>
          <path d="M22 22l4 4" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
        </svg>
        <span class="font-bold text-white">SEO Genius <span class="text-indigo-400">v4.0</span></span>
      </div>
      <div class="flex items-center gap-4">
        <span class="text-sm text-gray-400">{{ auth.user?.name || auth.user?.email }}</span>
        <button @click="handleLogout" class="btn-ghost text-xs">Выйти</button>
      </div>
    </header>

    <!-- Навигация по вкладкам -->
    <nav class="bg-gray-900/50 border-b border-gray-800 px-6 flex-shrink-0">
      <div class="max-w-7xl mx-auto flex gap-1 overflow-x-auto">
        <button
          v-for="tab in TABS"
          :key="tab.key"
          @click="goTab(tab)"
          :class="[
            'flex items-center gap-2 px-4 py-3 text-sm font-medium whitespace-nowrap transition-all duration-200 border-b-2 -mb-px',
            activeTab === tab.key
              ? 'text-indigo-400 border-indigo-500 bg-indigo-950/30'
              : 'text-gray-400 border-transparent hover:text-gray-200 hover:border-gray-600 hover:bg-gray-800/30'
          ]"
        >
          <span class="text-base">{{ tab.icon }}</span>
          <span>{{ tab.label }}</span>
        </button>
      </div>
    </nav>

    <!-- Контент вкладки -->
    <main class="flex-1">
      <slot />
    </main>
  </div>
</template>
