/**
 * Pinia-store для модуля Outreach (email-рассылки).
 * Тонкая обёртка над /api/outreach.
 */
import { defineStore } from 'pinia';
import api from '../api.js';

export const useOutreachStore = defineStore('outreach', {
  state: () => ({
    campaigns: [],
    loading: false,
    error: null,
  }),

  actions: {
    async fetchCampaigns() {
      this.loading = true;
      try {
        const { data } = await api.get('/outreach/campaigns');
        this.campaigns = Array.isArray(data?.campaigns) ? data.campaigns : [];
        this.error = null;
      } catch (err) {
        this.error = err.response?.data?.error || err.message || 'Ошибка загрузки';
      } finally {
        this.loading = false;
      }
    },

    async createCampaign(payload) {
      const { data } = await api.post('/outreach/campaigns', payload);
      return data?.campaign || null;
    },

    async getCampaign(id) {
      const { data } = await api.get(`/outreach/campaigns/${id}`);
      return data?.campaign || null;
    },

    async updateCampaign(id, payload) {
      const { data } = await api.patch(`/outreach/campaigns/${id}`, payload);
      return data?.campaign || null;
    },

    async deleteCampaign(id) {
      await api.delete(`/outreach/campaigns/${id}`);
      this.campaigns = this.campaigns.filter((c) => c.id !== id);
    },

    async getCampaignStats(id) {
      const { data } = await api.get(`/outreach/campaigns/${id}/stats`);
      return data || null;
    },

    async getCampaignLogs(id) {
      const { data } = await api.get(`/outreach/campaigns/${id}/logs`);
      return Array.isArray(data?.logs) ? data.logs : [];
    },

    async getCampaignEmails(id, page = 1) {
      const { data } = await api.get(`/outreach/campaigns/${id}/emails`, { params: { page } });
      return data || { emails: [], total: 0, page };
    },

    async getCampaignProspects(id, page = 1) {
      const { data } = await api.get(`/outreach/campaigns/${id}/prospects`, { params: { page } });
      return data || { prospects: [], total: 0, page };
    },

    async directSend(id, recipients) {
      const { data } = await api.post(`/outreach/campaigns/${id}/direct-send`, { recipients });
      return data || { ok: false, queued: 0, skipped: 0 };
    },
  },
});
