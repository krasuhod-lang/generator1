# SEO Genius v4.0 — Документация и Руководство по деплою

> Полный стек: Node.js 20 + Express + BullMQ + PostgreSQL + Redis + Vue 3 + Vite + Tailwind CSS  
> Запуск: Docker Compose (один файл `docker-compose.yml` поднимает всё)

> 📘 **Обновляете уже работающий инстанс?** См. [`UPDATE_GUIDE.md`](./UPDATE_GUIDE.md)
> — универсальная инструкция: безопасное обновление `.env` (только дополнение,
> без потери данных) и пошаговый накат изменений в программу.

---

## Содержание

1. [Архитектура](#архитектура)
2. [Быстрый старт (локально)](#быстрый-старт)
3. [Деплой на Beget VPS (Ubuntu + Docker)](#деплой-на-beget-vps)
4. [Файл .env — полное описание](#файл-env)
5. [Прокси для Gemini API](#прокси-для-gemini-api)
6. [Структура проекта](#структура-проекта)
7. [Пайплайн Stage 0–7](#пайплайн-stage-07)
8. [Аудит: результаты Self-Check](#аудит-результаты-self-check)
9. [FAQ](#faq)

---

## Архитектура

```
┌─────────────────────────────────────────────────────────────────┐
│  Браузер пользователя                                            │
│  Vue 3 SPA (Vite, Tailwind, Pinia, Vue Router)                   │
│  Порт 8080 (Nginx в Docker)                                      │
└──────────────────────────┬──────────────────────────────────────┘
                           │  HTTP / SSE (EventSource)
┌──────────────────────────▼──────────────────────────────────────┐
│  Backend — Express.js                                            │
│  Порт 3000 (внутри Docker, снаружи 3000 или за Nginx)           │
│  • /api/auth/*       — регистрация / логин (JWT)                 │
│  • /api/tasks/*      — CRUD задач                                │
│  • /api/tasks/:id/sse — SSE-поток (realtime логи, прогресс)      │
└──────────┬───────────────────────────────────────────────────────┘
           │  BullMQ jobs
┌──────────▼───────────┐     ┌─────────────────┐
│  Worker (BullMQ)     │────▶│  Redis 7         │
│  concurrency: 3      │     │  Порт 6379       │
│  Stage 0 → Stage 7   │     └─────────────────┘
└──────────┬───────────┘
           │  pg (node-postgres)
┌──────────▼───────────┐
│  PostgreSQL 16        │
│  Порт 5432           │
│  tasks, task_content_blocks, task_metrics, users │
└──────────────────────┘
```

---

## Быстрый старт

### Предварительные требования
- Docker Desktop ≥ 24 (или Docker Engine + Compose plugin)
- API-ключи DeepSeek и Gemini

```bash
# 1. Клонируем / распаковываем проект
unzip seo-genius-v4.zip
cd seo-genius-v4

# 2. Создаём .env из шаблона
cp .env.example .env
# Открываем .env и вставляем API-ключи (см. раздел "Файл .env")
nano .env

# 3. Запускаем
docker-compose up -d --build

# Ждём ~60 сек пока применяются миграции и поднимаются сервисы
docker-compose logs -f backend   # следим за логами

# 4. Открываем
# Frontend: http://localhost:8080
# Backend API: http://localhost:3000
```

---

## Деплой на Beget VPS

### Шаг 1 — Покупка и настройка сервера

1. Зайдите на [beget.com](https://beget.com), раздел **VPS** → **Заказать**
2. Выберите конфигурацию: минимум **2 vCPU / 4 GB RAM / 40 GB SSD** (тариф «Стандарт» или выше)
3. ОС: **Ubuntu 24.04 LTS**
4. В разделе **Сеть** включите публичный IPv4
5. После покупки получите письмо с IP-адресом и root-паролем

### Шаг 2 — Подключение к серверу

```bash
ssh root@ВАШ_IP
```

### Шаг 3 — Обновление системы и установка Docker

```bash
# Обновляем пакеты
apt-get update && apt-get upgrade -y

# Устанавливаем зависимости
apt-get install -y ca-certificates curl gnupg lsb-release

# Добавляем репозиторий Docker
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
  | tee /etc/apt/sources.list.d/docker.list > /dev/null

# Устанавливаем Docker Engine + Compose Plugin
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Проверка
docker --version          # Docker version 26.x.x
docker compose version    # Docker Compose version v2.x.x
```

### Шаг 4 — Загрузка архива на сервер

**Вариант A — через scp (с вашей локальной машины):**
```bash
scp seo-genius-v4.zip root@ВАШ_IP:/opt/
```

**Вариант B — через wget (если архив доступен по URL):**
```bash
cd /opt
wget -O seo-genius-v4.zip "https://ВАШ_URL/seo-genius-v4.zip"
```

### Шаг 5 — Распаковка и настройка

```bash
# На сервере
cd /opt
apt-get install -y unzip
unzip seo-genius-v4.zip
cd seo-genius-v4

# Создаём .env из шаблона
cp .env.example .env
nano .env
# Вставляем ключи (см. раздел "Файл .env")
```

### Шаг 6 — Запуск через Docker Compose

```bash
cd /opt/seo-genius-v4

# Строим образы и запускаем в фоне
docker compose up -d --build

# Следим за запуском (Ctrl+C для выхода из логов, контейнеры остаются)
docker compose logs -f

# Проверяем статус
docker compose ps
```

Ожидаемый вывод `docker compose ps`:
```
NAME                 STATUS          PORTS
seo_postgres         Up              0.0.0.0:5432->5432/tcp
seo_redis            Up              0.0.0.0:6379->6379/tcp
seo_backend          Up              0.0.0.0:3000->3000/tcp
seo_worker           Up
seo_frontend         Up              0.0.0.0:8080->80/tcp
```

### Шаг 7 — Настройка Nginx (опционально, для домена + HTTPS)

Если хотите работать через домен с SSL:

```bash
# Устанавливаем Nginx + Certbot
apt-get install -y nginx certbot python3-certbot-nginx

# Создаём конфиг
cat > /etc/nginx/sites-available/seo-genius << 'EOF'
server {
    listen 80;
    server_name ВАШ_ДОМЕН.ru;

    # Frontend (Vue SPA)
    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # Backend API
    location /api/ {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # SSE — важно: отключить буферизацию!
    location /api/tasks/sse {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        chunked_transfer_encoding on;
    }
}
EOF

ln -s /etc/nginx/sites-available/seo-genius /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# Получаем SSL-сертификат
certbot --nginx -d ВАШ_ДОМЕН.ru
```

### Шаг 8 — Автозапуск после перезагрузки сервера

```bash
# Docker daemon уже настроен на автозапуск
systemctl enable docker

# Настраиваем автозапуск Compose-стека
cat > /etc/systemd/system/seo-genius.service << 'EOF'
[Unit]
Description=SEO Genius v4.0 Docker Compose
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/seo-genius-v4
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
EOF

systemctl enable seo-genius
systemctl start seo-genius
```

### Шаг 9 — Полезные команды управления

```bash
# Остановить
docker compose down

# Перезапустить только бэкенд (после изменений в коде)
docker compose build backend && docker compose up -d backend

# Просмотр логов воркера
docker compose logs -f worker

# Зайти в контейнер PostgreSQL
docker compose exec postgres psql -U seogenius seogenius_db

# Резервная копия БД
docker compose exec postgres pg_dump -U seogenius seogenius_db > backup_$(date +%Y%m%d).sql

# Восстановить из резервной копии
cat backup_20240101.sql | docker compose exec -T postgres psql -U seogenius seogenius_db
```

---

## Файл .env

Создайте файл `.env` в корне проекта (рядом с `docker-compose.yml`) по образцу ниже.

### Полный шаблон `.env.example`

```dotenv
# ═══════════════════════════════════════════════════════════════
# SEO Genius v4.0 — Конфигурация окружения
# ═══════════════════════════════════════════════════════════════

# ── PostgreSQL ─────────────────────────────────────────────────
POSTGRES_DB=seogenius_db
POSTGRES_USER=seogenius
POSTGRES_PASSWORD=ПРИДУМАЙТЕ_СЛОЖНЫЙ_ПАРОЛЬ_БД

# ── Redis ──────────────────────────────────────────────────────
REDIS_URL=redis://redis:6379

# ── JWT ────────────────────────────────────────────────────────
# Сгенерируйте случайную строку: openssl rand -hex 32
JWT_SECRET=СГЕНЕРИРУЙТЕ_СЕКРЕТНЫЙ_КЛЮЧ_JWT_МИНИМУМ_32_СИМВОЛА

# ── DeepSeek API ───────────────────────────────────────────────
# Ключ DeepSeek зашифрован в коде (src/services/llm/deepseek.adapter.js)
# Для изменения ключа обратитесь к разработчику
DEEPSEEK_BASE_URL=https://api.deepseek.com

# ── Gemini API ─────────────────────────────────────────────────
# Ключ Gemini зашифрован в коде (src/services/llm/gemini.adapter.js)
# Для изменения ключа обратитесь к разработчику

# ОПЦИОНАЛЬНО: замена базового URL Gemini (для собственного прокси-сервера)
# Формат: https://ваш-прокси.ru/v1beta/models
# Оставьте пустым если используете прямой доступ к Google
GEMINI_BASE_URL=

# ОПЦИОНАЛЬНО: HTTP/HTTPS прокси для исходящих запросов к Gemini
# Формат: http://логин:пароль@ip-адрес:порт
# Пример: http://user123:pass456@185.10.20.30:8080
# Оставьте пустым если прокси не нужен
HTTPS_PROXY=

# ── Приложение ─────────────────────────────────────────────────
PORT=3000
NODE_ENV=production

# ── BullMQ Worker ──────────────────────────────────────────────
# Количество параллельных задач (рекомендуется 2-4)
WORKER_CONCURRENCY=3

# ── Frontend (для Vite сборки) ─────────────────────────────────
VITE_API_BASE_URL=http://localhost:3000
```

### Где взять API-ключи

| Ключ | Где получить | Формат |
|------|-------------|--------|
| `DEEPSEEK_API_KEY` | *Зашифрован в коде* | - |
| `GEMINI_API_KEY` | *Зашифрован в коде* | - |
| `JWT_SECRET` | Команда: `openssl rand -hex 32` | любая строка ≥32 символа |
| `POSTGRES_PASSWORD` | Придумайте сами | любая строка без спец.символов |

### Как вставить ключи

```bash
# На сервере
cd /opt/seo-genius-v4
nano .env

# Найдите строки:
# DEEPSEEK_API_KEY зашифрован в коде
# GEMINI_API_KEY зашифрован в коде
JWT_SECRET=
POSTGRES_PASSWORD=

# Вставьте значения ПОСЛЕ знака =, без пробелов и кавычек:
# DEEPSEEK_API_KEY уже настроен
# GEMINI_API_KEY уже настроен
JWT_SECRET=a1b2c3d4e5f6...
POSTGRES_PASSWORD=MySecurePassw0rd

# Сохранить: Ctrl+O, Enter, Ctrl+X
```

---

## Прокси для Gemini API

Если сервер находится в России или регионе с ограниченным доступом к `generativelanguage.googleapis.com`, используйте одну из двух стратегий.

### Стратегия 1: HTTPS_PROXY (ротационный прокси)

Укажите HTTPS-прокси в файле `.env`. Формат `http://логин:пароль@ip:порт`:

```dotenv
# .env
HTTPS_PROXY=http://user123:pass456@185.10.20.30:8080
```

**Как работает:** Все исходящие запросы `axios` к Gemini API будут туннелироваться через указанный прокси-сервер с помощью библиотеки `https-proxy-agent`. Прямые запросы к DeepSeek API **не затрагиваются** — прокси применяется только в `gemini.adapter.js`.

**Где купить прокси:**
- [proxy6.net](https://proxy6.net) — HTTPS-прокси от $0.5/шт
- [proxys.io](https://proxys.io) — ротационные прокси
- [webshare.io](https://webshare.io) — есть бесплатный план

### Стратегия 2: GEMINI_BASE_URL (собственный прокси-сервер)

Если у вас есть собственный сервер за пределами России (например, VPS в Германии или Финляндии), можно поднять простой HTTP-прокси для Gemini API и указать его адрес:

```dotenv
# .env
GEMINI_BASE_URL=https://gemini-proxy.ваш-домен.ru/v1beta/models
```

В этом случае все запросы `gemini.adapter.js` пойдут на ваш прокси-сервер, который перенаправит их в Google. `gemini.adapter.js` автоматически подставит модель и API-ключ.

**Пример простейшего Nginx-прокси на удалённом сервере:**

```nginx
# /etc/nginx/sites-available/gemini-proxy
server {
    listen 443 ssl;
    server_name gemini-proxy.ваш-домен.ru;

    # SSL настройки (certbot)
    ssl_certificate     /etc/letsencrypt/live/gemini-proxy.ваш-домен.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gemini-proxy.ваш-домен.ru/privkey.pem;

    location /v1beta/models {
        proxy_pass https://generativelanguage.googleapis.com/v1beta/models;
        proxy_ssl_server_name on;
        proxy_set_header Host generativelanguage.googleapis.com;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Проверка что прокси работает

```bash
# Смотрим логи бэкенда после первого запуска задачи
docker compose logs backend | grep -i gemini

# Если прокси работает, вы увидите:
# [gemini] Запрос через HTTPS_PROXY: http://user:pass@ip:port
# или просто успешные ответы без ошибок 403/503
```

---

## Структура проекта

```
seo-genius-v4/
├── docker-compose.yml              # Оркестрация всех сервисов
├── .env.example                    # Шаблон переменных окружения
├── .env                            # Ваши ключи (НЕ коммитить в git!)
├── README.md                       # Эта документация
│
├── migrations/
│   └── 001_initial_schema.sql      # SQL-схема БД (создаётся автоматически)
│
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   ├── server.js                   # Express + JWT + роуты
│   └── src/
│       ├── config/
│       │   └── db.js               # Подключение к PostgreSQL (pg pool)
│       ├── middleware/
│       │   └── auth.js             # JWT-проверка + authSSE (query param)
│       ├── routes/
│       │   ├── auth.routes.js      # POST /api/auth/register, /login
│       │   └── tasks.routes.js     # CRUD задач + SSE endpoint
│       ├── controllers/
│       │   ├── auth.controller.js
│       │   └── tasks.controller.js
│       ├── prompts/
│       │   └── systemPrompts.js    # 7577 строк — все промпты Stage 1–7 + EXT
│       ├── queue/
│       │   ├── queue.js            # BullMQ Queue (Redis connection)
│       │   └── worker.js           # BullMQ Worker (concurrency: 3)
│       ├── services/
│       │   ├── llm/
│       │   │   ├── callLLM.js          # Роутер deepseek/gemini + retry
│       │   │   ├── deepseek.adapter.js # DeepSeek Chat API
│       │   │   └── gemini.adapter.js   # Gemini API + PROXY поддержка
│       │   ├── metrics/
│       │   │   ├── bm25.js             # BM25 скоринг (защита от пустого LSI)
│       │   │   └── priceCalculator.js  # Стоимость токенов (toFixed(4))
│       │   ├── parser/
│       │   │   └── scraper.js          # Парсер конкурентов (timeout 20s)
│       │   ├── pipeline/
│       │   │   ├── orchestrator.js     # runPipeline (Stage 0→7)
│       │   │   ├── stage0.js           # Анализ конкурентов + SERP Reality
│       │   │   ├── stage1.js           # Entity/Intent/Community (Promise.all)
│       │   │   ├── stage2.js           # Buyer Journey + Taxonomy
│       │   │   ├── stage3.js           # Генерация блоков контента
│       │   │   ├── stage4.js           # E-E-A-T аудит блока
│       │   │   ├── stage5.js           # PQ-рефайн (если PQ < 8)
│       │   │   ├── stage6.js           # LSI-инъекция
│       │   │   └── stage7.js           # Глобальный аудит + BM25 + метрики
│       │   └── sse/
│       │       └── sseManager.js       # SSE publish/subscribe
│       └── utils/
│           ├── autoCloseJSON.js        # Авторемонт битого JSON от LLM
│           ├── calculateCoverage.js    # LSI coverage %
│           ├── factCheck.js            # Проверка фактов
│           └── russianStem.js          # Стемминг для BM25
│
└── frontend/
    ├── Dockerfile (multi-stage: node build → nginx serve)
    ├── package.json
    ├── vite.config.js
    ├── tailwind.config.js
    ├── index.html
    └── src/
        ├── main.js
        ├── App.vue
        ├── style.css              # Tailwind directives + btn/card утилиты
        ├── api.js                 # Axios instance (JWT interceptor + 401 handler)
        ├── router/
        │   └── index.js           # 8 роутов с auth guards
        ├── stores/
        │   ├── auth.js            # Pinia: login/logout/restoreSession
        │   └── tasks.js           # Pinia: fetchTasks/startTask/deleteTask
        └── views/
            ├── LoginPage.vue
            ├── RegisterPage.vue
            ├── DashboardPage.vue  # Таблица задач + бейджи + inline error
            ├── CreateTaskPage.vue # Форма создания задачи
            ├── MonitorPage.vue    # SSE realtime + автоскролл + reconnect
            └── ResultPage.vue     # Метрики + iframe preview + copy HTML
```

---

## Пайплайн Stage 0–7

### Data Flow (поток данных)

```
tasks.input_* (user input)
    │
    ▼
Stage 0: scrapeCompetitors → callLLM×2 → tasks.stage0_result (JSONB)
    │
    ▼
Stage 1: Promise.all(Entity, Intent, Community) → tasks.stage1_result (JSONB)
    │
    ▼
Stage 2: BuyerJourney + Taxonomy → tasks.stage2_result (JSONB)
         └─ taxonomy → SSE {type:"taxonomy"} → MonitorPage
    │
    ▼
Stage 3: generateBlocks (Gemini) → массив { block, html }
    │
    ▼
Stage 4→5→6 (цикл по каждому блоку):
    │  Stage 4: E-E-A-T аудит → auditResult, pqScore, lsiCovPct
    │  Stage 5: PQ-рефайн     (только если pq < 8 или lsi < 80%)
    │  Stage 6: LSI-инъекция  (всегда)
    │  └─ saveContentBlock → task_content_blocks (block_index, html_content, ...)
    │  └─ SSE {type:"block_done"} → MonitorPage
    │
    ▼
Stage 7: globalAudit (Gemini) + BM25 scoring
    │  └─ tasks UPDATE: stage7_result, full_html
    │  └─ task_metrics INSERT: lsi_coverage, eeat_score, bm25_score, tokens, cost
    │
    ▼
worker.js: tasks.status = 'completed'
SSE {type:"pipeline_done"} → MonitorPage → автоматический redirect на ResultPage
```

### Сохранение результатов каждого Stage в БД

| Stage | Таблица | Поле |
|-------|---------|------|
| 0 | `tasks` | `stage0_result` (JSONB) |
| 1 | `tasks` | `stage1_result` (JSONB) |
| 2 | `tasks` | `stage2_result` (JSONB) |
| 3-6 | `task_content_blocks` | `html_content`, `lsi_coverage`, `pq_score`, `audit_log_json` |
| 7 | `tasks` | `stage7_result` (JSONB), `full_html` (TEXT) |
| 7 | `task_metrics` | все числовые метрики |

---

## Аудит: результаты Self-Check

### ✅ Data Flow

- Каждый Stage сохраняет результат в `tasks.stage{N}_result` через `db.query(UPDATE...)`
- Данные передаются по цепочке как аргументы функций (не читаются повторно из БД)
- `competitorFacts` из Stage 0 передаётся в Stage 5 для factCheck
- `taxonomy` из Stage 2 передаётся в Stage 3 для генерации блоков
- `allLSI` аккумулируется из всех блоков и передаётся в Stage 7

### ✅ Многопоточность

- `worker.js`: `concurrency: parseInt(process.env.WORKER_CONCURRENCY) || 3` — настраивается через `.env`
- `stage1.js`: три агента запускаются строго через `Promise.all([1A, 1B, 1C])`
- Каждый агент имеет индивидуальный `.catch()` — сбой одного не роняет остальных
- Блоки Stage 3–6 обрабатываются последовательно (зависимость Stage 4 от Stage 3)

### ✅ Промпты

- `systemPrompts.js`: 7577 строк, содержит `SYSTEM_PROMPTS` (stage1–stage7) и `SYSTEM_PROMPTS_EXT` (serpRealityCheck, nicheLandscape, entityLandscape, commercialIntent, communityVoice, eeatTrustScanner)
- Все промпты перенесены из `index.html` без изменений

### ✅ Прокси для Gemini

- `gemini.adapter.js`: читает `HTTPS_PROXY` → создаёт `HttpsProxyAgent` → передаёт в axios как `httpsAgent`
- `gemini.adapter.js`: читает `GEMINI_BASE_URL` → использует вместо Google endpoint
- Зависимость: `https-proxy-agent ^7.0.4` добавлена в `backend/package.json`

### ✅ BM25 и стоимость

- `bm25.js`: `if (!queryTerms.length || !docLen) return { score: 0, ... }` — защита от пустого LSI
- `priceCalculator.js`: `formatCost(usd)` использует `.toFixed(4)` — точность 4 знака

### ✅ Парсер

- `scraper.js`: `scrapeCompetitors(urls, timeoutMs=20000)` — таймаут 20 сек
- При таймауте: `{ timedOut: true, content: '', error: '...' }` — пайплайн не падает
- `stage0.js`: логирует timedOut/error URL в SSE через `log(..., 'warn')`

---

## FAQ

**Q: Задача зависает в статусе "В очереди"**  
A: Воркер не запустился. Проверьте: `docker compose logs worker`. Часто причина — неверный `REDIS_URL` (ключи API зашифрованы в коде).

**Q: Ошибка "Gemini API error 403"**  
A: Неверный API-ключ или IP заблокирован Google. Настройте `HTTPS_PROXY` или `GEMINI_BASE_URL` в `.env`.

**Q: SSE не работает (задача зависает на мониторинге)**  
A: Если за Nginx — убедитесь что для SSE-endpoint отключена буферизация (`proxy_buffering off`). Смотрите конфиг Nginx в разделе "Деплой".

**Q: "Stage 1 критическая ошибка: все три агента вернули ошибки"**  
A: Кончилась квота DeepSeek или неверный ключ. Проверьте баланс на [platform.deepseek.com](https://platform.deepseek.com).

**Q: Как изменить количество параллельных задач?**  
A: В `.env` измените `WORKER_CONCURRENCY=5` и перезапустите: `docker compose restart worker`.

**Q: Как обновить код без потери данных?**  
```bash
# Останавливаем только бэкенд и воркер (база данных остаётся работать)
docker compose stop backend worker
# Загружаем новый код (scp или git pull)
# Пересобираем
docker compose build backend
docker compose up -d backend worker
```

**Q: Сколько стоит обработка одной задачи?**  
A: Зависит от объёма контента. Типичная задача (5-7 блоков) потребляет ~100k–200k токенов. При текущих тарифах DeepSeek (~$0.14/1M input) и Gemini (~$3.5/1M input) — $0.02–$0.10 за задачу. Точная стоимость показывается в ResultPage.

---

## Обновление программы на MacBook через терминал

### Предварительные требования

Убедитесь, что у вас установлены:
- **Docker Desktop** (https://www.docker.com/products/docker-desktop/) — запущен и работает
- **Git** — обычно предустановлен на macOS; проверить: `git --version`

### Пошаговая инструкция

#### 1. Откройте Терминал

Нажмите `Cmd + Space`, введите «Terminal», нажмите Enter.

#### 2. Перейдите в папку проекта

```bash
cd ~/путь-к-проекту/generator1
```

Например, если проект лежит в домашней директории:
```bash
cd ~/generator1
```

#### 3. Получите последние обновления из GitHub

```bash
git pull origin main
```

Если вы работаете с другой веткой (например, `copilot/fix-create-task-draft-issue`):
```bash
git pull origin copilot/fix-create-task-draft-issue
```

#### 4. Пересоберите и перезапустите все контейнеры

```bash
docker compose down
docker compose up -d --build
```

Это остановит текущие контейнеры, пересоберёт образы с новым кодом и запустит всё заново.

#### 5. Проверьте что всё работает

```bash
docker compose ps
```

Все контейнеры должны быть в статусе `Up` или `running`.

#### 6. Откройте приложение в браузере

Перейдите на `http://localhost:8080` (или ваш настроенный порт).

### Обновление только бэкенда (без перестройки фронтенда)

Если обновления затрагивают только серверную часть:

```bash
git pull origin main
docker compose build backend worker
docker compose up -d backend worker
```

### Обновление только фронтенда

```bash
git pull origin main
docker compose build frontend
docker compose up -d frontend
```

### Просмотр логов (для диагностики ошибок)

```bash
# Все логи
docker compose logs -f

# Только бэкенд
docker compose logs -f backend

# Только воркер (пайплайн генерации)
docker compose logs -f worker

# Последние 100 строк
docker compose logs --tail=100 backend
```

### Полный сброс (если что-то пошло не так)

```bash
docker compose down -v
docker compose up -d --build
```

> ⚠️ Флаг `-v` удалит тома (volumes), включая базу данных. Используйте только если хотите начать с чистого листа.

---

*SEO Genius v4.0 © 2025–2026. Все права защищены.*
