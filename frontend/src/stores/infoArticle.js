/*
 * Pinia-store для генератора информационной статьи в блог.
 * Тонкая обёртка над /api/info-article (mirror of useLinkArticleStore).
 */
import { defineStore } from 'pinia';
import api from '../api.js';

const PAGE_SIZE = 200;
const MAX_HISTORY = 1000;

export const useInfoArticleStore = defineStore('infoArticle', {
  state: () => ({
    tasks:   [],
    loading: false,
    error:   null,
    total:   0,
    hasMore: false,
    listLimit: PAGE_SIZE,
  }),

  actions: {
    async fetchTasks({ append = false } = {}) {
      this.loading = true;
      try {
        const limit = append
          ? PAGE_SIZE
          : Math.min(MAX_HISTORY, Math.max(PAGE_SIZE, Number(this.listLimit) || PAGE_SIZE));
        const offset = append ? this.tasks.length : 0;
        const { data } = await api.get('/info-article', { params: { limit, offset } });
        const incoming = Array.isArray(data?.tasks) ? data.tasks : [];
        if (append) {
          const byId = new Map(this.tasks.map((task) => [String(task.id), task]));
          for (const task of incoming) byId.set(String(task.id), task);
          this.tasks = Array.from(byId.values()).sort((a, b) => {
            const ad = Date.parse(a.updated_at || a.created_at || '') || 0;
            const bd = Date.parse(b.updated_at || b.created_at || '') || 0;
            return bd - ad;
          });
          this.listLimit = Math.min(MAX_HISTORY, this.listLimit + PAGE_SIZE);
        } else {
          this.tasks = incoming;
          this.listLimit = Math.max(PAGE_SIZE, incoming.length);
        }
        this.total = Number(data?.meta?.total ?? this.tasks.length) || this.tasks.length;
        this.hasMore = Boolean(data?.meta?.hasMore);
        this.error = null;
      } catch (err) {
        this.error = err.response?.data?.error || err.message || 'Ошибка загрузки';
      } finally {
        this.loading = false;
      }
    },

    async loadMoreTasks() {
      if (!this.hasMore || this.loading) return;
      return this.fetchTasks({ append: true });
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
      this.tasks = this.tasks.filter((t) => String(t.id) !== String(id));
      this.total = Math.max(0, this.total - 1);
    },
  },
});
