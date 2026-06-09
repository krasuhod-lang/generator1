"""
Headless fetcher for the relevance pipeline.

Single endpoint: POST /fetch  { url, timeout_ms? } → { html, status, final_url, method }

Behaviour mirrors what firecrawl/crawl4ai do in production:

* Persistent Chromium browser (one process per worker). Каждый запрос — новая
  изолированная BrowserContext с fresh cookies, чтобы соседние URL друг другу
  не «отравляли» сессию.
* stealth-патчи (`tf-playwright-stealth`) — снимают `navigator.webdriver`,
  `chrome.runtime`, `permissions`, languages-array и пр. сигналы автоматизации,
  по которым Cloudflare bot-detect режет страницу до 403.
* Реальный Chrome 124 fingerprint: User-Agent, sec-ch-ua, viewport, locale,
  timezone. На многих Российских/CIS сайтах помогает доехать до 200 OK.
* `route` blocks heavy resources (`image`, `media`, `font`, аналитика) — это
  снижает нагрузку и время загрузки в 2–3×, не теряя content (нам нужен HTML,
  не пиксели).
* Стратегия ожидания: `domcontentloaded` → 1.2s «settle» → пытаемся дождаться
  реального контента (`<article>` / `<main>` / `h1` / `<p>`) с таймаутом 3.5s.
  Если не дождались — всё равно отдаём текущий outerHTML (часто SPA рендерит
  контент позже, но текста уже хватает для readability).
* Жёсткий потолок размера ответа (DEFAULT 8 МБ) и общий timeout (DEFAULT 35s).
* X-Internal-Token (общий с relevance/) — простая защита внутри docker-сети.
"""

import asyncio
import logging
import os
import random
import re
import time
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

try:
    from playwright.async_api import async_playwright, Browser, Page
except Exception:  # pragma: no cover - import-time failure surfaces at startup
    async_playwright = None  # type: ignore
    Browser = None  # type: ignore
    Page = None  # type: ignore

try:
    # tf-playwright-stealth (community port of stealth.js for Python).
    # Если пакет отсутствует — gracefully отключаем stealth-mode.
    from tf_playwright_stealth import stealth_async  # type: ignore
except Exception:  # pragma: no cover
    stealth_async = None  # type: ignore

try:
    # curl_cffi — TLS-fingerprint-impersonating HTTP client (Mode A / fast).
    # Используется для статических сайтов под Cloudflare / DDoS-Guard, где
    # достаточно «настоящего» TLS-handshake без полноценного браузера.
    from curl_cffi import requests as curl_requests  # type: ignore
except Exception:  # pragma: no cover
    curl_requests = None  # type: ignore


LOG = logging.getLogger("relevance_fetcher")
LOG.setLevel(os.environ.get("LOG_LEVEL", "INFO").upper())


# ── Tunables (env-driven) ───────────────────────────────────────────────────

DEFAULT_TIMEOUT_MS = int(os.environ.get("FETCHER_DEFAULT_TIMEOUT_MS", "35000"))
MAX_TIMEOUT_MS = int(os.environ.get("FETCHER_MAX_TIMEOUT_MS", "60000"))
MAX_HTML_BYTES = int(os.environ.get("FETCHER_MAX_HTML_BYTES", str(8 * 1024 * 1024)))
SETTLE_MS = int(os.environ.get("FETCHER_SETTLE_MS", "1200"))
SELECTOR_TIMEOUT_MS = int(os.environ.get("FETCHER_SELECTOR_TIMEOUT_MS", "3500"))
INTERNAL_TOKEN = (os.environ.get("RELEVANCE_INTERNAL_TOKEN") or "").strip()

# Современный Chrome 124 desktop UA — основной fingerprint.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# Пул свежих UA реальных браузеров — ротация на каждый запрос (anti-bot).
# Совпадает по духу с пулом в backend/pageFetcher.js; держим только desktop
# Chromium-совместимые строки, чтобы sec-ch-ua/fingerprint оставались
# консистентными с заголовками контекста ниже.
USER_AGENT_POOL = [
    USER_AGENT,
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
]

# Дефолтный прокси из окружения (опционально). Per-request `proxy` имеет
# приоритет. Формат: scheme://[user:pass@]host:port.
DEFAULT_PROXY = (os.environ.get("RELEVANCE_FETCHER_PROXY") or "").strip()


def _random_user_agent() -> str:
    return random.choice(USER_AGENT_POOL)


def _build_proxy(proxy_url: Optional[str]) -> Optional[dict]:
    """Преобразует ``scheme://[user:pass@]host:port`` в playwright proxy-dict.

    Возвращает ``None``, если прокси не задан. Логин/пароль (если есть в URL)
    выносятся в отдельные поля, как того требует Playwright.
    """
    url = (proxy_url or "").strip() or DEFAULT_PROXY
    if not url:
        return None
    try:
        from urllib.parse import urlparse

        parsed = urlparse(url if "://" in url else f"http://{url}")
        host = parsed.hostname or ""
        if not host:
            return None
        port = f":{parsed.port}" if parsed.port else ""
        server = f"{parsed.scheme or 'http'}://{host}{port}"
        cfg: dict = {"server": server}
        if parsed.username:
            cfg["username"] = parsed.username
        if parsed.password:
            cfg["password"] = parsed.password
        return cfg
    except Exception:  # pragma: no cover - defensive
        return None

# Тяжёлые ресурс-классы Playwright, которые блокируем для скорости.
BLOCKED_RESOURCE_TYPES = {"image", "media", "font", "websocket", "manifest", "other"}

# Аналитика / трекеры — блокируем по host substring, чтобы не «висеть» 30s
# на networkidle из-за вечно открытых WebSocket'ов GA/Я.Метрики.
BLOCKED_HOST_SUBSTRINGS = (
    "googletagmanager.com",
    "google-analytics.com",
    "doubleclick.net",
    "facebook.net",
    "yandex.ru/clck",
    "mc.yandex.ru",
    "mc.yandex.com",
    "vk.com/rtrg",
    "criteo.com",
    "hotjar.com",
    "clarity.ms",
)

CONTENT_SELECTORS = (
    "article",
    "main",
    "[role=main]",
    "h1",
    "p",
)


# ── Pydantic ────────────────────────────────────────────────────────────────


class FetchRequest(BaseModel):
    url: str = Field(..., min_length=4, max_length=4096)
    timeout_ms: Optional[int] = Field(None, ge=2000, le=MAX_TIMEOUT_MS)
    # Прокси для этого запроса (scheme://[user:pass@]host:port). Если не задан —
    # используется RELEVANCE_FETCHER_PROXY из окружения (если есть).
    proxy: Optional[str] = Field(None, max_length=2048)
    # Явное отключение прокси для конкретного URL (proxies_enabled=false с
    # backend-стороны): тогда дефолтный env-прокси НЕ применяется.
    proxies_enabled: Optional[bool] = None


class FetchResponse(BaseModel):
    html: str
    status: int
    final_url: str
    method: str
    elapsed_ms: int


# ── App lifespan: один Browser на процесс ──────────────────────────────────


_state: dict = {"browser": None, "playwright": None, "lock": asyncio.Lock()}


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ARG001 — FastAPI signature
    if async_playwright is None:
        raise RuntimeError("playwright is not installed")
    pw = await async_playwright().start()
    browser = await pw.chromium.launch(
        headless=True,
        args=[
            # Стандартные флаги «менее палевного» Chromium в контейнере.
            "--disable-blink-features=AutomationControlled",
            "--disable-features=IsolateOrigins,site-per-process",
            "--no-sandbox",
            "--disable-dev-shm-usage",
        ],
    )
    _state["browser"] = browser
    _state["playwright"] = pw
    LOG.info("playwright chromium started; stealth=%s", bool(stealth_async))
    try:
        yield
    finally:
        try:
            await browser.close()
        finally:
            await pw.stop()


app = FastAPI(title="relevance_fetcher", version="1.0.0", lifespan=lifespan)


# ── Helpers ────────────────────────────────────────────────────────────────


def _check_token(provided: Optional[str]) -> None:
    """Если RELEVANCE_INTERNAL_TOKEN задан — требуем совпадения."""
    if not INTERNAL_TOKEN:
        return
    if not provided or provided.strip() != INTERNAL_TOKEN:
        raise HTTPException(status_code=401, detail="invalid internal token")


_URL_RE = re.compile(r"^https?://", re.IGNORECASE)


def _validate_url(url: str) -> str:
    u = (url or "").strip()
    if not _URL_RE.match(u):
        raise HTTPException(status_code=400, detail="url must start with http(s)://")
    return u


async def _route_handler(route):
    req = route.request
    rtype = req.resource_type or ""
    url = req.url or ""
    if rtype in BLOCKED_RESOURCE_TYPES:
        return await route.abort()
    for s in BLOCKED_HOST_SUBSTRINGS:
        if s in url:
            return await route.abort()
    return await route.continue_()


async def _wait_for_content(page: Page, deadline_ms: int) -> None:
    """Best-effort ожидание появления одного из смысловых селекторов.

    Никогда не бросает исключение — таймаут — нормальный исход (часто SPA
    рендерит контент через 3+ секунд, нам важно не висеть, а отдать что есть).
    """
    if deadline_ms <= 0:
        return
    try:
        await page.wait_for_selector(
            ", ".join(CONTENT_SELECTORS),
            timeout=deadline_ms,
            state="attached",
        )
    except Exception:
        return


async def _fetch_one(url: str, timeout_ms: int, proxy: Optional[dict] = None) -> FetchResponse:
    """Открыть страницу, дождаться контента, забрать outerHTML."""
    browser: Browser = _state["browser"]
    if browser is None:
        raise HTTPException(status_code=503, detail="browser not ready")

    t0 = time.monotonic()
    method = "playwright"
    user_agent = _random_user_agent()
    context_kwargs = dict(
        user_agent=user_agent,
        locale="ru-RU",
        timezone_id="Europe/Moscow",
        viewport={"width": 1366, "height": 900},
        java_script_enabled=True,
        ignore_https_errors=True,
        extra_http_headers={
            "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.7,en;q=0.6",
            "Sec-CH-UA": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
            "Sec-CH-UA-Mobile": "?0",
            "Sec-CH-UA-Platform": '"Windows"',
            "Upgrade-Insecure-Requests": "1",
        },
    )
    if proxy:
        # Per-context proxy (anti-bot / гео-обход). Playwright туннелирует все
        # запросы контекста через указанный сервер.
        context_kwargs["proxy"] = proxy
        method = "playwright_proxy"
    context = await browser.new_context(**context_kwargs)
    try:
        await context.route("**/*", _route_handler)

        page: Page = await context.new_page()

        # Включаем stealth-патчи (если установлен tf-playwright-stealth).
        if stealth_async is not None:
            try:
                await stealth_async(page)
                method = "playwright_proxy_stealth" if proxy else "playwright_stealth"
            except Exception as exc:  # pragma: no cover
                LOG.debug("stealth_async failed: %s", exc)

        try:
            response = await page.goto(
                url,
                wait_until="domcontentloaded",
                timeout=timeout_ms,
            )
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"goto failed: {exc}") from exc

        # «Settle» небольшой паузой, потом ждём смысловой контент best-effort.
        await page.wait_for_timeout(SETTLE_MS)
        deadline = max(0, min(SELECTOR_TIMEOUT_MS, timeout_ms - int((time.monotonic() - t0) * 1000)))
        await _wait_for_content(page, deadline)

        try:
            html = await page.content()
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"content() failed: {exc}") from exc

        if len(html.encode("utf-8", errors="ignore")) > MAX_HTML_BYTES:
            # Жёсткий лимит — режем «хвост». BeautifulSoup на стороне
            # relevance/ всё равно нормально пережёвывает обрезанный HTML.
            html = html[: MAX_HTML_BYTES // 2]
            method += "_truncated"

        status = response.status if response else 0
        final_url = page.url or url
        elapsed_ms = int((time.monotonic() - t0) * 1000)

        return FetchResponse(
            html=html,
            status=status,
            final_url=final_url,
            method=method,
            elapsed_ms=elapsed_ms,
        )
    finally:
        try:
            await context.close()
        except Exception:  # pragma: no cover
            pass


# ── Routes ─────────────────────────────────────────────────────────────────


@app.get("/health")
async def health() -> dict:
    return {
        "ok": _state.get("browser") is not None,
        "stealth": bool(stealth_async),
        "curl_cffi": bool(curl_requests),
        "max_html_bytes": MAX_HTML_BYTES,
        "default_timeout_ms": DEFAULT_TIMEOUT_MS,
        "fetch_html_default_timeout_ms": FETCH_HTML_DEFAULT_TIMEOUT_MS,
        "fetch_html_max_attempts": FETCH_HTML_MAX_ATTEMPTS,
        "proxy_default": bool(DEFAULT_PROXY),
    }


@app.post("/fetch", response_model=FetchResponse)
async def fetch(
    payload: FetchRequest,
    x_internal_token: Optional[str] = Header(None, alias="X-Internal-Token"),
) -> FetchResponse:
    _check_token(x_internal_token)
    url = _validate_url(payload.url)
    timeout_ms = int(payload.timeout_ms or DEFAULT_TIMEOUT_MS)
    timeout_ms = max(2000, min(MAX_TIMEOUT_MS, timeout_ms))
    # proxies_enabled=false → принудительно без прокси (даже если задан env).
    if payload.proxies_enabled is False:
        proxy = None
    else:
        proxy = _build_proxy(payload.proxy)
    return await _fetch_one(url, timeout_ms, proxy=proxy)


# ─────────────────────────────────────────────────────────────────────────────
# fetch_html — публичный двухрежимный API под спецификацию
# (Anti-Bot / Playwright + curl_cffi).
#
# Контракт (см. README):
#     fetch_html(url, use_js_render=False, proxy=None) -> dict
#
# Mode A (use_js_render=False):  curl_cffi + impersonate="chrome110"
#                                — быстрый TLS-fingerprint обход Cloudflare
#                                  для статических HTML-страниц.
# Mode B (use_js_render=True):   Playwright + tf-playwright-stealth
#                                — полноценный headless Chromium для SPA /
#                                  Авито и сайтов с JS-рендерингом.
#
# Таймаут: FETCH_HTML_DEFAULT_TIMEOUT_MS (env, по умолчанию 20000 мс).
# Retry:  FETCH_HTML_MAX_ATTEMPTS (env, по умолчанию 3 попытки = 1 + 2 retry).
#         При 403 / captcha / таймауте делаем повтор; если задан proxy_pool —
#         каждая попытка берёт следующий прокси из пула.
# В случае окончательного фейла отдаём structured JSON {success:false, …}.
# ─────────────────────────────────────────────────────────────────────────────


FETCH_HTML_DEFAULT_TIMEOUT_MS = int(
    os.environ.get("FETCH_HTML_DEFAULT_TIMEOUT_MS", "20000")
)
FETCH_HTML_MAX_ATTEMPTS = max(
    1, int(os.environ.get("FETCH_HTML_MAX_ATTEMPTS", "3"))
)

# Подсказки на «soft block» в HTML — даже при 200 OK страницу нужно ретраить.
_CAPTCHA_HINTS = (
    "captcha",
    "are you a human",
    "checking your browser",
    "cf-chl-bypass",
    "ddos-guard",
    "проверка вашего браузера",
    "доступ ограничен",
    "подтвердите, что вы не робот",
)


def _looks_like_block(status: int, html: str) -> bool:
    """Heuristic: явный 403/503 или текст-заглушка капчи в теле ответа."""
    if status in (403, 429, 503):
        return True
    if not html:
        # Полностью пустой ответ при 200 — тоже признак анти-бот заглушки.
        return status == 200
    snippet = html[:4096].lower()
    return any(h in snippet for h in _CAPTCHA_HINTS)


class FetchHtmlRequest(BaseModel):
    url: str = Field(..., min_length=4, max_length=4096)
    use_js_render: bool = False
    # Один прокси `scheme://[user:pass@]host:port` — применяется ко всем
    # попыткам, если не задан proxy_pool.
    proxy: Optional[str] = Field(None, max_length=2048)
    # Опциональный пул прокси: если задан, каждая retry-попытка берёт
    # следующий элемент по кругу (для residential-rotations).
    proxy_pool: Optional[list] = None
    # Таймаут на одну попытку (мс). По умолчанию — 20 000 мс из спецификации.
    timeout_ms: Optional[int] = Field(None, ge=2000, le=MAX_TIMEOUT_MS)


class FetchHtmlResponse(BaseModel):
    success: bool
    url: str
    status_code: int
    html: str
    engine_used: str
    error_msg: Optional[str] = None


def _curl_cffi_proxy(proxy_url: Optional[str]) -> Optional[dict]:
    """curl_cffi принимает proxies={'http':…, 'https':…}."""
    url = (proxy_url or "").strip()
    if not url:
        return None
    if "://" not in url:
        url = f"http://{url}"
    return {"http": url, "https": url}


async def _fetch_curl_cffi(
    url: str,
    timeout_ms: int,
    proxy: Optional[str],
) -> FetchHtmlResponse:
    """Mode A — curl_cffi с TLS-impersonate Chrome 110."""
    if curl_requests is None:
        return FetchHtmlResponse(
            success=False,
            url=url,
            status_code=0,
            html="",
            engine_used="curl_cffi",
            error_msg="curl_cffi is not installed",
        )

    user_agent = _random_user_agent()
    headers = {
        "User-Agent": user_agent,
        "Accept": (
            "text/html,application/xhtml+xml,application/xml;q=0.9,"
            "image/avif,image/webp,*/*;q=0.8"
        ),
        "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.7,en;q=0.6",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
    }
    proxies = _curl_cffi_proxy(proxy)
    timeout_s = max(2.0, timeout_ms / 1000.0)

    def _do_request():
        # curl_cffi синхронный — выносим в thread, чтобы не блокировать loop.
        return curl_requests.get(
            url,
            headers=headers,
            impersonate="chrome110",
            timeout=timeout_s,
            proxies=proxies,
            allow_redirects=True,
        )

    try:
        resp = await asyncio.to_thread(_do_request)
    except Exception as exc:
        return FetchHtmlResponse(
            success=False,
            url=url,
            status_code=0,
            html="",
            engine_used="curl_cffi",
            error_msg=f"curl_cffi error: {exc}",
        )

    html = resp.text or ""
    if len(html.encode("utf-8", errors="ignore")) > MAX_HTML_BYTES:
        html = html[: MAX_HTML_BYTES // 2]
    final_url = str(getattr(resp, "url", url) or url)
    return FetchHtmlResponse(
        success=200 <= int(resp.status_code) < 400 and not _looks_like_block(
            int(resp.status_code), html
        ),
        url=final_url,
        status_code=int(resp.status_code),
        html=html,
        engine_used="curl_cffi",
        error_msg=None,
    )


async def _fetch_playwright_html(
    url: str,
    timeout_ms: int,
    proxy: Optional[str],
) -> FetchHtmlResponse:
    """Mode B — Playwright (через уже существующий _fetch_one)."""
    proxy_cfg = _build_proxy(proxy) if proxy else None
    try:
        result = await _fetch_one(url, timeout_ms, proxy=proxy_cfg)
    except HTTPException as exc:
        return FetchHtmlResponse(
            success=False,
            url=url,
            status_code=0,
            html="",
            engine_used="playwright",
            error_msg=str(exc.detail),
        )
    except Exception as exc:  # pragma: no cover - defensive
        return FetchHtmlResponse(
            success=False,
            url=url,
            status_code=0,
            html="",
            engine_used="playwright",
            error_msg=f"playwright error: {exc}",
        )
    blocked = _looks_like_block(int(result.status), result.html)
    return FetchHtmlResponse(
        success=(200 <= int(result.status) < 400) and not blocked,
        url=result.final_url,
        status_code=int(result.status),
        html=result.html,
        engine_used="playwright",
        error_msg="blocked or captcha-like response" if blocked else None,
    )


def _select_proxy(
    attempt: int, proxy: Optional[str], pool: Optional[list]
) -> Optional[str]:
    if pool:
        normalized = [str(p).strip() for p in pool if str(p or "").strip()]
        if normalized:
            return normalized[attempt % len(normalized)]
    return proxy


@app.post("/fetch_html", response_model=FetchHtmlResponse)
async def fetch_html(
    payload: FetchHtmlRequest,
    x_internal_token: Optional[str] = Header(None, alias="X-Internal-Token"),
) -> FetchHtmlResponse:
    """Двухрежимный антибот-фетчер согласно спецификации Scraping/Anti-Bot."""
    _check_token(x_internal_token)
    url = _validate_url(payload.url)
    timeout_ms = int(payload.timeout_ms or FETCH_HTML_DEFAULT_TIMEOUT_MS)
    timeout_ms = max(2000, min(MAX_TIMEOUT_MS, timeout_ms))

    last: Optional[FetchHtmlResponse] = None
    for attempt in range(FETCH_HTML_MAX_ATTEMPTS):
        proxy = _select_proxy(attempt, payload.proxy, payload.proxy_pool)
        if payload.use_js_render:
            last = await _fetch_playwright_html(url, timeout_ms, proxy)
        else:
            last = await _fetch_curl_cffi(url, timeout_ms, proxy)
        if last.success:
            return last
        # Лёгкая пауза между ретраями, чтобы не словить rate-limit.
        await asyncio.sleep(0.5 * (attempt + 1))

    # Окончательный фейл — отдаём structured JSON, без 5xx (graceful degradation).
    if last is None:  # pragma: no cover - defensive
        last = FetchHtmlResponse(
            success=False,
            url=url,
            status_code=0,
            html="",
            engine_used="playwright" if payload.use_js_render else "curl_cffi",
            error_msg="no attempts executed",
        )
    if not last.error_msg:
        last.error_msg = (
            f"failed after {FETCH_HTML_MAX_ATTEMPTS} attempts (status="
            f"{last.status_code})"
        )
    return last
