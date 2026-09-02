import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import api from '../api.js';

function readStoredToken() {
  try {
    return localStorage.getItem('seo_token');
  } catch (_) {
    return null;
  }
}

function writeStoredToken(value) {
  try {
    localStorage.setItem('seo_token', value);
  } catch (_) {
    // Текущая сессия остаётся в памяти, даже если storage недоступен.
  }
}

function clearStoredToken() {
  try {
    localStorage.removeItem('seo_token');
  } catch (_) {
    // Нечего очищать, если storage заблокирован браузером.
  }
}

function readPendingVerification() {
  try {
    const raw = sessionStorage.getItem('seo_pending_verification');
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

export const useAuthStore = defineStore('auth', () => {
  const token = ref(readStoredToken());
  const user  = ref(null);
  const pendingVerification = ref(readPendingVerification());

  const isLoggedIn = computed(() => !!token.value);

  if (token.value) {
    api.defaults.headers.common['Authorization'] = `Bearer ${token.value}`;
  }

  async function restoreSession() {
    const saved = readStoredToken();
    if (!saved) return;

    token.value = saved;
    api.defaults.headers.common['Authorization'] = `Bearer ${saved}`;

    try {
      await fetchMe();
    } catch (_) {
      logout();
    }
  }

  async function register(email, password, name) {
    const { data } = await api.post('/auth/register', { email, password, name });
    if (data?.pending_verification) {
      setPendingVerification(data.email || email, data.retry_after);
      return data;
    }
    _applyAuth(data);
    return data;
  }

  async function login(email, password) {
    const { data } = await api.post('/auth/login', { email, password });
    _applyAuth(data);
    return data;
  }

  async function verifyEmail(email, code) {
    const { data } = await api.post('/auth/verify-email', { email, code });
    _applyAuth(data);
    pendingVerification.value = null;
    sessionStorage.removeItem('seo_pending_verification');
    return data;
  }

  async function resendVerification(email) {
    const { data } = await api.post('/auth/resend-verification', { email });
    if (data?.pending_verification || data?.email) {
      setPendingVerification(data.email || email, data.retry_after);
    }
    return data;
  }

  async function fetchMe() {
    const { data } = await api.get('/auth/me');
    user.value = data.user;
  }

  function logout() {
    token.value = null;
    user.value  = null;
    clearStoredToken();
    delete api.defaults.headers.common['Authorization'];
  }

  function setPendingVerification(email, retryAfter = 60) {
    pendingVerification.value = {
      email: String(email || '').trim().toLowerCase(),
      retryAfter: Number(retryAfter) || 60,
    };
    try {
      sessionStorage.setItem('seo_pending_verification', JSON.stringify(pendingVerification.value));
    } catch (_) { /* sessionStorage may be unavailable in privacy mode */ }
  }

  function _applyAuth(data) {
    if (!data?.token) throw new Error('Сервер не вернул токен');
    token.value = data.token;
    user.value  = data.user;
    writeStoredToken(data.token);
    api.defaults.headers.common['Authorization'] = `Bearer ${data.token}`;
  }

  return {
    token,
    user,
    pendingVerification,
    isLoggedIn,
    restoreSession,
    register,
    login,
    verifyEmail,
    resendVerification,
    logout,
    fetchMe,
  };
});
