<script setup>
import { onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';

const router = useRouter();
const route  = useRoute();
const auth   = useAuthStore();

const name     = ref('');
const email    = ref('');
const password = ref('');
const code     = ref('');
const error    = ref('');
const message  = ref('');
const loading  = ref(false);
const resendLoading = ref(false);
const resendCooldown = ref(0);
const queryEmail = String(route.query.verify || '').trim().toLowerCase();
const verificationEmail = ref(auth.pendingVerification?.email || queryEmail);
const step = ref(verificationEmail.value ? 'verify' : 'register');
let resendTimer = null;

function startResendCooldown(seconds = 60) {
  resendCooldown.value = Math.max(0, Number(seconds) || 60);
  if (resendTimer) clearInterval(resendTimer);
  resendTimer = setInterval(() => {
    resendCooldown.value = Math.max(0, resendCooldown.value - 1);
    if (resendCooldown.value <= 0) {
      clearInterval(resendTimer);
      resendTimer = null;
    }
  }, 1000);
}

function friendlyError(e, fallback) {
  return e.response?.data?.error || e.message || fallback;
}

async function submit() {
  error.value = '';
  message.value = '';
  loading.value = true;
  try {
    if (step.value === 'verify') {
      await auth.verifyEmail(verificationEmail.value, code.value);
      router.push('/dashboard');
      return;
    }

    const result = await auth.register(email.value, password.value, name.value);
    if (result?.pending_verification) {
      verificationEmail.value = result.email || email.value;
      step.value = 'verify';
      message.value = result.warning || 'Код подтверждения отправлен на ваш email.';
      startResendCooldown(result.retry_after);
      return;
    }
    router.push('/dashboard');
  } catch (e) {
    error.value = friendlyError(e, step.value === 'verify' ? 'Не удалось подтвердить email' : 'Ошибка регистрации');
    if (e.response?.status === 410 || e.response?.data?.reason === 'expired_or_missing') {
      message.value = 'Код больше не действует. Запросите новый код.';
    }
  } finally {
    loading.value = false;
  }
}

async function resendCode() {
  if (resendCooldown.value > 0 || resendLoading.value) return;
  error.value = '';
  message.value = '';
  resendLoading.value = true;
  try {
    const result = await auth.resendVerification(verificationEmail.value);
    message.value = result?.warning || result?.message || 'Если аккаунт ожидает подтверждения, новый код будет отправлен.';
    startResendCooldown(result?.retry_after);
  } catch (e) {
    error.value = friendlyError(e, 'Не удалось отправить код');
    startResendCooldown(e.response?.data?.retry_after || 60);
  } finally {
    resendLoading.value = false;
  }
}

function changeEmail() {
  step.value = 'register';
  code.value = '';
  error.value = '';
  message.value = '';
}

onUnmounted(() => {
  if (resendTimer) clearInterval(resendTimer);
});
</script>

<template>
  <div class="min-h-screen bg-gray-950 flex">
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
        <h2 class="text-4xl font-extrabold leading-tight">Начните создавать<br>контент с AI</h2>
        <p class="mt-4 text-indigo-100/80 text-lg">Один аккаунт — полный набор инструментов для SEO-команды: от текстов до прогнозов трафика.</p>
        <ul class="mt-8 space-y-3 text-indigo-50/90">
          <li class="flex items-center gap-3"><span class="flex-shrink-0 w-7 h-7 rounded-lg bg-white/15 flex items-center justify-center">⚡</span>Быстрый старт — без настройки</li>
          <li class="flex items-center gap-3"><span class="flex-shrink-0 w-7 h-7 rounded-lg bg-white/15 flex items-center justify-center">🧩</span>11 инструментов в одном окне</li>
          <li class="flex items-center gap-3"><span class="flex-shrink-0 w-7 h-7 rounded-lg bg-white/15 flex items-center justify-center">📊</span>Аналитика и прогнозы из коробки</li>
        </ul>
      </div>

      <p class="relative text-sm text-indigo-200/70">© SEO Genius · v4.0</p>
    </aside>

    <div class="flex-1 flex items-center justify-center px-4 py-10">
      <div class="w-full max-w-sm">
        <div class="text-center mb-8 lg:hidden">
          <div class="inline-flex items-center gap-2 mb-2">
            <svg viewBox="0 0 32 32" class="w-8 h-8" fill="none"><rect width="32" height="32" rx="8" fill="#6366f1"/><path d="M8 16a8 8 0 1 1 10.6 7.6" stroke="white" stroke-width="2" stroke-linecap="round"/><circle cx="16" cy="16" r="3" fill="white"/><path d="M22 22l4 4" stroke="white" stroke-width="2.5" stroke-linecap="round"/></svg>
            <span class="text-xl font-bold text-white">SEO Genius</span>
          </div>
          <p class="text-gray-500 text-sm">v4.0 — AI Content Platform</p>
        </div>

        <div class="card">
          <template v-if="step === 'register'">
            <h1 class="text-xl font-semibold text-white mb-1">Создать аккаунт</h1>
            <p class="text-sm text-gray-400 mb-6">Это займёт меньше минуты</p>
            <form @submit.prevent="submit" class="space-y-4">
              <div><label class="label">Ваше имя</label><input v-model="name" type="text" class="input" placeholder="Иван Иванов" autocomplete="name" /></div>
              <div><label class="label">Email</label><input v-model="email" type="email" class="input" placeholder="you@example.com" required autocomplete="email" /></div>
              <div><label class="label">Пароль (мин. 8 символов)</label><input v-model="password" type="password" class="input" placeholder="••••••••" required minlength="8" autocomplete="new-password" /></div>
              <div v-if="error" class="bg-red-950 border border-red-800 text-red-400 text-sm px-3 py-2 rounded-lg">{{ error }}</div>
              <button type="submit" class="btn-primary w-full justify-center" :disabled="loading">
                <svg v-if="loading" class="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
                {{ loading ? 'Регистрируем...' : 'Зарегистрироваться' }}
              </button>
            </form>
          </template>

          <template v-else>
            <h1 class="text-xl font-semibold text-white mb-1">Подтвердите email</h1>
            <p class="text-sm text-gray-400 mb-6">Мы отправили 6-значный код на <strong class="text-gray-200">{{ verificationEmail }}</strong>.</p>
            <form @submit.prevent="submit" class="space-y-4">
              <div>
                <label class="label">Код из письма</label>
                <input v-model="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" class="input text-center text-2xl tracking-[0.5em]" placeholder="000000" required />
              </div>
              <div v-if="message" class="bg-indigo-950 border border-indigo-800 text-indigo-200 text-sm px-3 py-2 rounded-lg">{{ message }}</div>
              <div v-if="error" class="bg-red-950 border border-red-800 text-red-400 text-sm px-3 py-2 rounded-lg">{{ error }}</div>
              <button type="submit" class="btn-primary w-full justify-center" :disabled="loading || code.length !== 6">
                {{ loading ? 'Проверяем...' : 'Подтвердить email' }}
              </button>
            </form>
            <div class="flex items-center justify-between mt-5 text-sm">
              <button class="text-gray-500 hover:text-gray-300" type="button" @click="changeEmail">Изменить email</button>
              <button class="text-indigo-400 hover:text-indigo-300 disabled:text-gray-600" type="button" :disabled="resendLoading || resendCooldown > 0" @click="resendCode">
                {{ resendLoading ? 'Отправляем...' : resendCooldown > 0 ? `Повторить через ${resendCooldown}с` : 'Отправить код ещё раз' }}
              </button>
            </div>
          </template>

          <p class="text-center text-sm text-gray-500 mt-5">
            Уже есть аккаунт?
            <RouterLink to="/login" class="text-indigo-400 hover:text-indigo-300">Войти</RouterLink>
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
