<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAdminStore } from '../../stores/admin.js';

const router = useRouter();
const admin  = useAdminStore();

const email    = ref('');
const password = ref('');
const error    = ref('');
const loading  = ref(false);

async function submit() {
  error.value   = '';
  loading.value = true;
  try {
    await admin.adminLogin(email.value, password.value);
    router.push('/admin');
  } catch (e) {
    error.value = e.response?.data?.error || 'Ошибка входа';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen bg-gray-950 flex items-center justify-center px-4">
    <div class="w-full max-w-sm">
      <!-- Logo -->
      <div class="text-center mb-8">
        <div class="inline-flex items-center gap-2 mb-2">
          <svg viewBox="0 0 32 32" class="w-8 h-8" fill="none" aria-label="SEO Genius Admin">
            <rect width="32" height="32" rx="8" fill="#059669"/>
            <path d="M8 16a8 8 0 1 1 10.6 7.6" stroke="white" stroke-width="2" stroke-linecap="round"/>
            <circle cx="16" cy="16" r="3" fill="white"/>
            <path d="M22 22l4 4" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
          </svg>
          <span class="text-xl font-bold text-white">SEO Genius</span>
        </div>
        <p class="text-emerald-400 text-sm font-medium">Панель администратора</p>
      </div>

      <div class="card border-emerald-900/50">
        <h1 class="text-lg font-semibold text-white mb-6">Вход для администратора</h1>

        <form @submit.prevent="submit" class="space-y-4">
          <div>
            <label class="label">Email</label>
            <input
              v-model="email"
              type="email"
              class="input focus:ring-emerald-500"
              placeholder="admin@seomst.ru"
              required
              autocomplete="email"
            />
          </div>
          <div>
            <label class="label">Пароль</label>
            <input
              v-model="password"
              type="password"
              class="input focus:ring-emerald-500"
              placeholder="••••••••"
              required
              autocomplete="current-password"
            />
          </div>

          <div
            v-if="error"
            class="bg-red-950 border border-red-800 text-red-400 text-sm px-3 py-2 rounded-lg"
          >
            {{ error }}
          </div>

          <button
            type="submit"
            class="btn w-full justify-center bg-emerald-700 hover:bg-emerald-600 text-white"
            :disabled="loading"
          >
            <svg v-if="loading" class="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
            </svg>
            {{ loading ? 'Входим...' : 'Войти' }}
          </button>
        </form>
      </div>
    </div>
  </div>
</template>
