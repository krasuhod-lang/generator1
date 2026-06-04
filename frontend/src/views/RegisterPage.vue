<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';

const router = useRouter();
const auth   = useAuthStore();

const name     = ref('');
const email    = ref('');
const password = ref('');
const error    = ref('');
const loading  = ref(false);

async function submit() {
  error.value   = '';
  loading.value = true;
  try {
    await auth.register(email.value, password.value, name.value);
    router.push('/dashboard');
  } catch (e) {
    error.value = e.response?.data?.error || 'Ошибка регистрации';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen bg-gray-950 flex">
    <!-- Левая «обложка» сервиса -->
    <aside
      class="hidden lg:flex flex-col justify-between w-1/2 relative overflow-hidden
             bg-gradient-to-br from-indigo-700 via-indigo-800 to-gray-950 p-12 text-white"
    >
      <div class="pointer-events-none absolute -top-24 -right-24 w-96 h-96 rounded-full bg-indigo-400/20 blur-3xl"></div>
      <div class="pointer-events-none absolute bottom-0 -left-24 w-96 h-96 rounded-full bg-fuchsia-500/10 blur-3xl"></div>

      <div class="relative flex items-center gap-3">
        <svg viewBox="0 0 32 32" class="w-9 h-9" fill="none" aria-label="SEO Genius">
          <rect width="32" height="32" rx="8" fill="white"/>
          <path d="M8 16a8 8 0 1 1 10.6 7.6" stroke="#4f46e5" stroke-width="2" stroke-linecap="round"/>
          <circle cx="16" cy="16" r="3" fill="#4f46e5"/>
          <path d="M22 22l4 4" stroke="#4f46e5" stroke-width="2.5" stroke-linecap="round"/>
        </svg>
        <span class="text-2xl font-bold tracking-tight">SEO Genius</span>
      </div>

      <div class="relative max-w-md">
        <h2 class="text-4xl font-extrabold leading-tight">
          Начните создавать<br>контент с AI
        </h2>
        <p class="mt-4 text-indigo-100/80 text-lg">
          Один аккаунт — полный набор инструментов для SEO-команды:
          от текстов до прогнозов трафика.
        </p>
        <ul class="mt-8 space-y-3 text-indigo-50/90">
          <li class="flex items-center gap-3">
            <span class="flex-shrink-0 w-7 h-7 rounded-lg bg-white/15 flex items-center justify-center">⚡</span>
            Быстрый старт — без настройки
          </li>
          <li class="flex items-center gap-3">
            <span class="flex-shrink-0 w-7 h-7 rounded-lg bg-white/15 flex items-center justify-center">🧩</span>
            11 инструментов в одном окне
          </li>
          <li class="flex items-center gap-3">
            <span class="flex-shrink-0 w-7 h-7 rounded-lg bg-white/15 flex items-center justify-center">📊</span>
            Аналитика и прогнозы из коробки
          </li>
        </ul>
      </div>

      <p class="relative text-sm text-indigo-200/70">© SEO Genius · v4.0</p>
    </aside>

    <!-- Правая часть — форма регистрации -->
    <div class="flex-1 flex items-center justify-center px-4 py-10">
      <div class="w-full max-w-sm">
        <div class="text-center mb-8 lg:hidden">
          <div class="inline-flex items-center gap-2 mb-2">
            <svg viewBox="0 0 32 32" class="w-8 h-8" fill="none">
              <rect width="32" height="32" rx="8" fill="#6366f1"/>
              <path d="M8 16a8 8 0 1 1 10.6 7.6" stroke="white" stroke-width="2" stroke-linecap="round"/>
              <circle cx="16" cy="16" r="3" fill="white"/>
              <path d="M22 22l4 4" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
            </svg>
            <span class="text-xl font-bold text-white">SEO Genius</span>
          </div>
          <p class="text-gray-500 text-sm">v4.0 — AI Content Platform</p>
        </div>

        <div class="card">
          <h1 class="text-xl font-semibold text-white mb-1">Создать аккаунт</h1>
          <p class="text-sm text-gray-400 mb-6">Это займёт меньше минуты</p>

          <form @submit.prevent="submit" class="space-y-4">
            <div>
              <label class="label">Ваше имя</label>
              <input v-model="name" type="text" class="input" placeholder="Иван Иванов" autocomplete="name" />
            </div>
            <div>
              <label class="label">Email</label>
              <input v-model="email" type="email" class="input" placeholder="you@example.com" required autocomplete="email" />
            </div>
            <div>
              <label class="label">Пароль (мин. 8 символов)</label>
              <input v-model="password" type="password" class="input" placeholder="••••••••" required minlength="8" autocomplete="new-password" />
            </div>

            <div v-if="error" class="bg-red-950 border border-red-800 text-red-400 text-sm px-3 py-2 rounded-lg">
              {{ error }}
            </div>

            <button type="submit" class="btn-primary w-full justify-center" :disabled="loading">
              <svg v-if="loading" class="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
              </svg>
              {{ loading ? 'Регистрируем...' : 'Зарегистрироваться' }}
            </button>
          </form>

          <p class="text-center text-sm text-gray-500 mt-5">
            Уже есть аккаунт?
            <RouterLink to="/login" class="text-indigo-400 hover:text-indigo-300">Войти</RouterLink>
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
