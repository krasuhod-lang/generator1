/**
 * Pinia-store для инструмента «Lead-text + Фасетный SEO-оптимизатор».
 * Тонкая обёртка над /api/category-lead.
 */
import { defineStore } from 'pinia';
import api from '../api.js';

export const useCategoryLeadStore = defineStore('categoryLead', {
  state: () => ({
    tasks: [],
    loading: false,
    error: null,
  }),

  actions: {
    async fetchTasks() {
      this.loading = true;
      try {
        const { data } = await api.get('/category-lead');
        this.tasks = Array.isArray(data?.tasks) ? data.tasks : [];
        this.error = null;
      } catch (err) {
        this.error = err.response?.data?.error || err.message || 'Ошибка загрузки';
      } finally {
        this.loading = false;
      }
    },

    async createTask(payload) {
      const { data } = await api.post('/category-lead', payload);
      return data?.task?.id;
    },

    async deleteTask(id) {
      await api.delete(`/category-lead/${id}`);
      this.tasks = this.tasks.filter((t) => t.id !== id);
    },

    async getTask(id) {
      const { data } = await api.get(`/category-lead/${id}`);
      return data?.task || null;
    },

    /** Отправляет виртуальные ключи High-фасетов в инструмент мета-тегов. */
    async sendKeysToMetaTags({ name, category, keywords }) {
      const { data } = await api.post('/meta-tags', {
        name: name || `Фасеты: ${category}`,
        niche: category || '',
        keywords,
      });
      return data?.task?.id || null;
    },
  },
});
