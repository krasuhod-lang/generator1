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


async def _fetch_one(url: str, timeout_ms: int) -> FetchResponse:
    """Открыть страницу, дождаться контента, забрать outerHTML."""
    browser: Browser = _state["browser"]
    if browser is None:
        raise HTTPException(status_code=503, detail="browser not ready")

    t0 = time.monotonic()
    method = "playwright"
    context = await browser.new_context(
        user_agent=USER_AGENT,
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
    try:
        await context.route("**/*", _route_handler)

        page: Page = await context.new_page()

        # Включаем stealth-патчи (если установлен tf-playwright-stealth).
        if stealth_async is not None:
            try:
                await stealth_async(page)
                method = "playwright_stealth"
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
        "max_html_bytes": MAX_HTML_BYTES,
        "default_timeout_ms": DEFAULT_TIMEOUT_MS,
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
    return await _fetch_one(url, timeout_ms)
