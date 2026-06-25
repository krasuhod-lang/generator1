import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      // Проксируем API-запросы на Express-бэкенд при разработке
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      // Статика бэкенда (загруженные скриншоты задач отчётов и т.п.).
      // Без проксирования картинки `/uploads/report-images/...` отдают 404
      // с Vite-сервера и в задачах «изображения не работают».
      '/uploads': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
