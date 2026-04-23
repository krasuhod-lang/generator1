/**
 * Pinia-store для генератора ссылочной статьи.
 * Тонкая обёртка над /api/link-article.
 */
import { defineStore } from 'pinia';
import api from '../api.js';

export const useLinkArticleStore = defineStore('linkArticle', {
  state: () => ({
    tasks:   [],
    loading: false,
    error:   null,
  }),

  actions: {
    async fetchTasks() {
      this.loading = true;
      try {
        const { data } = await api.get('/link-article');
        this.tasks = Array.isArray(data?.tasks) ? data.tasks : [];
        this.error = null;
      } catch (err) {
        this.error = err.response?.data?.error || err.message || 'Ошибка загрузки';
      } finally {
        this.loading = false;
      }
    },

    async createTask(payload) {
      const { data } = await api.post('/link-article', payload);
      return data?.task?.id;
    },

    async getTask(id) {
      const { data } = await api.get(`/link-article/${id}`);
      return data?.task || null;
    },

    async deleteTask(id) {
      await api.delete(`/link-article/${id}`);
      this.tasks = this.tasks.filter((t) => t.id !== id);
    },
  },
});
