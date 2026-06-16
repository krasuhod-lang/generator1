# Position Tracker — съём позиций через XMLStock

Модуль «Съём позиций» позволяет регулярно снимать позиции сайта в Яндексе
и Google по списку запросов с привязкой к гео (городу) и устройству, а также
строить графики динамики и аналитику «выросло / упало» в разрезе недель и
месяцев.

API: `/api/position-tracker`. Frontend: `/position-tracker` (список проектов)
и `/position-tracker/:id` (детальная страница).

## Структура данных

- `position_projects` — проект отслеживания (домен, движок, гео, устройство,
  расписание).
- `position_keywords` — список запросов проекта (с опциональным
  `target_url` и тегами).
- `position_runs` — отдельный «съём» (один запуск пайплайна, по одному
  на движок: yandex / google).
- `position_results` — позиция запроса в рамках конкретного съёма.

Все таблицы создаются миграцией `migrations/076_position_tracker.sql` и
дублируются в `ensureSchema()` в `backend/server.js` для идемпотентности.

## Гео (город)

### Яндекс
Используется параметр `lr` — числовой код региона:
- `213` — Москва, `2` — Санкт-Петербург, `54` — Екатеринбург, …
- Полный список — в `frontend/src/data/yandex-regions.js`.

### Google
Используется параметр `loc` (строка вида `Moscow,Moscow,Russia`).
Поддержка добавлена в `xmlstockClient.fetchGoogleSerp({loc})`.

## XMLStock — переменные окружения

Position Tracker переиспользует существующий клиент XMLStock из модуля
meta-tags. Все настройки наследуются, отдельных переменных не вводится.

| Переменная                          | Назначение                                          | По умолчанию |
|-------------------------------------|-----------------------------------------------------|--------------|
| `XMLSTOCK_URL`                      | Эндпоинт Яндекс-выдачи (с user/key)                 | хардкод      |
| `XMLSTOCK_GOOGLE_URL`               | Эндпоинт Google-выдачи                              | автогенерация из `XMLSTOCK_URL` |
| `XMLSTOCK_TRANSIENT_RETRIES`        | Сколько раз поллить «запрос ещё не обработан»       | `8`          |
| `XMLSTOCK_TRANSIENT_DELAY_MS`       | Базовая задержка между попытками (мс)               | `3000`       |
| `XMLSTOCK_TRANSIENT_MAX_DELAY_MS`   | Потолок exponential backoff                         | `15000`      |
| `XMLSTOCK_NETWORK_RETRIES`          | Сетевые ретраи на 5xx / network                     | `3`          |
| `XMLSTOCK_NETWORK_DELAY_MS`         | Задержка между сетевыми ретраями                    | `3000`       |

Переменные модуля Position Tracker:

| Переменная                              | Назначение                                                | По умолчанию |
|-----------------------------------------|-----------------------------------------------------------|--------------|
| `POSITION_TRACKER_CONCURRENCY`          | Параллельных запросов XMLStock на один run                | `3`          |
| `POSITION_TRACKER_SCHEDULER_ENABLED`    | Включает авто-съём по расписанию (`daily` / `weekly`)     | `0` (выключен) |
| `POSITION_TRACKER_TICK_MS`              | Период проверки расписания                                | `3600000` (1 час) |

## Эндпоинты API

Все эндпоинты требуют JWT-аутентификацию (заголовок `Authorization` с Bearer-токеном).

### Проекты
- `GET    /api/position-tracker/projects` — список своих проектов.
- `POST   /api/position-tracker/projects` — создать проект.
  Тело: `{ name, domain, engine, geo_lr, geo_loc, device, schedule }`.
- `GET    /api/position-tracker/projects/:id` — проект + список его запросов.
- `PATCH  /api/position-tracker/projects/:id` — обновить настройки.
- `DELETE /api/position-tracker/projects/:id` — удалить (каскад: запросы, runs, results).

### Запросы
- `POST   /api/position-tracker/projects/:id/keywords` — добавить.
  Тело: `{ queries: ["q1", "q2"], target_url?, tags? }`.
- `DELETE /api/position-tracker/projects/:id/keywords/:kwId` — удалить запрос.

### Съёмы
- `POST /api/position-tracker/projects/:id/runs` — запустить съём вручную.
  Тело (опц.): `{ engine: "yandex"|"google"|"both" }`. Возвращает 202 сразу,
  работа идёт в фоне.
- `GET  /api/position-tracker/projects/:id/runs` — последние 50 запусков.

### Аналитика
- `GET /api/position-tracker/projects/:id/summary?period=week|month&engine=`
  KPI-сводка: средняя позиция, ТОП-3/10/30, выросло/упало/без изменений
  относительно предыдущего периода такой же длины.
- `GET /api/position-tracker/projects/:id/series?granularity=day|week|month&from=&to=&engine=`
  Временной ряд средней позиции и долей ТОП-N по букетам.
- `GET /api/position-tracker/projects/:id/keywords/:kwId/series?granularity=…`
  Серия по конкретному запросу.
- `GET /api/position-tracker/projects/:id/keywords-table?period=week|month&engine=`
  Таблица всех запросов с текущей позицией, дельтой к предыдущему периоду
  и URL в выдаче.
- `GET /api/position-tracker/projects/:id/movers?direction=up|down&period=week|month&limit=20`
  Топ движений (выросло / упало).

## Ограничения и устойчивость

- Транзиентные ошибки XMLStock («запрос ещё не обработан») поллятся внутри
  `xmlstockClient` с экспоненциальным бэкоффом — отдельной логики в
  position-tracker не требуется.
- Сбой одного ключа не валит весь run — позиция пишется как `NULL`
  с сохранённым в `serp_snippet` сообщением об ошибке.
- Идемпотентность: `UNIQUE(run_id, keyword_id, engine)` + `ON CONFLICT
  DO NOTHING` — повторный запуск раннера на том же `run_id` не дублирует
  результаты.
- Зависшие runs (старше 2 часов в статусе `processing`) автоматически
  переводятся в `error` при рестарте сервера через `recoverStuckPositionRuns`.
- Параллелизм запросов к XMLStock на один run ограничен
  `POSITION_TRACKER_CONCURRENCY` (по умолчанию 3), чтобы не упереться
  в квоту аккаунта.

## Тесты

`node backend/scripts/test-position-tracker.js` — 22 кейса:
- pure helpers `analytics.js` (classifyDelta, deltaPosition, summarizeRows,
  pickMovers, groupSeries) на синтетических данных, в т. ч. NULL-позиции;
- `xmlstockSerp` — нормализация хоста, матчинг поддоменов, поиск позиции;
- `runner` — создание run, запись results, инкремент прогресса, обработка
  per-keyword ошибок, режим `engine="both"`.
