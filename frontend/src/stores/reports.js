/**
 * Pinia-store модуля «Smart Reports» — публичные отчёты по проектам.
 * Тонкая обёртка над /api/reports.
 */
import { defineStore } from 'pinia';
import api from '../api.js';

export const useReportsStore = defineStore('reports', {
  state: () => ({
    drafts: [],
    shared: [],
    current: null,
    currentData: null,
    loading: false,
    saving: false,
    error: null,
  }),

  actions: {
    async fetchDrafts() {
      this.loading = true; this.error = null;
      try {
        const { data } = await api.get('/reports/drafts');
        this.drafts = Array.isArray(data?.drafts) ? data.drafts : [];
      } catch (err) {
        this.error = err.response?.data?.error || err.message || 'Ошибка загрузки';
      } finally {
        this.loading = false;
      }
    },

    async createDraft(payload) {
      this.saving = true;
      try {
        const { data } = await api.post('/reports/drafts', payload);
        return data?.draft;
      } finally {
        this.saving = false;
      }
    },

    async fetchDraft(id) {
      this.loading = true; this.error = null;
      try {
        const { data } = await api.get(`/reports/drafts/${id}`);
        this.current = data?.draft || null;
        return this.current;
      } catch (err) {
        this.error = err.response?.data?.error || err.message;
        throw err;
      } finally {
        this.loading = false;
      }
    },

    async updateDraft(id, patch) {
      this.saving = true;
      try {
        const { data } = await api.put(`/reports/drafts/${id}`, patch);
        this.current = data?.draft || this.current;
        return this.current;
      } finally {
        this.saving = false;
      }
    },

    async deleteDraft(id) {
      await api.delete(`/reports/drafts/${id}`);
      this.drafts = this.drafts.filter((d) => d.id !== id);
    },

    async fetchData(id, params = {}) {
      const { data } = await api.get(`/reports/drafts/${id}/data`, { params });
      this.currentData = data?.data || null;
      return this.currentData;
    },

    async listProjectTasks(id, includeHidden = false) {
      const { data } = await api.get(`/reports/drafts/${id}/tasks`, {
        params: { include_hidden: includeHidden ? 'true' : 'false' },
      });
      return data?.items || [];
    },

    async generateSummary(id) {
      const { data } = await api.post(`/reports/drafts/${id}/generate-summary`);
      return data;
    },

    async getSummaryStatus(id) {
      const { data } = await api.get(`/reports/drafts/${id}/generate-summary/status`);
      return data;
    },

    async updateTasksBlocks(id, blocks) {
      const { data } = await api.put(`/reports/drafts/${id}/tasks-blocks`, { blocks });
      return data;
    },

    async publishDraft(id, payload) {
      const { data } = await api.post(`/reports/drafts/${id}/publish`, payload);
      return data;
    },

    async fetchShared() {
      const { data } = await api.get('/reports/shared');
      this.shared = Array.isArray(data?.shared) ? data.shared : [];
    },

    async updateSharedSettings(uuid, payload) {
      await api.put(`/reports/shared/${uuid}/settings`, payload);
    },

    async revokeShared(uuid) {
      await api.post(`/reports/shared/${uuid}/revoke`);
    },

    async exportDocx(id, payload) {
      const { data } = await api.post(`/reports/drafts/${id}/export.docx`, payload || {}, {
        responseType: 'blob',
      });
      return data;
    },
  },
});
