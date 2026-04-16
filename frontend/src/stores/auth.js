import { defineStore } from 'pinia';
import api from '../api';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null,
    token: null
  }),

  actions: {
    async login(email, password) {
      const { data } = await api.post('/auth/login', { email, password });
      this.token = data.token;
      this.user = data.user;
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
    },

    async register(email, password, name) {
      const { data } = await api.post('/auth/register', { email, password, name });
      this.token = data.token;
      this.user = data.user;
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
    },

    logout() {
      this.token = null;
      this.user = null;
      localStorage.removeItem('token');
      localStorage.removeItem('user');
    },

    restoreSession() {
      const token = localStorage.getItem('token');
      const user = localStorage.getItem('user');
      if (token) {
        this.token = token;
        try {
          this.user = user ? JSON.parse(user) : null;
        } catch {
          this.user = null;
        }
      }
    }
  }
});
