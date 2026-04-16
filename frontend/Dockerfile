# ── Stage 1: Сборка Vue 3 SPA через Vite ───────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Копируем манифест зависимостей
COPY package*.json ./

# Устанавливаем зависимости
RUN npm install

# Копируем исходники
COPY . .

# Принимаем build-arg для VITE_API_BASE_URL
ARG VITE_API_BASE_URL=http://localhost:3000
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

# Собираем production-сборку
RUN npm run build

# ── Stage 2: Раздаём собранный SPA через Nginx ──────────────────
FROM nginx:1.27-alpine

# Удаляем дефолтный конфиг
RUN rm /etc/nginx/conf.d/default.conf

# Добавляем конфиг для SPA (history mode + proxy API)
COPY docker-nginx.conf /etc/nginx/conf.d/default.conf

# Копируем собранный фронтенд из Stage 1
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
