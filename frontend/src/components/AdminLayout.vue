<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAdminStore } from '../stores/admin.js';

const route = useRoute();
const router = useRouter();
const admin = useAdminStore();
const sidebarOpen = ref(false);

const navGroups = [
  {
    label: 'Рабочая область',
    items: [
      { label: 'Обзор', description: 'Сводка по сервису', to: '/admin', icon: '◉' },
      { label: 'Пользователи', description: 'Роли и тарифы', to: '/admin/users', icon: '◎' },
      { label: 'Задачи', description: 'Все генерации', to: '/admin/tasks', icon: '▦' },
    ],
  },
  {
    label: 'Контроль',
    items: [
      { label: 'API и расходы', description: 'Токены, стоимость, воронки', to: '/admin/usage', icon: '◈' },
      { label: 'Хранилище', description: 'Диск, БД и очистка', to: '/admin/storage', icon: '▤' },
      { label: 'Доступы к проектам', description: 'Гранты пользователей', to: '/admin/projects', icon: '⌁' },
    ],
  },
  {
    label: 'Система',
    items: [
      { label: 'API-ключи', description: 'Интеграции и vault', to: '/admin/api-keys', icon: '⚿' },
    ],
  },
];

const flatNav = computed(() => navGroups.flatMap((group) => group.items));
const currentNav = computed(() => flatNav.value.find((item) => isActive(item)) || flatNav.value[0]);

function isActive(item) {
  if (item.to === '/admin') return route.path === '/admin';
  return route.path === item.to || route.path.startsWith(`${item.to}/`);
}

function closeSidebar() {
  sidebarOpen.value = false;
}

function handleLogout() {
  closeSidebar();
  admin.adminLogout();
  router.push('/admin/login');
}

function handleKeydown(event) {
  if (event.key === 'Escape') closeSidebar();
}

onMounted(() => window.addEventListener('keydown', handleKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', handleKeydown));
</script>

<template>
  <div class="min-h-screen bg-gray-950 text-gray-100">
    <div
      v-if="sidebarOpen"
      class="fixed inset-0 z-[65] bg-black/70 backdrop-blur-sm lg:hidden"
      aria-hidden="true"
      @click="closeSidebar"
    />

    <aside
      class="fixed inset-y-0 left-0 z-[70] flex w-[286px] -translate-x-full flex-col border-r border-gray-800/90 bg-gray-950/95 shadow-2xl shadow-black/40 backdrop-blur-xl transition-transform duration-200 ease-out lg:translate-x-0"
      :class="{ 'translate-x-0': sidebarOpen }"
      aria-label="Навигация администратора"
    >
      <div class="flex min-h-[76px] items-center justify-between border-b border-gray-800/80 px-5">
        <router-link to="/admin" class="flex min-w-0 items-center gap-3" @click="closeSidebar">
          <span class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-emerald-500 text-lg font-bold text-gray-950 shadow-lg shadow-emerald-500/20">S</span>
          <span class="min-w-0">
            <span class="block truncate text-sm font-semibold text-white">SEO Genius</span>
            <span class="block text-[11px] font-medium uppercase tracking-[0.18em] text-emerald-400">Admin console</span>
          </span>
        </router-link>
        <button
          type="button"
          class="rounded-lg p-2 text-gray-500 transition hover:bg-gray-800 hover:text-gray-200 lg:hidden"
          aria-label="Закрыть меню"
          @click="closeSidebar"
        >
          ×
        </button>
      </div>

      <nav class="min-h-0 flex-1 overflow-y-auto px-3 py-5" aria-label="Основные разделы">
        <div v-for="group in navGroups" :key="group.label" class="mb-6 last:mb-0">
          <p class="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-600">{{ group.label }}</p>
          <div class="space-y-1">
            <router-link
              v-for="item in group.items"
              :key="item.to"
              :to="item.to"
              class="group flex items-center gap-3 rounded-xl px-3 py-3 transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70"
              :class="isActive(item) ? 'bg-emerald-500/10 text-white ring-1 ring-inset ring-emerald-500/20' : 'text-gray-400 hover:bg-gray-900 hover:text-gray-100'"
              :aria-current="isActive(item) ? 'page' : undefined"
              @click="closeSidebar"
            >
              <span
                class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-base transition-colors"
                :class="isActive(item) ? 'bg-emerald-400 text-gray-950' : 'bg-gray-900 text-gray-500 group-hover:text-emerald-300'"
                aria-hidden="true"
              >{{ item.icon }}</span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-medium">{{ item.label }}</span>
                <span class="mt-0.5 block truncate text-[11px]" :class="isActive(item) ? 'text-emerald-300/70' : 'text-gray-600 group-hover:text-gray-500'">{{ item.description }}</span>
              </span>
              <span v-if="isActive(item)" class="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
            </router-link>
          </div>
        </div>
      </nav>

      <div class="border-t border-gray-800/80 p-4">
        <div class="flex items-center gap-3 rounded-xl bg-gray-900/70 p-3">
          <span class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-indigo-500/20 text-sm font-semibold text-indigo-300">A</span>
          <div class="min-w-0 flex-1">
            <p class="truncate text-xs font-medium text-gray-200">{{ admin.adminUser?.email || 'Администратор' }}</p>
            <p class="mt-0.5 text-[11px] text-gray-600">Полный доступ</p>
          </div>
          <button type="button" class="rounded-lg p-1.5 text-gray-600 transition hover:bg-gray-800 hover:text-red-300" aria-label="Выйти" title="Выйти" @click="handleLogout">↪</button>
        </div>
      </div>
    </aside>

    <div class="min-h-screen lg:pl-[286px]">
      <header class="app-header flex min-h-[76px] items-center justify-between gap-4 border-b border-gray-800/80 bg-gray-950/90 px-4 py-3 backdrop-blur-xl sm:px-6 lg:px-8">
        <div class="flex min-w-0 items-center gap-3">
          <button
            type="button"
            class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-gray-800 bg-gray-900 text-lg text-gray-300 transition hover:border-gray-700 hover:bg-gray-800 lg:hidden"
            aria-label="Открыть меню"
            :aria-expanded="sidebarOpen"
            @click="sidebarOpen = true"
          >
            ☰
          </button>
          <div class="min-w-0">
            <p class="hidden text-[10px] font-semibold uppercase tracking-[0.2em] text-emerald-400/80 sm:block">Административный контур</p>
            <h1 class="truncate text-base font-semibold text-white sm:text-lg">{{ currentNav?.label || 'Панель управления' }}</h1>
          </div>
        </div>
        <div class="flex flex-shrink-0 items-center gap-2 sm:gap-4">
          <span class="hidden max-w-[220px] truncate text-xs text-gray-500 md:block">{{ admin.adminUser?.email || 'Admin' }}</span>
          <button type="button" class="btn-ghost px-3 py-2 text-xs" @click="handleLogout">Выйти</button>
        </div>
      </header>

      <main class="app-main min-w-0">
        <slot />
      </main>
    </div>
  </div>
</template>
