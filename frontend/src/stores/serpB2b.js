/**
 * Pinia-store для SERP B2B Crawler & Contact Extractor.
 * Тонкая обёртка над /api/serp-b2b.
 */
import { defineStore } from 'pinia';
import api from '../api.js';

export const useSerpB2bStore = defineStore('serpB2b', {
  state: () => ({
    tasks: [],
    loading: false,
    error: null,
  }),

  actions: {
    async fetchTasks() {
      this.loading = true;
      try {
        const { data } = await api.get('/serp-b2b');
        this.tasks = Array.isArray(data?.tasks) ? data.tasks : [];
        this.error = null;
      } catch (err) {
        this.error = err.response?.data?.error || err.message || 'Ошибка загрузки';
      } finally {
        this.loading = false;
      }
    },

    async createTask(payload) {
      const { data } = await api.post('/serp-b2b', payload);
      return data?.task || null;
    },

    async getTask(id) {
      const { data } = await api.get(`/serp-b2b/${id}`);
      return data?.task || null;
    },

    async deleteTask(id) {
      await api.delete(`/serp-b2b/${id}`);
      this.tasks = this.tasks.filter((t) => t.id !== id);
    },

    /** Возвращает абсолютный URL XLSX-выгрузки (с токеном через query-helper). */
    xlsxUrl(id) {
      return `/api/serp-b2b/${id}/export.xlsx`;
    },
  },
});
