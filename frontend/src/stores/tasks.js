import { defineStore } from 'pinia';
import api from '../api';

export const useTasksStore = defineStore('tasks', {
  state: () => ({
    tasks: [],
    currentTask: null,
    loading: false
  }),

  actions: {
    async fetchTasks() {
      this.loading = true;
      try {
        const { data } = await api.get('/tasks');
        this.tasks = data;
      } finally {
        this.loading = false;
      }
    },

    async fetchTask(id) {
      this.loading = true;
      try {
        const { data } = await api.get(`/tasks/${id}`);
        this.currentTask = data;
        return data;
      } finally {
        this.loading = false;
      }
    },

    async createTask(payload) {
      const { data } = await api.post('/tasks', payload);
      return data;
    },

    async startTask(id) {
      const { data } = await api.post(`/tasks/${id}/start`);
      return data;
    },

    async deleteTask(id) {
      await api.delete(`/tasks/${id}`);
      this.tasks = this.tasks.filter((t) => t.id !== id);
    },

    async parseTz(file) {
      const form = new FormData();
      form.append('file', file);
      const { data } = await api.post('/tasks/parse-tz', form, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      return data;
    }
  }
});
