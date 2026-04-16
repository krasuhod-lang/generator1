import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import api from '../api.js';

export const useAuthStore = defineStore('auth', () => {
  const token = ref(null);
  const user  = ref(null);

  const isLoggedIn = computed(() => !!token.value);

  // ── Восстановление сессии при перезагрузке страницы ─────────────────────
  // Вызывается в App.vue → onMounted.
  // Request interceptor в api.js сам читает localStorage, поэтому здесь
  // достаточно восстановить реактивный стейт и проверить, жив ли токен.
  async function restoreSession() {
    const saved = localStorage.getItem('seo_token');
    if (!saved) return;

    token.value = saved;
    // Также ставим в defaults как резерв (перед инициализацией interceptor'а)
    api.defaults.headers.common['Authorization'] = `Bearer ${saved}`;

    try {
      await fetchMe();
    } catch (err) {
      // Токен протух или невалиден — полностью выходим
      logout();
    }
  }

  // ── Регистрация ──────────────────────────────────────────────────────────
  async function register(email, password, name) {
    const { data } = await api.post('/auth/register', { email, password, name });
    _applyAuth(data);
    return data;
  }

  // ── Логин ────────────────────────────────────────────────────────────────
  async function login(email, password) {
    const { data } = await api.post('/auth/login', { email, password });
    _applyAuth(data);
    return data;
  }

  // ── Профиль ──────────────────────────────────────────────────────────────
  async function fetchMe() {
    const { data } = await api.get('/auth/me');
    user.value = data.user;
  }

  // ── Выход ────────────────────────────────────────────────────────────────
  // Только чистит стейт — редирект на /login делает вызывающий код
  // (router guard в router/index.js или 401-interceptor в api.js).
  function logout() {
    token.value = null;
    user.value  = null;
    localStorage.removeItem('seo_token');
    delete api.defaults.headers.common['Authorization'];
  }

  // ── Внутренний хелпер: применяем данные после успешного login/register ──
  function _applyAuth(data) {
    if (!data.token) throw new Error('Сервер не вернул токен');
    token.value = data.token;
    user.value  = data.user;
    localStorage.setItem('seo_token', data.token);
    // Дублируем в defaults — для запросов, которые уйдут до следующего
    // interceptor-цикла (например, сразу после логина)
    api.defaults.headers.common['Authorization'] = `Bearer ${data.token}`;
  }

  return {
    token,
    user,
    isLoggedIn,
    restoreSession,
    register,
    login,
    logout,
    fetchMe,
  };
});
