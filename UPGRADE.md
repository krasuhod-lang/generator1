# Инструкция по обновлению — Link Article Generator

Это руководство описывает, как накатить обновление **«Генератор ссылочной
статьи»** на уже работающий инстанс SEO Genius. Основной пайплайн Stage 0–7,
AI-Copilot, генератор мета-тегов и существующая база **не затрагиваются** —
добавляется отдельный модуль в свою таблицу и свой раздел UI.

> ⚠️ `.env` **обнулять не нужно**. Все существующие переменные остаются как есть.
> Новые переменные — опциональные: по умолчанию работают fallback’и на
> `GEMINI_MODEL` / `HTTPS_PROXY` и т.д. Достаточно выбрать одну из двух схем
> установки ниже.

---

## Что именно добавлено

| Категория | Файл / сущность |
|---|---|
| БД | новая таблица `link_article_tasks` + ENUM `link_article_status` |
| БД | новая таблица `link_article_events` (аудит-журнал этапов) |
| Миграция | `migrations/012_add_link_article_tasks.sql` (+ идемпотентно в `ensureSchema()` при старте сервера) |
| Backend | `backend/src/services/linkArticle/linkArticlePipeline.js` — оркестратор |
| Backend | `backend/src/services/linkArticle/linkArticleMetrics.js` — учёт токенов / стоимости / событий |
| Backend | `backend/src/services/linkArticle/nanoBananaPro.adapter.js` — адаптер Gemini image-модели |
| Backend | `backend/src/prompts/linkArticle/*.txt` — 6 промтов (Pre-Strategy + Stage 0–4) |
| Backend | `backend/src/routes/linkArticle.routes.js` + `controllers/linkArticle.controller.js` — REST + SSE |
| Frontend | `frontend/src/views/LinkArticlePage.vue` + `frontend/src/stores/linkArticle.js` |
| Конфиг | `.env.example` — секция `LINK_ARTICLE_*` |

**Не изменены:** `backend/src/services/pipeline/*`, `backend/src/prompts/systemPrompts.js`,
`backend/src/prompts/strategy/*`, `editorCopilot/*`, `metaTags/*`, таблица `tasks`.

---

## Вариант A: Docker Compose на VPS (Beget / любой Ubuntu)

Это основной сценарий деплоя — как описано в `README.md`.

### 1. Зайти на сервер и перейти в каталог проекта

```bash
ssh root@<your-server-ip>
cd /opt/seo-genius   # или туда, куда вы раскладывали проект
```

### 2. Получить свежую версию кода

```bash
git fetch --all
git pull origin main          # или название вашей основной ветки
```

Если раскатываете без git (через zip/scp) — просто залейте новые файлы
из списка выше.

### 3. Обновить `.env` (только добавление новых строк)

Откройте ваш действующий `.env` и **дописывайте** в конец следующий блок.
Все четыре переменные опциональны — указаны значения по умолчанию,
которые применяются, если переменная не задана.

```env
# ── Link Article Generator ───────────────────────────────────────
# Модель Gemini для написания статьи. Если не задано — берётся GEMINI_MODEL.
# LINK_ARTICLE_GEMINI_MODEL=gemini-3.1-pro-preview

# Модель Nano Banana Pro для 3-х иллюстраций к статье.
# LINK_ARTICLE_IMAGE_MODEL=gemini-3-pro-image-preview

# Ориентировочная цена одной картинки в USD (идёт в cost_usd задачи).
# GEMINI_IMAGE_PRICE_USD=0.04

# Параллелизм image-генерации (1–5). По умолчанию 3 (по числу слотов).
# LINK_ARTICLE_MAX_PARALLEL_IMAGES=3

# Отдельный прокси только для image-модели — если обычный Gemini-прокси
# не подходит (например, у вас раздельные ключи). Если не задан, используется
# общая цепочка LLM_PROXY_* → GEMINI_PROXY_* → HTTPS_PROXY.
# LINK_ARTICLE_IMAGE_PROXY_URL="http://login:password@ip:port"
```

Для сравнения с «как должно быть» — загляните в `.env.example`, раздел
**«Link Article Generator»**.

**Важно:**
* `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `HTTPS_PROXY` / `GEMINI_PROXY_URL`
  **уже есть** в вашем `.env` — их трогать не надо, генератор использует те же ключи.
* Ключ Gemini должен иметь доступ к модели `gemini-3-pro-image-preview`
  (Nano Banana Pro). Если у вашего проекта доступа нет — текст статьи
  всё равно сгенерируется, но три слота с картинками завершатся с ошибкой
  (задача перейдёт в `done`, в слотах будет `status: 'error'`).

### 4. Пересобрать и перезапустить контейнеры

```bash
docker compose down
docker compose up -d --build
```

*Использовать ли `down`?* Только если хотите гарантированно пересобрать
образ. Альтернатива короче и не трогает Postgres/Redis тома:

```bash
docker compose up -d --build backend frontend worker
```

### 5. Миграции применяются автоматически

При старте backend-контейнера выполняется `ensureSchema()`, который
идемпотентно создаёт:

* ENUM `link_article_status`;
* таблицу `link_article_tasks` с индексами;
* таблицу `link_article_events` с индексом по `(task_id, created_at)`.

Никаких `psql` / ручных миграций запускать не нужно. Но если хочется
сделать это явно — можно:

```bash
docker compose exec -T postgres psql -U postgres -d seo_genius \
  < migrations/012_add_link_article_tasks.sql
```

### 6. Проверить, что всё взлетело

```bash
docker compose logs --tail=80 backend
```

Ищите строку `[Schema] ensureSchema OK` — значит таблицы созданы.

Затем откройте UI:

1. Зайдите в приложение под своим логином.
2. В левом меню выберите раздел **«Ссылочная статья»**
   (путь `/link-article`).
3. Заполните форму (тема, анкор, URL, заметки) → **«Сгенерировать»**.
4. Через 2–4 минуты получите HTML + 3 картинки прямо внутри статьи.

---

## Вариант B: Локальный запуск (разработка)

Если гоняете проект локально через `npm run dev`:

```bash
git pull
# backend
cd backend && npm install        # на всякий случай — новых зависимостей НЕТ
cd ..
# frontend
cd frontend && npm install
cd ..
```

Дополните свой локальный `.env` теми же `LINK_ARTICLE_*` переменными
(см. блок в шаге 3 варианта A — можно вообще не добавлять, дефолты рабочие).

Перезапустите backend (он сам накатит схему при старте) и frontend:

```bash
# из каталога backend
npm run dev
# в другом терминале, из frontend
npm run dev
```

---

## Откат (rollback)

Новая фича изолирована, поэтому откат безопасен и не трогает основные данные.

1. Вернуть код на предыдущий коммит: `git checkout <prev-sha>`.
2. `docker compose up -d --build backend frontend worker`.
3. (Опционально) удалить новые таблицы, если они больше не нужны:

    ```sql
    DROP TABLE IF EXISTS link_article_events;
    DROP TABLE IF EXISTS link_article_tasks;
    DROP TYPE  IF EXISTS link_article_status;
    ```

Таблицы `tasks`, `task_metrics`, `editor_copilot_*`, `meta_tag_*` и прочие
существующие объекты при откате **не затрагиваются** — мы их не меняли.

---

## FAQ

**Q: Надо ли обнулять `.env`?**
Нет. Все существующие переменные продолжают работать. Вы только дополняете
файл новыми опциональными строками из шага 3 (можете вообще их не добавлять —
заработает на дефолтах).

**Q: Нужны ли новые API-ключи?**
Нет. Используются те же `GEMINI_API_KEY` и `DEEPSEEK_API_KEY`. Убедитесь
только, что у Gemini-ключа есть доступ к image-preview модели.

**Q: Нужны ли отдельные прокси?**
Нет, по умолчанию используется та же цепочка, что и для основного пайплайна
(`LLM_PROXY_* → GEMINI_PROXY_* → HTTPS_PROXY`). Отдельный
`LINK_ARTICLE_IMAGE_PROXY_URL` имеет смысл задавать только если у вас
разные IP-белые списки для текстовых и image-запросов.

**Q: Что если модель Nano Banana Pro недоступна на моём ключе?**
Задача всё равно завершится со статусом `done` и готовым HTML-текстом —
просто без картинок (три слота будут помечены `status: 'error'`, а
плейсхолдеры `<!-- IMAGE_SLOT_N -->` будут вырезаны из финального HTML).

**Q: Где смотреть расходы?**
Каждая задача хранит свои `deepseek_tokens_*`, `gemini_tokens_*`,
`gemini_image_calls`, `cost_usd` прямо в строке `link_article_tasks`.
Полный журнал этапов — в таблице `link_article_events`.
