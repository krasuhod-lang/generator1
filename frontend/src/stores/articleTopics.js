/**
 * Pinia-store для генератора тем статей (foresight forecaster).
 * Тонкая обёртка над /api/article-topics.
 */
import { defineStore } from 'pinia';
import api from '../api.js';

export const useArticleTopicsStore = defineStore('articleTopics', {
  state: () => ({
    tasks:   [],
    loading: false,
    error:   null,
  }),

  actions: {
    async fetchTasks() {
      this.loading = true;
      try {
        const { data } = await api.get('/article-topics');
        this.tasks = Array.isArray(data?.tasks) ? data.tasks : [];
        this.error = null;
      } catch (err) {
        this.error = err.response?.data?.error || err.message || 'Ошибка загрузки';
      } finally {
        this.loading = false;
      }
    },

    async createTask(payload) {
      const { data } = await api.post('/article-topics', payload);
      return data?.task?.id;
    },

    async createDeepDive(parent_task_id, trend_name, opts = {}) {
      // opts.force=true → пересоздать deep-dive поверх существующего
      // (backend по умолчанию возвращает 409 со списком дубликатов).
      const payload = { parent_task_id, trend_name };
      if (opts.force) payload.force = true;
      try {
        const { data } = await api.post('/article-topics/deep-dive', payload);
        return { id: data?.task?.id, duplicates: null };
      } catch (err) {
        const body = err.response?.data;
        if (err.response?.status === 409 && body?.error === 'duplicate_deep_dive') {
          // Возвращаем структуру с дубликатами — UI спросит пользователя,
          // и при подтверждении вызовет тот же метод с force=true.
          return { id: null, duplicates: body.duplicates || [], message: body.message || 'Дубликат' };
        }
        throw err;
      }
    },

    async getTask(id) {
      const { data } = await api.get(`/article-topics/${id}`);
      return data?.task || null;
    },

    async deleteTask(id) {
      await api.delete(`/article-topics/${id}`);
      this.tasks = this.tasks.filter((t) => t.id !== id);
    },
  },
});
