/**
 * Pinia-store для генератора информационной статьи в блог.
 * Тонкая обёртка над /api/info-article (mirror of useLinkArticleStore).
 */
import { defineStore } from 'pinia';
import api from '../api.js';

export const useInfoArticleStore = defineStore('infoArticle', {
  state: () => ({
    tasks:   [],
    loading: false,
    error:   null,
  }),

  actions: {
    async fetchTasks() {
      this.loading = true;
      try {
        const { data } = await api.get('/info-article');
        this.tasks = Array.isArray(data?.tasks) ? data.tasks : [];
        this.error = null;
      } catch (err) {
        this.error = err.response?.data?.error || err.message || 'Ошибка загрузки';
      } finally {
        this.loading = false;
      }
    },

    async createTask(payload) {
      const { data } = await api.post('/info-article', payload);
      return { id: data?.task?.id, normalized: data?.normalized || null };
    },

    async getTask(id) {
      const { data } = await api.get(`/info-article/${id}`);
      return data?.task || null;
    },

    async deleteTask(id) {
      await api.delete(`/info-article/${id}`);
      this.tasks = this.tasks.filter((t) => t.id !== id);
    },
  },
});
