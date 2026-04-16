<script setup>
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from './stores/auth';

const router = useRouter();
const auth = useAuthStore();
auth.restoreSession();

const isLoggedIn = computed(() => !!auth.token);

function logout() {
  auth.logout();
  router.push('/login');
}
</script>

<template>
  <div class="min-h-screen flex flex-col">
    <nav class="bg-blue-900 text-white shadow-lg">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="flex items-center justify-between h-16">
          <router-link to="/" class="text-xl font-bold tracking-tight">
            🚀 SEO Genius <span class="text-blue-300 text-sm font-normal">v4.0</span>
          </router-link>

          <div class="flex items-center gap-4">
            <template v-if="isLoggedIn">
              <router-link
                to="/dashboard"
                class="hover:text-blue-300 transition-colors text-sm font-medium"
              >
                Дашборд
              </router-link>
              <router-link
                to="/tasks/create"
                class="hover:text-blue-300 transition-colors text-sm font-medium"
              >
                Создать задачу
              </router-link>
              <span class="text-blue-300 text-sm">{{ auth.user?.name || auth.user?.email }}</span>
              <button
                class="btn bg-blue-700 text-white hover:bg-blue-600 text-sm px-3 py-1.5"
                @click="logout"
              >
                Выйти
              </button>
            </template>
            <template v-else>
              <router-link
                to="/login"
                class="hover:text-blue-300 transition-colors text-sm font-medium"
              >
                Войти
              </router-link>
              <router-link
                to="/register"
                class="btn bg-blue-600 text-white hover:bg-blue-500 text-sm px-3 py-1.5"
              >
                Регистрация
              </router-link>
            </template>
          </div>
        </div>
      </div>
    </nav>

    <main class="flex-1">
      <router-view />
    </main>

    <footer class="bg-gray-100 text-center text-gray-500 text-xs py-4 border-t">
      © {{ new Date().getFullYear() }} SEO Genius v4.0
    </footer>
  </div>
</template>
