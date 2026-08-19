# Техническое задание

## Бесперебойная работа генератора и автоматическое восстановление задач после обновления сервера

**Проект:** `krasuhod-lang/generator1`  
**Целевой исполнитель:** GPT-5.5  
**Приоритет:** критический  
**Тип работы:** архитектурное исправление фоновых задач, очередей и восстановления после перезапуска

---

## 1. Цель

Необходимо сделать выполнение длительных задач генератора устойчивым к обновлению, перезапуску, падению и пересозданию серверных контейнеров.

После выполнения работы пользователь не должен повторно запускать задачу вручную только потому, что сервер был обновлен, контейнер перезапущен, Redis или audit-сервис временно стал недоступен. Задание должно продолжаться автоматически с последней сохраненной точки либо завершаться понятным статусом `partial`/`failed` с возможностью повторить только незавершенные элементы.

Под бесперебойной работой понимать не обязательно отсутствие короткой паузы при деплое, а следующие гарантии:

1. Задания, созданные до обновления сервера, не теряются.
2. Обработанные элементы и результаты не теряются при остановке процесса.
3. После старта новой версии worker автоматически подхватывает незавершенные задания.
4. Задача не остается навсегда в `queued` или `running` без heartbeat и контроля.
5. Повторное выполнение после сбоя не создает дубликатов.
6. Пользователь видит реальное состояние, прогресс, последнюю ошибку и возможность повторного запуска.

---

## 2. Область работ

Изменения должны охватить все длительные фоновые процессы, которые могут выполняться дольше одного HTTP-запроса:

| Компонент | Текущее назначение | Требование по надежности |
|---|---|---|
| Основной генератор контента | Пайплайн генерации статей и SEO-материалов | Сохранение checkpoint, stalled-job recovery, повтор с последнего этапа |
| `parser_tasks` | Пакетный разбор списка сайтов | Перевести выполнение из fire-and-forget в durable worker, сохранять результат после каждого сайта |
| `site_crawl_tasks` | BFS-обход сайтов, sitemap и страниц | Продолжать обход после рестарта с checkpoint и heartbeat |
| Python audit tasks | Технический аудит и долгие анализы | Убрать зависимость выполнения от in-process `asyncio.create_task()` |
| LLM-вызовы | DeepSeek/DSPy и другие внешние операции | Timeout, retry, backoff, checkpoint и понятный частичный результат |
| Экспорт отчетов | Excel/JSON после пакетной обработки | Не терять уже готовые результаты при падении на финальном экспорте |

В проекте уже существует BullMQ worker для основного пайплайна. Он реализует checkpoint-aware auto-resume, обнаружение stalled jobs и graceful shutdown [1]. Его паттерны нужно использовать как основу, но нельзя считать, что надежность основного worker автоматически распространяется на `parser_tasks`, `site_crawl_tasks` и Python audit.

---

## 3. Анализ текущих проблем

### 3.1. Пакетный парсер

В `backend/src/controllers/parsers.controller.js` обработка запускается после HTTP-ответа через вызов `processUrls(taskId, urls, options)`. Результаты собираются в локальный массив и сохраняются в `parser_tasks` только после обработки всего списка [2].

Если backend перезапустить во время работы, функция исчезает вместе с процессом. Строка `parser_tasks` может остаться в `running`, уже обработанные сайты не будут сохранены, а пользователь не получит Excel-отчет.

### 3.2. Site crawler

`siteCrawler.controller.js` запускает `crawler.runCrawl()` через `setImmediate()`. Сам crawler сохраняет страницы и периодически обновляет статистику, но при старте приложения нет механизма, который подхватывает старые `queued/running` задачи и продолжает их [3].

После пересоздания контейнера задача может остаться в базе без активного исполнителя.

### 3.3. Python audit

В `audit/app/main.py` долгий аудит запускается через `asyncio.create_task()` и хранится в `_running_tasks`. Redis сохраняет snapshot статуса и отчета, но не способен восстановить остановленный coroutine после перезапуска Python-контейнера [4].

В `audit/app/store.py` при недоступности Redis используется in-memory fallback, который полностью теряется при остановке процесса [5].

### 3.4. Обновление контейнеров

В Docker Compose для backend указан `restart: unless-stopped` и `stop_grace_period`, но отдельный worker должен иметь собственную процедуру graceful shutdown и собственное время остановки [6]. Один только `restart` Docker не гарантирует сохранение логики выполнения, если задача хранится только в памяти.

---

## 4. Целевая архитектура

### 4.1. Основной принцип

API только создает задачу и возвращает `task_id`. Длительная работа выполняется отдельным worker-процессом. PostgreSQL является источником истины по заданиям, Redis/BullMQ — транспортом доставки jobs и механизмом stalled-job detection.

```text
Frontend/API
    |
    v
PostgreSQL: task + items + checkpoint + outbox
    |
    v
Publisher/Reconciler -> BullMQ/Redis
    |
    v
Dedicated Worker
    |
    +--> parser
    +--> site crawler
    +--> audit service
    +--> LLM calls
    |
    v
Incremental result + heartbeat + checkpoint
```

Запрещено использовать `setImmediate()`, локальный массив результатов, `asyncio.create_task()` или `Map` в памяти как единственный механизм хранения и выполнения длительной задачи.

### 4.2. Очереди

Создать отдельные BullMQ-очереди:

| Очередь | Назначение |
|---|---|
| `content-generation` | Существующий основной генератор |
| `parser-scans` | Пакетный разбор сайтов и LLM-извлечение |
| `site-crawls` | Обход URL, sitemap и страниц |
| `audit-jobs` | Долгие audit-задачи, если они остаются отдельным процессом |

Разделение необходимо для того, чтобы зависший сайт или медленный LLM-вызов не блокировали основной генератор.

### 4.3. Состояния

Для родительской задачи использовать состояния:

```text
queued
running
paused
retry_wait
completed
partial
failed
cancelled
```

Для отдельного элемента использовать:

```text
queued
running
retry_wait
completed
partial
failed
cancelled
```

Переходы должны быть атомарными и записываться в PostgreSQL. Недопустимы неявные переходы только в памяти.

---

## 5. Изменение схемы данных

Создать миграцию, например `migrations/XXX_durable_generator_tasks.sql`. Миграция должна быть идемпотентной, безопасной для повторного запуска и продублированной в `ensureSchema`, если это принято текущей архитектурой.

### 5.1. Поля родительской задачи

Для `parser_tasks`, `site_crawl_tasks` и связанных задач добавить либо создать отдельные таблицы со следующими полями:

```text
status              TEXT
attempts            INTEGER DEFAULT 0
worker_id           TEXT NULL
lease_token         UUID NULL
lease_until         TIMESTAMPTZ NULL
heartbeat_at        TIMESTAMPTZ NULL
checkpoint          JSONB NULL
last_error_code     TEXT NULL
last_error_message  TEXT NULL
started_at          TIMESTAMPTZ NULL
finished_at         TIMESTAMPTZ NULL
updated_at          TIMESTAMPTZ NOT NULL
```

### 5.2. Элементы задачи

Для пакетных операций создать таблицу items, например `parser_task_items`:

```text
id                  UUID PRIMARY KEY
parent_task_id      UUID/BIGINT NOT NULL
input_url           TEXT NOT NULL
normalized_url      TEXT NOT NULL
status              TEXT NOT NULL DEFAULT 'queued'
attempts            INTEGER NOT NULL DEFAULT 0
worker_id           TEXT NULL
lease_token         UUID NULL
lease_until         TIMESTAMPTZ NULL
heartbeat_at        TIMESTAMPTZ NULL
checkpoint          JSONB NULL
result              JSONB NULL
error_code          TEXT NULL
error_message       TEXT NULL
created_at          TIMESTAMPTZ NOT NULL
updated_at          TIMESTAMPTZ NOT NULL
finished_at         TIMESTAMPTZ NULL
UNIQUE(parent_task_id, normalized_url)
```

Каждый сайт или значимый этап должен сохраняться отдельно. Нельзя хранить все результаты только в одном финальном JSON родительской задачи.

### 5.3. Transactional outbox

Для устранения рассинхронизации PostgreSQL и Redis реализовать transactional outbox:

```text
В одной транзакции:
1. создать родительскую задачу;
2. создать items;
3. создать outbox-событие task_created/item_queued;
4. выполнить COMMIT.

Отдельный publisher:
1. читает неопубликованные outbox-события через FOR UPDATE SKIP LOCKED;
2. публикует job в BullMQ;
3. отмечает событие published_at;
4. при сбое повторяет публикацию.
```

Если для первой итерации выбран более простой reconciler, он должен каждые 30–60 секунд искать `queued` items без активной BullMQ job и повторно помещать их в очередь.

---

## 6. Lease, heartbeat и checkpoint

Worker при получении item должен атомарно получить lease. Для защиты от двух параллельных исполнителей использовать `lease_token`.

Все записи результата, статуса и checkpoint выполнять с условием:

```sql
UPDATE task_items
SET status = $new_status,
    result = $result,
    heartbeat_at = NOW(),
    updated_at = NOW()
WHERE id = $item_id
  AND lease_token = $lease_token;
```

Если `rowCount = 0`, worker потерял lease и не имеет права перезаписывать результат.

Требования:

| Механизм | Требование |
|---|---|
| Heartbeat | Каждые 10–15 секунд |
| Lease | По умолчанию 60 секунд с продлением |
| Checkpoint parser | После каждого обработанного сайта |
| Checkpoint crawler | После каждой страницы или максимум 10 страниц |
| Checkpoint генератора | После каждого завершенного этапа/блока |
| Retry | Ограниченное число попыток с exponential backoff |
| Idempotency | Повтор не создает дубликаты страниц, URL, файлов и результатов |

Checkpoint должен содержать последний успешно завершенный этап, текущий item, счетчики, версию схемы, версию prompt/worker и необходимые параметры для продолжения.

---

## 7. Восстановление после обновления сервера

При старте API или worker выполнить startup recovery под PostgreSQL advisory lock:

1. Дождаться доступности PostgreSQL и Redis.
2. Найти записи `running`, у которых истек `lease_until` либо heartbeat старше допустимого TTL.
3. Перевести их в `retry_wait` или `queued`.
4. Увеличить `attempts` и записать `last_error_code = 'worker_restarted'`.
5. Восстановить jobs через outbox/reconciler.
6. Не изменять `completed`, `cancelled`, `partial` и финальные `failed` без явного retry.
7. Запустить watchdog после завершения recovery.

Если старый worker был остановлен по SIGTERM, он должен сам сохранить checkpoint и корректно вернуть незавершенный item в очередь. Если процесс завершился через SIGKILL или аварийно, recovery должен сработать по истекшему lease.

Задачи, созданные до обновления схемы, должны быть совместимы с новой версией worker. Миграции выполнять в backward-compatible порядке: сначала добавить новые поля/таблицы, затем обновить worker, и только в отдельном релизе удалять устаревшую логику.

---

## 8. Graceful shutdown

Для каждого worker реализовать обработчики SIGTERM/SIGINT по образцу существующего `backend/src/queue/worker.js` [1]:

1. прекратить принимать новые jobs;
2. дождаться завершения короткой критической операции;
3. сохранить checkpoint и heartbeat;
4. вернуть текущий job в очередь либо оставить его для recovery по lease;
5. закрыть BullMQ worker;
6. закрыть HTTP-клиенты, Redis и DB-соединения;
7. завершить процесс только после сохранения состояния.

Для API backend добавить общий graceful shutdown:

- перестать принимать новые долгие операции;
- закрыть HTTP server;
- остановить watchdog и schedulers;
- завершить короткие транзакции;
- закрыть pool PostgreSQL и Redis.

Для audit FastAPI добавить shutdown handler. `_running_tasks` не должен быть единственным владельцем выполнения. При завершении audit-контейнера активная задача должна иметь сохраненный статус и возможность повторного запуска worker-ом.

В `docker-compose.yml` добавить `stop_grace_period` для всех worker-контейнеров, healthcheck и зависимости от PostgreSQL/Redis. Для production предусмотреть минимум две worker-реплики либо процедуру graceful drain перед обновлением.

---

## 9. Watchdog и защита от вечного зависания

Создать общий `taskRecoveryScheduler` либо расширить существующий watchdog-паттерн проекта [7].

| Проверка | Интервал | Действие |
|---|---:|---|
| Heartbeat | 10–15 секунд | Обновить lease активной задачи |
| Expired lease recovery | 30 секунд | Вернуть задачу в очередь |
| Queue reconciler | 30–60 секунд | Найти queued items без BullMQ job |
| Stale queued alert | 1–5 минут | Записать warning/метрику |
| Absolute timeout | По типу задачи | Перевести в retry/partial/failed |

Watchdog не должен сразу массово ставить ошибки. Сначала нужно безопасно вернуть задачу в очередь. В `failed` переводить после исчерпания попыток или абсолютного таймаута.

Добавить структурированные логи и метрики:

```text
queue_depth
oldest_queued_age
active_jobs
stale_reclaimed_total
retry_total
worker_restarted_total
task_completed_total
task_partial_total
task_failed_total
```

В логах обязательно указывать `task_id`, `item_id`, `worker_id`, `lease_token` в безопасном виде, attempt, старый/новый статус, причину и длительность. API-ключи и полные ответы LLM в обычные логи не записывать.

---

## 10. Идемпотентность

Повторное выполнение допустимо, но повторная запись не должна портить данные.

Требования:

- уникальный ключ `(parent_task_id, normalized_url)` для сайтов;
- upsert страниц по `(crawl_task_id, normalized_url)`;
- уникальный job id на логический item;
- атомарная фиксация результата только владельцем lease;
- финальный Excel создается из сохраненных items, а не из локального массива;
- повторный экспорт не запускает повторный парсинг;
- повтор LLM-вызова не создает второй клиентский сегмент или дубликат услуги;
- повтор после сбоя должен использовать `content_hash`, версию prompt и версию схемы.

---

## 11. API и пользовательские статусы

API должен возвращать реальное состояние, например:

```json
{
  "task_id": "...",
  "status": "running",
  "progress": {
    "total": 100,
    "processed": 42,
    "completed": 38,
    "partial": 2,
    "failed": 2,
    "queued": 58
  },
  "recovery": {
    "last_heartbeat_at": "...",
    "last_recovered_at": null,
    "attempt": 1
  }
}
```

Добавить endpoint-ы:

```text
GET  /api/tasks/:id/health
POST /api/tasks/:id/retry-failed
POST /api/tasks/:id/cancel
GET  /api/tasks/:id/items
```

Frontend должен показывать:

- «выполняется» только при свежем heartbeat;
- «восстанавливается после перезапуска» при recovery;
- «частично завершено» при смешанном результате;
- количество автоматически повторенных items;
- время последнего прогресса;
- кнопку «Повторить ошибки».

Если heartbeat устарел, нельзя бесконечно показывать пользователю «ИИ анализирует». Нужно отобразить recovery либо понятную ошибку.

---

## 12. Тестирование

### 12.1. Обязательные интеграционные тесты

| Сценарий | Ожидаемый результат |
|---|---|
| SIGTERM worker во время генерации | Checkpoint сохранен, задача продолжается |
| SIGKILL worker | Истекший lease возвращен в очередь |
| Рестарт backend до публикации job | Outbox/reconciler публикует job повторно |
| Рестарт Redis | PostgreSQL-состояние сохранено, очередь восстановлена |
| Рестарт PostgreSQL | Worker делает backoff и продолжает после восстановления |
| Рестарт audit во время LLM | Задание не зависает, выполняется retry |
| `docker compose up -d --build` во время batch | Обработанные items не теряются |
| Два worker-а одновременно | Только владелец lease сохраняет результат |
| Дубликат BullMQ job | Нет дублей в БД и отчете |
| Медленный сайт | Timeout/retry не блокирует остальные сайты |
| Старый queued item | Startup recovery возвращает его в работу |
| Ошибка финального Excel-экспорта | Результаты items сохраняются и экспорт можно повторить |

### 12.2. Тест восстановления

Автоматический сценарий должен:

1. создать задачу минимум на 10 items;
2. начать выполнение;
3. принудительно остановить worker после 3–5 items;
4. убедиться, что задача осталась в БД;
5. запустить новую версию worker;
6. дождаться завершения;
7. проверить, что все items имеют финальный статус;
8. проверить отсутствие дубликатов и потерянных результатов;
9. проверить корректный `attempts`, checkpoint и историю recovery.

Такой тест выполнить отдельно для основного генератора, parser worker и site crawler worker.

### 12.3. Нагрузочный тест

Обработать 50–100 задач с ограниченной concurrency. Во время выполнения несколько раз перезапустить backend и worker. Проверить, что очередь не заблокирована, старейшая задача получает worker, память не растет бесконтрольно, а все незавершенные items возвращаются в работу.

---

## 13. План реализации для GPT-5.5

### Этап 1. Аудит

Изучить `backend/src/queue/worker.js`, `backend/src/queue/queue.js`, `backend/src/controllers/parsers.controller.js`, `backend/src/controllers/siteCrawler.controller.js`, `backend/src/services/siteCrawler/crawler.js`, `audit/app/main.py`, `audit/app/store.py`, `docker-compose.yml` и текущие миграции.

Составить таблицу всех длительных задач, текущего источника состояния и поведения после SIGTERM/restart. Не удалять существующую BullMQ-логику основного генератора.

### Этап 2. Надежность основного генератора

Проверить, что существующие `tasks` и BullMQ job согласованы. Добавить reconciler между DB и BullMQ, проверку старых `processing` задач, тесты stalled job и корректный graceful shutdown.

### Этап 3. Parser и crawler

Перевести `parser_tasks` и `site_crawl_tasks` на durable queues/items. Сохранять каждый результат отдельно, добавить lease, heartbeat, checkpoint, retry и startup recovery.

### Этап 4. Audit

Убрать зависимость исполнения от одного Python-процесса. Добавить durable ownership со стороны Node worker либо полноценную очередь audit-задач с повторным запуском после рестарта.

### Этап 5. Deploy и мониторинг

Добавить Docker shutdown/healthcheck, watchdog, метрики, структурированные логи и процедуру backward-compatible update.

### Этап 6. Проверка

Запустить unit, integration, restart, security и load tests. В Pull Request приложить фактический лог теста с остановкой контейнеров и восстановлением задач.

---

## 14. Критерии приемки

Задача принимается только при выполнении всех условий:

1. После SIGTERM, SIGKILL и пересоздания контейнера незавершенные задачи автоматически продолжаются.
2. Ни один item не остается в `running` без свежего heartbeat дольше lease TTL.
3. Результат каждого завершенного item сохраняется независимо от завершения batch.
4. PostgreSQL является источником истины, а Redis/BullMQ не являются единственным хранилищем выполнения.
5. Состояние очереди восстанавливается после рассинхронизации или временной недоступности Redis.
6. Старые задачи, созданные до обновления, обрабатываются новой версией без ручного переноса.
7. Повторная обработка не создает дубликаты.
8. API и frontend показывают recovery, partial, retry и stale состояния.
9. Worker имеет graceful shutdown, healthcheck и stop grace period.
10. Пройдены тесты с перезапуском backend, worker, audit, Redis и PostgreSQL.
11. В PR есть описание миграций, новых переменных окружения, команд запуска и результатов тестирования.

---

## 15. Ограничения

Не нужно переписывать весь генератор или менять бизнес-логику формирования контента. Главная цель — надежность выполнения и сохранение состояния.

Не следует добавлять новый брокер сообщений, если существующие PostgreSQL + Redis + BullMQ закрывают требования. Не следует использовать cron или запуск новой AI-сессии как механизм восстановления задачи. Recovery должен выполняться программным worker-ом и опираться на durable state.

---

## References

[1]: https://github.com/krasuhod-lang/generator1/blob/main/backend/src/queue/worker.js "BullMQ worker основного генератора с checkpoint и graceful shutdown"

[2]: https://github.com/krasuhod-lang/generator1/blob/main/backend/src/controllers/parsers.controller.js "Контроллер пакетного parser, запускающий processUrls"

[3]: https://github.com/krasuhod-lang/generator1/blob/main/backend/src/services/siteCrawler/crawler.js "Сервис BFS-обхода сайта"

[4]: https://github.com/krasuhod-lang/generator1/blob/main/audit/app/main.py "Audit-сервис с in-process asyncio-задачами"

[5]: https://github.com/krasuhod-lang/generator1/blob/main/audit/app/store.py "Хранилище состояний audit с Redis и in-memory fallback"

[6]: https://github.com/krasuhod-lang/generator1/blob/main/docker-compose.yml "Docker Compose и настройки перезапуска контейнеров"

[7]: https://github.com/krasuhod-lang/generator1/blob/main/backend/src/services/projects/analysisRunner.js "Существующий watchdog зависших анализов"
