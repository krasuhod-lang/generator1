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
  <div class="auth-shell min-h-screen bg-gray-950 flex items-center justify-center px-4">
    <div class="w-full max-w-sm">
      <!-- Logo -->
      <div class="text-center mb-8">
        <div class="inline-flex items-center gap-2 mb-2">
          <svg viewBox="0 0 32 32" class="auth-brand-mark w-8 h-8" fill="none" aria-label="SeoMST Admin">
            <rect width="32" height="32" rx="8" fill="#6467f2"/>
            <path d="M8 16a8 8 0 1 1 10.6 7.6" stroke="white" stroke-width="2" stroke-linecap="round"/>
            <circle cx="16" cy="16" r="3" fill="white"/>
            <path d="M22 22l4 4" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
          </svg>
          <span class="text-xl font-bold text-white">SeoMST</span>
        </div>
        <p class="text-brand-light text-sm font-medium">Панель администратора</p>
      </div>

      <div class="auth-card card">
        <h1 class="text-lg font-semibold text-white mb-6">Вход для администратора</h1>

        <form @submit.prevent="submit" class="space-y-4">
          <div>
            <label for="admin-login-email" class="label">Email</label>
            <input
              id="admin-login-email"
              v-model="email"
              type="email"
              inputmode="email"
              autocapitalize="none"
              class="input"
              placeholder="admin@seomst.ru"
              required
              autocomplete="email"
              :aria-invalid="Boolean(error)"
              aria-describedby="admin-login-error"
            />
          </div>
          <div>
            <label for="admin-login-password" class="label">Пароль</label>
            <input
              id="admin-login-password"
              v-model="password"
              type="password"
              class="input"
              placeholder="••••••••"
              required
              autocomplete="current-password"
              :aria-invalid="Boolean(error)"
              aria-describedby="admin-login-error"
            />
          </div>

          <div
            v-if="error"
            id="admin-login-error"
            role="alert"
            aria-live="polite"
            class="bg-red-950 border border-red-800 text-red-400 text-sm px-3 py-2 rounded-lg"
          >
            {{ error }}
          </div>

          <button
            type="submit"
            class="btn-primary w-full justify-center"
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
