/**
 * Pinia-store для bulk-генератора метатегов (Title + Description).
 * Тонкая обёртка над /api/meta-tags — список задач + создание + удаление.
 * Деталь одной задачи (с поллингом) живёт прямо в компоненте Result-страницы,
 * чтобы не тащить туда весь стор.
 */
import { defineStore } from 'pinia';
import api from '../api.js';

export const useMetaTagsStore = defineStore('metaTags', {
  state: () => ({
    tasks:   [],
    loading: false,
    error:   null,
  }),

  actions: {
    async fetchTasks() {
      this.loading = true;
      try {
        const { data } = await api.get('/meta-tags');
        this.tasks = Array.isArray(data?.tasks) ? data.tasks : [];
        this.error = null;
      } catch (err) {
        this.error = err.response?.data?.error || err.message || 'Ошибка загрузки';
      } finally {
        this.loading = false;
      }
    },

    /**
     * Создаёт задачу. Возвращает id созданной задачи (для редиректа).
     * Бросает Error с .message для отображения в форме.
     */
    async createTask(payload) {
      const { data } = await api.post('/meta-tags', payload);
      return data?.task?.id;
    },

    async deleteTask(id) {
      await api.delete(`/meta-tags/${id}`);
      this.tasks = this.tasks.filter((t) => t.id !== id);
    },

    async getTask(id) {
      const { data } = await api.get(`/meta-tags/${id}`);
      return data?.task || null;
    },
  },
});
