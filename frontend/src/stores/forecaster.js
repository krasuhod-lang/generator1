/**
 * Pinia-store для модуля «Прогнозатор».
 * Тонкая обёртка над /api/forecaster.
 */
import { defineStore } from 'pinia';
import api from '../api.js';

export const useForecasterStore = defineStore('forecaster', {
  state: () => ({
    tasks: [],
    loading: false,
    error: null,
  }),

  actions: {
    async fetchTasks() {
      this.loading = true;
      try {
        const { data } = await api.get('/forecaster');
        this.tasks = Array.isArray(data?.tasks) ? data.tasks : [];
        this.error = null;
      } catch (err) {
        this.error = err.response?.data?.error || err.message || 'Ошибка загрузки';
      } finally {
        this.loading = false;
      }
    },

    /** Создаёт задачу, возвращает id. */
    async createTask(payload) {
      const { data } = await api.post('/forecaster', payload);
      return data?.task?.id;
    },

    async deleteTask(id) {
      await api.delete(`/forecaster/${id}`);
      this.tasks = this.tasks.filter((t) => t.id !== id);
    },

    /** Перезапускает расчёт задачи (на случай ошибок или обновления данных). */
    async rerunTask(id) {
      const { data } = await api.post(`/forecaster/${id}/rerun`);
      return data?.task || null;
    },

    async getTask(id) {
      const { data } = await api.get(`/forecaster/${id}`);
      return data?.task || null;
    },

    async createShare(id) {
      const { data } = await api.post(`/forecaster/${id}/share`);
      return data?.token || null;
    },

    async revokeShare(id) {
      await api.delete(`/forecaster/${id}/share`);
    },
  },
});
