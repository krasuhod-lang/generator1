import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import axios from 'axios';

const adminApi = axios.create({
  baseURL: '/api',
  timeout: 60_000,
  headers: { 'Content-Type': 'application/json' },
});

// Request interceptor — admin token
adminApi.interceptors.request.use((config) => {
  const token = localStorage.getItem('seo_admin_token');
  if (token) {
    config.headers['Authorization'] = `Bearer ${token}`;
  }
  return config;
});

export const useAdminStore = defineStore('admin', () => {
  const adminToken = ref(null);
  const adminUser  = ref(null);
  const users      = ref([]);
  const usersTotal = ref(0);
  const stats      = ref(null);
  const loading    = ref(false);
  const error      = ref(null);

  const isAdminLoggedIn = computed(() => !!adminToken.value);

  // ── Восстановление сессии ────────────────────────────────────────────
  function restoreSession() {
    const saved = localStorage.getItem('seo_admin_token');
    if (saved) {
      adminToken.value = saved;
    }
  }

  // ── Логин ────────────────────────────────────────────────────────────
  async function adminLogin(email, password) {
    const { data } = await adminApi.post('/admin/login', { email, password });
    adminToken.value = data.token;
    adminUser.value  = data.user;
    localStorage.setItem('seo_admin_token', data.token);
    return data;
  }

  // ── Выход ────────────────────────────────────────────────────────────
  function adminLogout() {
    adminToken.value = null;
    adminUser.value  = null;
    localStorage.removeItem('seo_admin_token');
  }

  // ── Список пользователей ─────────────────────────────────────────────
  async function fetchUsers(params = {}) {
    loading.value = true;
    error.value   = null;
    try {
      const query = new URLSearchParams();
      if (params.page)   query.set('page', params.page);
      if (params.limit)  query.set('limit', params.limit);
      if (params.search) query.set('search', params.search);
      if (params.sort)   query.set('sort', params.sort);
      if (params.order)  query.set('order', params.order);

      const { data } = await adminApi.get(`/admin/users?${query.toString()}`);
      users.value      = data.users;
      usersTotal.value = data.total;
      return data;
    } catch (e) {
      error.value = e.response?.data?.error || e.message;
      throw e;
    } finally {
      loading.value = false;
    }
  }

  // ── Детали пользователя ──────────────────────────────────────────────
  async function fetchUserDetail(userId) {
    const { data } = await adminApi.get(`/admin/users/${userId}`);
    return data.user;
  }

  // ── Задачи пользователя ──────────────────────────────────────────────
  async function fetchUserTasks(userId, params = {}) {
    const query = new URLSearchParams();
    if (params.page)  query.set('page', params.page);
    if (params.limit) query.set('limit', params.limit);

    const { data } = await adminApi.get(`/admin/users/${userId}/tasks?${query.toString()}`);
    return data;
  }

  // ── Статистика ───────────────────────────────────────────────────────
  async function fetchStats() {
    const { data } = await adminApi.get('/admin/stats');
    stats.value = data.stats;
    return data.stats;
  }

  return {
    adminToken,
    adminUser,
    users,
    usersTotal,
    stats,
    loading,
    error,
    isAdminLoggedIn,
    restoreSession,
    adminLogin,
    adminLogout,
    fetchUsers,
    fetchUserDetail,
    fetchUserTasks,
    fetchStats,
  };
});
