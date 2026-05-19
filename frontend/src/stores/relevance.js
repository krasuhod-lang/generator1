/**
 * Pinia store для вкладки «Релевантность».
 * Тонкая обёртка над /api/relevance — список + создание + удаление.
 * Деталь отчёта (с поллингом) — прямо в RelevanceResultPage.vue.
 */
import { defineStore } from 'pinia';
import api from '../api.js';

export const useRelevanceStore = defineStore('relevance', {
  state: () => ({
    reports: [],
    loading: false,
    error:   null,
  }),

  actions: {
    async fetchReports() {
      this.loading = true;
      try {
        const { data } = await api.get('/relevance');
        this.reports = Array.isArray(data?.reports) ? data.reports : [];
        this.error = null;
      } catch (err) {
        this.error = err.response?.data?.error || err.message || 'Ошибка загрузки';
      } finally {
        this.loading = false;
      }
    },

    /** Возвращает id созданного отчёта (для редиректа). */
    async createReport(payload) {
      const { data } = await api.post('/relevance', payload);
      return data?.report?.id;
    },

    async deleteReport(id) {
      await api.delete(`/relevance/${id}`);
      this.reports = this.reports.filter((r) => r.id !== id);
    },

    async getReport(id) {
      const { data } = await api.get(`/relevance/${id}`);
      return data?.report || null;
    },

    async getHealth() {
      const { data } = await api.get('/relevance/health');
      return data?.relevance || null;
    },

    /** PR 2: запустить расчёт «семантических коконов» поверх raw-кэша. */
    async buildCocoons(id, options = {}) {
      const { data } = await api.post(`/relevance/${id}/cocoons`, options);
      return data?.cocoons || null;
    },

    /**
     * Cocoon-plan (Bourrelly): Page Cible → Mères → Filles + правила
     * перелинковки. Не требует raw-кэша — читает vocabulary/ngrams/headings
     * прямо из готового report. Возвращает { plan, markdown, generated_at }.
     */
    async buildCocoonPlan(id, options = {}) {
      const { data } = await api.post(`/relevance/${id}/cocoon-plan`, options);
      return data?.cocoon_plan || null;
    },

    /** PR 2: досрочно удалить кэш сырых documents в Redis. */
    async deleteRaw(id) {
      const { data } = await api.delete(`/relevance/${id}/raw`);
      return data;
    },
  },
});
