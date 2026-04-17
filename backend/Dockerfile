FROM node:20-alpine

WORKDIR /app

# Зависимости устанавливаем отдельным слоем для кэширования
COPY package*.json ./
RUN npm install

COPY . .

# Создаём папку для загрузок
RUN mkdir -p /app/uploads

# Entrypoint: диагностика прокси при старте контейнера
RUN chmod +x /app/docker-entrypoint.sh
ENTRYPOINT ["/app/docker-entrypoint.sh"]

EXPOSE 3000

CMD ["node", "server.js"]
