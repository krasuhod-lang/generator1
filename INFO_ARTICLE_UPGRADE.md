# Инструкция по обновлению — Info Article Generator («Статья в блог»)

Это руководство описывает, как накатить очередное обновление **«Генератор
информационной статьи в блог»** на уже работающий инстанс SEO Genius. В пакет
обновления входят:

* фикс таймаута Gemini (writer Stage 3 больше не падает на `timeout of 180000ms exceeded`);
* идемпотентная runtime-миграция `task_logs` (закрывает 500-ки на
  `/api/tasks/:id/logs` и `relation "task_logs" does not exist`);
* новая опциональная env-переменная `GEMINI_TIMEOUT_MS`;
* счётчик времени генерации в UI («⏱ mm:ss» / «1ч 02м 17с») — live во время
  работы, финальная длительность после завершения;
* эта инструкция + полная карта стадий ниже.

> ⚠️ `.env` **обнулять не нужно**. Все существующие переменные остаются как есть.
> Все новые переменные — опциональные: по умолчанию работают разумные дефолты.

---

## TL;DR — короткая последовательность

```bash
ssh root@<your-server-ip>
cd /opt/seo-genius           # путь до вашего проекта

git fetch --all
git pull origin main         # ваша основная ветка

# (опционально) добавить новую строку в .env — см. шаг 3
nano .env

docker compose up -d --build backend frontend worker

docker compose logs --tail=120 backend | grep -E 'Schema|task_logs|Server'
```

Готово. Сами миграции (новая таблица `task_logs` + всё остальное из `017`)
накатываются автоматически при старте backend в функции `ensureSchema()`.

---

## Что именно изменилось

| Категория | Где / что |
|---|---|
| Backend | `backend/src/services/llm/gemini.adapter.js` — дефолтный `timeoutMs` 180 → 300 с; верхний предел 300 → 600 с; новый env `GEMINI_TIMEOUT_MS` |
| Backend | `backend/src/services/llm/callLLM.js` — `opts.timeoutMs` теперь пробрасывается в адаптер (стадии могут переопределять глобальный дефолт) |
| Backend | `backend/src/services/infoArticle/infoArticlePipeline.js` — Stage 3 writer + corrective retry явно просят `timeoutMs: 480000` (8 мин), потому что reasoning-модель Gemini-3.1-pro-preview с `maxTokens=16384` стабильно отвечает 3–5 мин |
| Backend | `backend/server.js#ensureSchema` — добавлена идемпотентная DDL для `task_logs` (мигрирует существующие БД, у которых ещё не было миграции 009) |
| Frontend | `frontend/src/views/InfoArticlePage.vue` — счётчик времени генерации (live + финальный), отдельная плитка в табе «Метрики», колонка в списке задач |
| Конфиг | `.env.example` — раздел «GEMINI_TIMEOUT_MS» (документация переменной) |

**Не меняли:** прайс-калькуляторы, схему `info_article_tasks` (поля
`started_at` / `completed_at` уже были в миграции 017 — таймер использует их),
адаптеры DeepSeek / Grok / Nano Banana Pro, AI-Copilot редактор.

---

## 1. Подключиться к серверу и обновить код

```bash
ssh root@<your-server-ip>
cd /opt/seo-genius

git fetch --all
git status              # убедиться, что нет локальных правок
git pull origin main    # либо имя вашей ветки
```

Если деплой без git — просто залейте свежие файлы (минимум: `backend/`,
`frontend/`, `.env.example`, `INFO_ARTICLE_UPGRADE.md`).

## 2. Обновить `.env` (опционально)

Откройте действующий `.env` и **только добавьте** в конец одну новую строку,
если хотите управлять таймаутом Gemini вручную:

```env
# ── Gemini call timeout ─────────────────────────────────────────────
# Дефолт — 300000 (5 мин). Допустимый диапазон: 1000…600000.
# Поднимать имеет смысл, если у вас часто длинные writer-промпты или
# вы видите в логах «timeout of <X>ms exceeded».
# GEMINI_TIMEOUT_MS=300000
```

Никакие существующие переменные удалять / переименовывать **не нужно**:

* `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`, `HTTPS_PROXY`,
  `GEMINI_PROXY_URL`, `INFO_ARTICLE_*`, `LINK_ARTICLE_*`, `STAGE8_*`,
  `LLM_RESPONSE_CACHE_*`, `*_MAX_CONCURRENT` — остаются как есть.
* Если у вас уже задан `GEMINI_TIMEOUT_MS` (раньше его не было — значит точно
  не задан) — он подхватится автоматически.

Эталонный пример всех актуальных переменных лежит в `.env.example`
(не перетирайте им свой `.env` — в нём только демо-значения и комментарии).

## 3. Пересобрать и перезапустить контейнеры

Самый аккуратный способ — пересобрать только три прикладных сервиса.
Тома Postgres / Redis при этом не трогаются:

```bash
docker compose up -d --build backend frontend worker
```

Если хочется «полного» рестарта (например, обновляли `docker-compose.yml`):

```bash
docker compose down            # БЕЗ -v ! Иначе удалятся все БД-тома
docker compose up -d --build
```

> ❗️ Никогда не запускайте `docker compose down -v` без явного желания
> снести все базы. Флаг `-v` удаляет **именованные тома**, включая
> `seo_postgres_data`. Без него данные сохраняются.

## 4. Что произойдёт автоматически при старте backend

Файл `backend/server.js` вызывает `ensureSchema()` — это идемпотентный набор
`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … ADD COLUMN IF NOT EXISTS`. После
обновления он догонит:

* таблицу `task_logs` + индекс `(task_id, ts)` + функцию `cleanup_old_task_logs`
  (равно содержимому `migrations/009_add_task_logs.sql`);
* всё, что было в миграциях `001`–`017` (на случай, если у вас старый Postgres-
  volume, созданный до соответствующей миграции).

В логах должно появиться:

```
[Schema] ensureSchema OK
[Server] SEO Genius v4.0 running on port 3000 [production]
```

## 5. Проверка

```bash
# 1. Бекенд жив, схема накатана:
docker compose logs --tail=100 backend | grep -E 'ensureSchema|Server|Error'

# 2. Таблица task_logs существует:
docker compose exec -T postgres psql -U postgres -d seo_genius \
  -c "\d task_logs"

# 3. Воркер видит свежий код:
docker compose logs --tail=50 worker
```

В UI:

1. Зайдите в раздел **«Статья в блог»** (`/info-article`).
2. Создайте новую задачу с тестовой темой и небольшим Excel'ем
   (5–10 строк коммерческих ссылок).
3. Во время генерации в шапке задачи и в плашке прогресса появится
   live-таймер «⏱ 02:17». В колонке списка задач — то же самое.
4. После `done` посмотрите вкладку **💰 Метрики** — там будет полная
   длительность + старт/финиш.

---

## Карта стадий — какой промт + какая модель используются

Все стадии собраны в `backend/src/services/infoArticle/infoArticlePipeline.js`
(оркестратор `processInfoArticleTask`). Промты лежат в
`backend/src/prompts/infoArticle/`, ровно по одному файлу на стадию;
loader — `backend/src/prompts/infoArticle/index.js`.

| # | Этап (`current_stage`) | Прогресс | Модель | Промт / файл | t° | Что делает |
|---|---|---|---|---|---|---|
| 1 | `pre_stage0` | 5 % | DeepSeek | `preStage0_strategy.txt` (`preStage0`) | 0.30 | Стратегический контекст темы + ниша на основе доменов из Excel |
| 2 | `stage0_audience` | 12 % | DeepSeek | `stage0_audience.txt` (`stage0`) | 0.30 | ЦА, сегменты, тон, язык |
| 3 | `stage1_intents` | 20 % | DeepSeek | `stage1_intents.txt` (`stage1`) | 0.30 | Сущности, интенты, user-questions, JTBD |
| 4 | `stage1b_whitespace` | 28 % | DeepSeek | `stage1b_whitespace.txt` (`stage1bWS`) | 0.35 | White-space discovery → `article_hierarchy_hints` |
| 5 | `stage2_outline` | 36 % | DeepSeek | `stage2_outline.txt` (`stage2`) | 0.30 | Структура: H2/H3, JTBD-теги, image-плейсхолдеры |
| 6 | `stage2b_lsi` | 44 % | DeepSeek | `stage2b_lsi_synthesis.txt` (`stage2bLsi`) — мульти-фазный + corrective | — | LSI-набор (`important` + `supporting`) для последующего coverage |
| 7 | `stage2c_link_plan` | 52 % | DeepSeek + детерминированный shortlist | `stage2c_link_planner.txt` (`stage2cLink`) | — | План перелинковки 1–2 ссылки на каждый H2 + post-validator |
| 8 | *Build IAKB* | — | — | — | — | Сборка INFO-ARTICLE Knowledge Base; опц. `cachedContents` для Gemini |
| 9 | `stage3_writer` | 60 % | **Gemini** (`gemini-3.1-pro-preview` по умолчанию) | `stage3_writer.txt` (`stage3`) | 0.50 | Написание HTML-статьи с встроенными `<a>` по плану. **Таймаут: 480 с**, `maxTokens=16384`. Если `INFO_ARTICLE_GEMINI_CACHE_ENABLED=true` — system-промпт идёт через `cachedContents` |
| 10 | `stage5_audits` | 70 % | DeepSeek + детерминированный audit | `stage5_eeat_audit.txt` + `stage5b_link_audit.txt` (`stage5Eeat`, `stage5bLink`) | 0.20 | E-E-A-T scoring + audit перелинковки против плана |
| 11 | `stage3_writer_refine` | 76 % | Gemini | тот же `stage3_writer.txt` + corrective-блок в user-промпте | 0.45 | ≤ 1 retry, если `eeat_score < INFO_ARTICLE_EEAT_TARGET` (7.5) или link coverage < 100 % или LSI coverage < 80 %. **Таймаут: 480 с** |
| 12 | `stage4_image_prompts` | 84 % | DeepSeek | `stage4_image_prompts.txt` (`stage4Images`) | 0.40 | Три image-prompt'а под слоты `<!-- IMAGE_SLOT_N -->` |
| 13 | `image_generation` | 92 % | **Nano Banana Pro** (`gemini-3-pro-image-preview`) | — | Генерация картинок через `nanoBananaPro.adapter` (параллелизм 3 по умолчанию) |
| 14 | *Embed + plain* | — | — | — | — | Подмена плейсхолдеров на `<figure><img src="data:…base64,…"/>` + strip-tags для `article_plain` |
| 15 | *Cleanup* | 100 % | — | — | — | Удаление Gemini cachedContents (если создавался) |

### Какие переменные определяют выбор моделей

| Переменная | Дефолт | Где читается |
|---|---|---|
| `INFO_ARTICLE_GEMINI_MODEL` | fallback на `GEMINI_MODEL`, иначе `gemini-3.1-pro-preview` | Stage 3 writer + refine |
| `INFO_ARTICLE_DEEPSEEK_MODEL` | fallback на `DEEPSEEK_MODEL`, иначе `deepseek-chat` | Все аналитические стадии 1–7, 10, 12 |
| `INFO_ARTICLE_IMAGE_MODEL` | `gemini-3-pro-image-preview` | Stage 13 (`nanoBananaPro.adapter`) |
| `GEMINI_TIMEOUT_MS` *(новая)* | `300000` | Глобальный дефолт таймаута для Gemini-вызовов |
| `INFO_ARTICLE_EEAT_TARGET` | `7.5` (общий `EEAT_PQ_TARGET`) | Триггер refine-цикла |
| `INFO_ARTICLE_LSI_TARGET` | `80` (общий `LSI_COVERAGE_TARGET`) | Триггер refine-цикла |
| `INFO_ARTICLE_GEMINI_CACHE_ENABLED` | `false` | Включает Gemini `cachedContents` для IAKB |
| `INFO_ARTICLE_MAX_PARALLEL_IMAGES` | `3` | Параллелизм image-генерации |
| `GEMINI_IMAGE_PRICE_USD` | `0.04` | Стоимость одной картинки для подсчёта `cost_usd` |

---

## Откат (rollback)

Изменения изолированы. Если что-то пошло не так:

```bash
git checkout <prev-sha>
docker compose up -d --build backend frontend worker
```

Таблицу `task_logs` удалять **не нужно** — она нужна и старому коду
(`taskLogPersister`). Поля `started_at` / `completed_at` в `info_article_tasks`
тоже использовались до этого PR, они просто стали отображаться в UI.

Если очень хочется откатить новую env-переменную — просто удалите строку
`GEMINI_TIMEOUT_MS=…` из `.env` и перезапустите backend: вернётся дефолт 300 с.

---

## FAQ

**Q: Не упадёт ли моя БД при `docker compose up -d --build`?**
Нет. Postgres и Redis работают на именованных томах (`seo_postgres_data`,
`seo_redis_data`) — они переживают пересборку контейнеров. Удалить тома можно
**только** явным `docker compose down -v`, который мы здесь нигде не вызываем.

**Q: Нужны ли новые ключи / прокси?**
Нет. `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, прокси — те же.

**Q: Можно вообще ничего не править в `.env`?**
Да. Дефолтных значений достаточно — таймаут Gemini сам станет 300 с, всё
остальное и так уже было в `.env`.

**Q: А если у меня уже шла генерация в момент `docker compose down`?**
При старте backend выполняется `recoverStuckInfoArticleTasks()` — все задачи
со статусом `running` помечаются как `error` с сообщением «Сервер был
перезапущен во время выполнения задачи». Можно перезапустить их вручную из UI.

**Q: Где увидеть старт / финиш генерации в UI?**
В табе **💰 Метрики** карточки задачи. Там же финальная длительность в
формате `mm:ss` или `Xч Yм Zс`. Live-таймер виден всегда: в шапке карточки,
в плашке прогресса и в строке списка задач.

**Q: На что обратить внимание в логах после деплоя?**
* `[Schema] ensureSchema OK` — миграции догнаны.
* Никаких `relation "task_logs" does not exist` в backend / postgres.
* Никаких `timeout of 180000ms exceeded` в worker (если появятся новые
  таймауты на больших промптах — поднимите `GEMINI_TIMEOUT_MS`, например, до
  `420000` = 7 мин).
