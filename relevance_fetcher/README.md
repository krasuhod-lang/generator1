# relevance_fetcher — Anti-Bot HTML fetcher

FastAPI-сервис, реализующий «headless»-извлечение HTML с обходом TLS-fingerprint
защит (Cloudflare / DDoS-Guard) и JS-рендеринга для SPA. Совмещает **два
режима** работы согласно требованию `Scraping / Anti-Bot`:

| Режим | Движок | Когда использовать |
|------|--------|---------------------|
| **A — Fast / TLS Bypass** | [`curl_cffi`](https://github.com/lexiforest/curl_cffi) с `impersonate="chrome110"` | Статичные сайты под Cloudflare / DDoS-Guard, где достаточно настоящего TLS-handshake (быстро, без браузера). |
| **B — JS Rendering / Stealth** | Playwright (Chromium) + [`tf-playwright-stealth`](https://pypi.org/project/tf-playwright-stealth/) | SPA-сайты с JS-рендерингом (Авито и т.п.); скрываются признаки автоматизации (`navigator.webdriver`, `chrome.runtime`, languages-array и пр.). |

## API

### `POST /fetch_html`

Контракт под спецификацию `fetch_html(url, use_js_render=False, proxy=None)`.

**Тело запроса:**

```json
{
  "url": "https://www.avito.ru/...",
  "use_js_render": true,
  "auto_escalate": false,
  "proxy": "******ip:port",
  "proxy_pool": ["******ip1:port", "******ip2:port"],
  "timeout_ms": 20000
}
```

* `use_js_render=false` → **Mode A** (`curl_cffi`).
* `use_js_render=true`  → **Mode B** (Playwright + stealth).
* `auto_escalate=true` (только с `use_js_render=false`) — если Mode A
  исчерпал попытки (WAF / captcha / пустой ответ), сервис **сам** повторяет
  запрос через Mode B в рамках того же HTTP-вызова. Используется
  B2B-парсером (`backend/src/services/serpB2b/siteFetcher.js`), чтобы
  не делать второй round-trip.
* `proxy` — один прокси `scheme://[user:pass@]host:port`.
* `proxy_pool` — опциональный пул; на каждой retry-попытке берётся следующий
  элемент по кругу (для ротации residential-прокси).
* `timeout_ms` — таймаут одной попытки (по умолчанию **20 000 мс**, как в спеке).

**Ответ:**

```json
{
  "success": true,
  "url": "https://www.avito.ru/...",
  "status_code": 200,
  "html": "<!doctype html>...",
  "engine_used": "playwright",
  "error_msg": null
}
```

* `success=false` отдаётся при 403/429/503, captcha-заглушках, таймаутах и
  ошибках сети — вместо 5xx, чтобы пайплайн не падал (graceful degradation).
* Перед фейлом сервис делает **до 2-х автоматических retry** (всего 3 попытки),
  с ротацией прокси из `proxy_pool`, если он задан. Количество попыток —
  через env `FETCH_HTML_MAX_ATTEMPTS`.

### `POST /fetch` (legacy)

Старый endpoint, всегда Playwright. Используется backend'ом
`backend/src/services/relevance/pageFetcher.js` — НЕ удалён, контракт сохранён.

### `GET /health`

Возвращает флаги установленных движков (`stealth`, `curl_cffi`) и текущие
таймауты — удобно дёргать из docker healthcheck'а.

## Установка локально

```bash
cd relevance_fetcher
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

# Браузеры для Playwright (обязательно — без них Mode B не работает):
playwright install chromium
playwright install-deps   # системные .so (Linux); на Mac/Win не требуется

uvicorn app.main:app --host 0.0.0.0 --port 8001
```

В Docker уже используется образ `mcr.microsoft.com/playwright/python:v1.48.0-jammy`,
в нём Chromium и зависимости предустановлены — ручной `playwright install`
запускать не нужно.

## Переменные окружения

Те, что нужно прописать в `.env` рядом с `docker-compose.yml`:

| Переменная | По умолчанию | Назначение |
|-----------|--------------|------------|
| `RELEVANCE_INTERNAL_TOKEN` | — | Общий секрет с backend'ом. Если задан, `/fetch` и `/fetch_html` требуют заголовок `X-Internal-Token`. |
| `RELEVANCE_FETCHER_PROXY` | — | Дефолтный прокси `scheme://[user:pass@]host:port` (используется, если в запросе `proxy` не указан). Для Авито/Promopult рекомендуется **residential**-прокси — datacenter-IP блокируются. |
| `FETCH_HTML_DEFAULT_TIMEOUT_MS` | `20000` | Дефолтный таймаут одной попытки `/fetch_html` (мс). Спецификация требует ≤ 20 000 мс. |
| `FETCH_HTML_MAX_ATTEMPTS` | `3` | Всего попыток для `/fetch_html` (1 основная + 2 retry). |
| `FETCHER_DEFAULT_TIMEOUT_MS` | `35000` | Таймаут legacy-endpoint `/fetch`. |
| `FETCHER_MAX_TIMEOUT_MS` | `60000` | Верхняя граница для `timeout_ms` в любом endpoint'е. |
| `FETCHER_MAX_HTML_BYTES` | `8388608` | Жёсткий потолок размера ответа (8 МБ). |
| `FETCHER_SETTLE_MS` | `1200` | Пауза после `domcontentloaded` перед сбором HTML (Mode B). |
| `FETCHER_SELECTOR_TIMEOUT_MS` | `3500` | Best-effort ожидание `<article>/<main>/h1/p` (Mode B). |
| `LOG_LEVEL` | `INFO` | Уровень логов сервиса. |

> Если планируется работа с Авито / коммерческими сайтами под Cloudflare —
> **обязательно** задайте `RELEVANCE_FETCHER_PROXY` или передавайте `proxy` /
> `proxy_pool` в запросе. С серверных IP такие сайты возвращают 403/CAPTCHA.

## Поведение при блокировках

`/fetch_html` считает попытку неуспешной и идёт на retry, если:

* HTTP-статус = `403`, `429`, `503`;
* тело ответа содержит маркеры заглушки (`captcha`, `cf-chl-bypass`,
  `ddos-guard`, `проверка вашего браузера`, `подтвердите, что вы не робот`,
  «доступ ограничен», и т.п.);
* `goto`/сетевой запрос упал по таймауту или ошибке.

После исчерпания попыток сервис возвращает `200 OK` с `success=false` и
заполненным `error_msg` — вызывающая сторона сама решает, логировать ли это
как ошибку или мягко пропустить URL.
