# pipeline_py — слоистый пайплайн парсинга

Реализация технического задания «Общие архитектурные решения»: система строится
по слоям, каждый из которых изолирован и обрабатывает свои классы ошибок.

```
[1. URL-очередь] → [2. Fetcher (HTTP/браузер)] → [3. Очиститель HTML]
   → [4. LLM-анализатор] → [5. JSON-валидатор] → [6. Retry/Резерв]
   → [7. Хранилище (Excel/БД)] → [8. Журналирование и мониторинг]
```

## Что реализовано в этом сервисе

| Слой | Модуль | Статус |
|------|--------|--------|
| **1. Очередь URL** | [`app/queue.py`](app/queue.py) | ✅ Персистентная очередь на SQLite: `task_id`, статусы (`pending`/`in_progress`/`success`/`failed`/`blocked`), `retry_count`. Ингест из **CSV / Excel / Google Sheets**. Возобновление после сбоя (`recover_stale`). |
| **2. Fetcher** | [`app/fetcher.py`](app/fetcher.py) | ✅ Клиент к сервису [`relevance_fetcher`](../relevance_fetcher) (`/fetch_html`), который реализует обход анти-бот защит (TLS-fingerprint, JS-рендеринг). |
| **3. Очиститель HTML** | [`app/cleaner.py`](app/cleaner.py) | ✅ Удаление служебных тегов/шума, извлечение заголовка и чистого текста. |
| **4. LLM-анализатор** | [`app/orchestrator.py`](app/orchestrator.py) | 🔌 Подключаемый интерфейс `Analyzer` (место для DeepSeek V3 Pro и т.п.). |
| **5. JSON-валидатор** | [`app/orchestrator.py`](app/orchestrator.py) | 🔌 Подключаемый интерфейс `Validator`. |
| **6. Retry / Резерв** | [`app/orchestrator.py`](app/orchestrator.py) + `queue.mark_failure` | ✅ Инкремент `retry_count`, возврат в `pending` до исчерпания попыток; блокировки терминальны. |
| **7. Хранилище** | [`app/orchestrator.py`](app/orchestrator.py) | 🔌 Подключаемый интерфейс `Sink` (Excel/БД). По умолчанию результат сохраняется в очередь. |
| **8. Журналирование** | `logging` + `queue.counts()` | ✅ Логи по слоям и сводка статусов для мониторинга. |

> 🔌 — слой определён как protocol-интерфейс и подключается без изменения
> оркестрации; конкретная реализация LLM-провайдера/схемы валидации/приёмника
> добавляется отдельно.

## Быстрый старт (локально)

```bash
cd pipeline_py
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt          # для Excel — раскомментируйте openpyxl
uvicorn app.main:app --host 0.0.0.0 --port 8010
```

## HTTP API

| Метод | Endpoint | Назначение |
|-------|----------|------------|
| `GET`  | `/health` | Проверка живости. |
| `POST` | `/ingest` | Загрузка URL в очередь: `urls`, `csv_path`, `excel_path`, `google_sheet_url`. |
| `GET`  | `/status` | Сводка по статусам очереди. |
| `POST` | `/run`    | Обработать очередь (опц. `max_tasks`). |

Пример ингеста:

```json
POST /ingest
{ "urls": ["https://example.com/a", "https://example.com/b"] }
```

## Программный API

```python
from app.queue import UrlQueue
from app.fetcher import Fetcher
from app.orchestrator import Orchestrator

q = UrlQueue("pipeline_queue.sqlite3", max_retries=3)
q.ingest_csv("urls.csv", url_column="url")      # Слой 1

orch = Orchestrator(
    queue=q,
    fetcher=Fetcher(base_url="http://relevance_fetcher:8001"),
    # analyzer=..., validator=..., sink=...      # Слои 4/5/7 (подключаемые)
)
counts = orch.run()                              # обработать очередь до конца
print(counts)                                    # {'success': N, 'failed': M, ...}
```

## Конфигурация (env `PIPELINE_*`)

Все параметры — в [`app/config.py`](app/config.py). Основные:

| Переменная | По умолчанию | Назначение |
|-----------|--------------|------------|
| `PIPELINE_QUEUE_DB` | `pipeline_queue.sqlite3` | Файл SQLite-очереди (персистентность). |
| `PIPELINE_URL_COLUMN` | `url` | Имя колонки с URL во входном источнике. |
| `PIPELINE_MAX_RETRIES` | `3` | Максимум попыток на задачу. |
| `PIPELINE_FETCHER_URL` | `http://relevance_fetcher:8001` | Базовый URL сервиса fetcher. |
| `PIPELINE_FETCH_TIMEOUT_MS` | `20000` | Таймаут одной загрузки (≤ 20 000 мс по ТЗ). |
| `PIPELINE_FETCH_JS` | `false` | `true` → Playwright (Mode B); `false` → curl_cffi (Mode A). |
| `PIPELINE_FETCH_AUTO_ESCALATE` | `true` | Автоэскалация Mode A → Mode B при блокировке. |
| `PIPELINE_CLEAN_MIN_TEXT` | `40` | Мин. длина очищенного текста (иначе — неуспех). |
| `PIPELINE_LOG_LEVEL` | `INFO` | Уровень логов. |

## Тесты

```bash
cd pipeline_py
python -m pytest -q
```
