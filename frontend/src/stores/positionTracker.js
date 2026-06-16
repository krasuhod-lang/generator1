/**
 * Pinia-store для модуля «Съём позиций» (Position Tracker).
 * Тонкая обёртка над /api/position-tracker.
 */
import { defineStore } from 'pinia';
import api from '../api.js';

const BASE = '/position-tracker';

export const usePositionTrackerStore = defineStore('positionTracker', {
  state: () => ({
    projects: [],
    loading: false,
    error: null,
  }),

  actions: {
    async fetchProjects() {
      this.loading = true;
      try {
        const { data } = await api.get(`${BASE}/projects`);
        this.projects = Array.isArray(data?.projects) ? data.projects : [];
        this.error = null;
      } catch (err) {
        this.error = err.response?.data?.error || err.message || 'Ошибка загрузки';
      } finally {
        this.loading = false;
      }
    },

    async createProject(payload) {
      const { data } = await api.post(`${BASE}/projects`, payload);
      if (data?.project) this.projects.unshift(data.project);
      return data?.project || null;
    },

    async getProject(id) {
      const { data } = await api.get(`${BASE}/projects/${id}`);
      return data || null;
    },

    async updateProject(id, patch) {
      const { data } = await api.patch(`${BASE}/projects/${id}`, patch);
      return data?.project || null;
    },

    async deleteProject(id) {
      await api.delete(`${BASE}/projects/${id}`);
      this.projects = this.projects.filter((p) => p.id !== id);
    },

    async addKeywords(projectId, queries, opts = {}) {
      const { data } = await api.post(`${BASE}/projects/${projectId}/keywords`, {
        queries, target_url: opts.target_url, tags: opts.tags,
      });
      return Array.isArray(data?.keywords) ? data.keywords : [];
    },

    async deleteKeyword(projectId, kwId) {
      await api.delete(`${BASE}/projects/${projectId}/keywords/${kwId}`);
    },

    async startRun(projectId, engine = null) {
      const { data } = await api.post(`${BASE}/projects/${projectId}/runs`,
        engine ? { engine } : {});
      return data;
    },

    async getRuns(projectId) {
      const { data } = await api.get(`${BASE}/projects/${projectId}/runs`);
      return Array.isArray(data?.runs) ? data.runs : [];
    },

    async getSummary(projectId, period = 'week', engine = null) {
      const params = { period };
      if (engine) params.engine = engine;
      const { data } = await api.get(`${BASE}/projects/${projectId}/summary`, { params });
      return data?.summary || null;
    },

    async getProjectSeries(projectId, granularity = 'day', engine = null) {
      const params = { granularity };
      if (engine) params.engine = engine;
      const { data } = await api.get(`${BASE}/projects/${projectId}/series`, { params });
      return Array.isArray(data?.series) ? data.series : [];
    },

    async getKeywordSeries(projectId, kwId, granularity = 'day', engine = null) {
      const params = { granularity };
      if (engine) params.engine = engine;
      const { data } = await api.get(`${BASE}/projects/${projectId}/keywords/${kwId}/series`, { params });
      return data;
    },

    async getKeywordsTable(projectId, period = 'week', engine = null) {
      const params = { period };
      if (engine) params.engine = engine;
      const { data } = await api.get(`${BASE}/projects/${projectId}/keywords-table`, { params });
      return Array.isArray(data?.keywords) ? data.keywords : [];
    },

    async getMovers(projectId, direction = 'down', period = 'week', engine = null) {
      const params = { direction, period };
      if (engine) params.engine = engine;
      const { data } = await api.get(`${BASE}/projects/${projectId}/movers`, { params });
      return Array.isArray(data?.movers) ? data.movers : [];
    },
  },
});
