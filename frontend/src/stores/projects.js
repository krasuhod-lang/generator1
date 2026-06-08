/**
 * Pinia-store модуля «Проекты» (SEO-проекты + GSC + AI-аналитика).
 * Тонкая обёртка над /api/projects.
 */
import { defineStore } from 'pinia';
import api from '../api.js';

export const useProjectsStore = defineStore('projects', {
  state: () => ({
    projects: [],
    loading: false,
    error: null,
  }),

  actions: {
    async fetchProjects() {
      this.loading = true;
      try {
        const { data } = await api.get('/projects');
        this.projects = Array.isArray(data?.projects) ? data.projects : [];
        this.error = null;
      } catch (err) {
        this.error = err.response?.data?.error || err.message || 'Ошибка загрузки';
      } finally {
        this.loading = false;
      }
    },

    async createProject(payload) {
      const { data } = await api.post('/projects', payload);
      return data?.project || null;
    },

    async getProject(id) {
      const { data } = await api.get(`/projects/${id}`);
      return data || null;
    },

    async updateProject(id, payload) {
      const { data } = await api.put(`/projects/${id}`, payload);
      return data?.project || null;
    },

    async deleteProject(id) {
      await api.delete(`/projects/${id}`);
      this.projects = this.projects.filter((p) => p.id !== id);
    },

    // ── GSC ──────────────────────────────────────────────────────────
    async getGscAuthUrl(id) {
      const { data } = await api.get(`/projects/${id}/gsc/auth-url`);
      return data?.auth_url || null;
    },
    async getGscSites(id) {
      const { data } = await api.get(`/projects/${id}/gsc/sites`);
      return data || { sites: [] };
    },
    async selectGscSite(id, siteUrl) {
      const { data } = await api.post(`/projects/${id}/gsc/select-site`, { site_url: siteUrl });
      return data?.project || null;
    },
    async disconnectGsc(id) {
      await api.delete(`/projects/${id}/gsc`);
    },

    // ── Яндекс.Вебмастер (симметрично GSC) ───────────────────────────
    async getYdxAuthUrl(id) {
      const { data } = await api.get(`/projects/${id}/ydx/auth-url`);
      return data?.auth_url || null;
    },
    async getYdxSites(id) {
      const { data } = await api.get(`/projects/${id}/ydx/sites`);
      return data || { sites: [] };
    },
    async selectYdxSite(id, siteUrl) {
      const { data } = await api.post(`/projects/${id}/ydx/select-site`, { site_url: siteUrl });
      return data?.project || null;
    },
    async disconnectYdx(id) {
      await api.delete(`/projects/${id}/ydx`);
    },
    async getYdxPerformance(id, params) {
      const { data } = await api.get(`/projects/${id}/ydx/performance`, { params });
      return data || null;
    },

    // ── Сопоставление источников (GSC ↔ Яндекс) + рекомендации ───────
    async compareSources(id, params) {
      const { data } = await api.get(`/projects/${id}/compare`, { params });
      return data || null;
    },

    // ── Дашборд ──────────────────────────────────────────────────────
    async getPerformance(id, params) {
      const { data } = await api.get(`/projects/${id}/performance`, { params });
      return data || null;
    },

    // ── AI-аналитика ─────────────────────────────────────────────────
    async startAnalysis(id, payload) {
      const { data } = await api.post(`/projects/${id}/analyze`, payload || {});
      return data?.analysis || null;
    },
    async listAnalyses(id) {
      const { data } = await api.get(`/projects/${id}/analyses`);
      return Array.isArray(data?.analyses) ? data.analyses : [];
    },
    async getAnalysis(id, aid) {
      const { data } = await api.get(`/projects/${id}/analyses/${aid}`);
      return data?.analysis || null;
    },

    // ── Шаринг ───────────────────────────────────────────────────────
    async createShare(id) {
      const { data } = await api.post(`/projects/${id}/share`);
      return data?.token || null;
    },
    async revokeShare(id) {
      await api.delete(`/projects/${id}/share`);
    },

    // ── Ссылочный профиль / мета / AI-visibility ─────────────────────
    async importGscLinks(id, file) {
      const form = new FormData();
      form.append('file', file);
      const { data } = await api.post(`/projects/${id}/gsc-links/import`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      return data;
    },
    async regenerateMeta(id, url) {
      const { data } = await api.post(`/projects/${id}/meta-suggestions/regenerate`, { url });
      return data;
    },
    async probeAiVisibility(id, payload) {
      const { data } = await api.post(`/projects/${id}/ai-visibility/probe`, payload || {});
      return data;
    },
    async generateBlogArticle(id, payload) {
      const { data } = await api.post(`/projects/${id}/blog-article`, payload || {});
      return data;
    },
  },
});
