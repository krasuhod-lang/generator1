/**
 * Axios instance — единственная точка входа для всех HTTP-запросов.
 *
 * Request interceptor: подставляет Bearer-токен из localStorage при каждом
 * запросе. Это страхует случай, когда запрос уходит до вызова restoreSession()
 * (например, при быстрой навигации или HMR-перезагрузке).
 *
 * Response interceptor: при получении 401 очищает токен и редиректит на /login
 * через Vue Router (импорт отложенный — избегаем circular dependency).
 */
import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 60_000,
  headers: { 'Content-Type': 'application/json' },
});

// ── Request interceptor ────────────────────────────────────────────────────
// Подставляем свежий токен из localStorage перед КАЖДЫМ запросом.
// Это важно: даже если Pinia-стор ещё не восстановлен, заголовок будет верным.
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('seo_token');
  if (token) {
    config.headers['Authorization'] = `Bearer ${token}`;
  }
  return config;
});

// ── Response interceptor ───────────────────────────────────────────────────
// При 401: чистим хранилище и идём на /login через router (без перезагрузки).
// При 429: retry с экспоненциальным backoff.
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error.config;

    // ── 429 Too Many Requests — автоматический retry ──
    if (error.response?.status === 429 && config && !config.__retryCount) {
      config.__retryCount = 0;
    }
    if (error.response?.status === 429 && config && config.__retryCount < 3) {
      config.__retryCount += 1;
      const retryAfter = Number(error.response.headers['retry-after']) || 0;
      const delay = retryAfter > 0
        ? Math.min(retryAfter * 1000, 60000)
        : Math.min(1000 * Math.pow(2, config.__retryCount), 10000);
      await new Promise((r) => setTimeout(r, delay));
      return api(config);
    }

    if (error.response?.status === 401) {
      // Удаляем протухший токен
      localStorage.removeItem('seo_token');
      delete api.defaults.headers.common['Authorization'];

      // Сбрасываем Pinia-стор без circular dependency:
      // импортируем стор лениво прямо здесь
      try {
        const { useAuthStore } = await import('./stores/auth.js');
        const auth = useAuthStore();
        auth.$patch({ token: null, user: null });
      } catch (_) {
        // Стор мог быть недоступен до инициализации Pinia — игнорируем
      }

      // Редирект через Vue Router (не reload страницы)
      if (!window.location.pathname.includes('/login')) {
        try {
          const { default: router } = await import('./router/index.js');
          router.replace('/login');
        } catch (_) {
          window.location.href = '/login';
        }
      }
    }
    return Promise.reject(error);
  }
);

export default api;
