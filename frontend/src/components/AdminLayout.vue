<script setup>
import { useRouter } from 'vue-router';
import { useAdminStore } from '../stores/admin.js';

const router = useRouter();
const admin  = useAdminStore();

function handleLogout() {
  admin.adminLogout();
  router.push('/admin/login');
}
</script>

<template>
  <div class="min-h-screen bg-gray-950 flex flex-col">
    <!-- Шапка -->
    <header class="border-b border-gray-800 bg-gray-900 px-6 py-3 flex items-center justify-between flex-shrink-0">
      <div class="flex items-center gap-3">
        <svg viewBox="0 0 32 32" class="w-7 h-7" fill="none">
          <rect width="32" height="32" rx="8" fill="#059669"/>
          <path d="M8 16a8 8 0 1 1 10.6 7.6" stroke="white" stroke-width="2" stroke-linecap="round"/>
          <circle cx="16" cy="16" r="3" fill="white"/>
          <path d="M22 22l4 4" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
        </svg>
        <span class="font-bold text-white">SEO Genius <span class="text-emerald-400">Admin</span></span>
      </div>
      <div class="flex items-center gap-4">
        <router-link to="/admin" class="text-sm text-gray-400 hover:text-gray-200 transition-colors">Главная</router-link>
        <span class="text-sm text-gray-500">{{ admin.adminUser?.email || 'Admin' }}</span>
        <button @click="handleLogout" class="btn-ghost text-xs">Выйти</button>
      </div>
    </header>

    <!-- Контент -->
    <main class="flex-1">
      <slot />
    </main>
  </div>
</template>
