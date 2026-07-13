"""HTTP-фетчер аудита: aiohttp с ручным следованием редиректам + эскалация.

Стратегия (ТЗ 5.2):
    1. aiohttp с ротацией User-Agent из реального пула (Chrome 124+/Firefox
       126+/Safari 17+), allow_redirects=False — вручную собираем redirect_chain.
    2. Если тело пустое / 403 / похоже на антибот-заглушку — эскалация к
       relevance_fetcher POST /fetch_html { auto_escalate: true }
       (curl_cffi → Playwright + stealth). Переиспользуем существующий
       микросервис вместо дублирования Chromium в этом контейнере.

env:
    AUDIT_HEADLESS_FETCHER_URL   (default http://relevance_fetcher:8001/fetch_html)
    RELEVANCE_INTERNAL_TOKEN     (общий внутренний токен)
"""

from __future__ import annotations

import asyncio
import logging
import os
import random
import time
from typing import Optional

import aiohttp

from .urls import normalize_url

logger = logging.getLogger("audit.fetcher")

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
]

DEFAULT_TIMEOUT_S = float(os.getenv("AUDIT_FETCH_TIMEOUT_S", "30"))
MAX_REDIRECTS = 10
MAX_BODY_BYTES = int(os.getenv("AUDIT_MAX_BODY_BYTES", str(8 * 1024 * 1024)))  # 8 МБ

# ТЗ 6: гранулярный таймаут — total на весь запрос, connect на установку
# соединения, sock_read на чтение, чтобы медленный сервер/антибот не завесил
# волну asyncio.gather.
FETCH_TIMEOUT = aiohttp.ClientTimeout(total=DEFAULT_TIMEOUT_S, connect=10, sock_read=20)

HEADLESS_URL = (os.getenv("AUDIT_HEADLESS_FETCHER_URL")
                or "http://relevance_fetcher:8001/fetch_html").strip()
INTERNAL_TOKEN = (os.getenv("RELEVANCE_INTERNAL_TOKEN") or "").strip()

_BLOCK_MARKERS = (
    "cf-challenge", "cf_chl_", "cloudflare", "captcha", "ddos-guard",
    "checking your browser", "attention required", "just a moment",
)

# ── SSRF guard ────────────────────────────────────────────────────────────────
# Краулер ходит по ссылкам/редиректам, найденным на чужих страницах, поэтому
# каждый host резолвим и отсекаем приватные диапазоны (зеркало Node-версии
# services/siteCrawler/ssrfGuard.js). Кеш — на процесс.
import ipaddress
import socket

_ssrf_cache: dict = {}


async def assert_public_host(url: str) -> bool:
    """True если host публичный; False (блок) для приватных/локальных адресов."""
    host = (urlsplit_host(url) or "").lower()
    if not host:
        return False
    cached = _ssrf_cache.get(host)
    if cached is not None:
        return cached
    ok = False
    try:
        loop = asyncio.get_running_loop()
        infos = await loop.getaddrinfo(host, None, type=socket.SOCK_STREAM)
        ips = {info[4][0] for info in infos}
        ok = bool(ips) and all(not _is_private_ip(ip) for ip in ips)
    except Exception:
        ok = False
    if len(_ssrf_cache) < 10000:
        _ssrf_cache[host] = ok
    return ok


def _is_private_ip(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip.split("%")[0])
        return (addr.is_private or addr.is_loopback or addr.is_link_local
                or addr.is_reserved or addr.is_multicast or addr.is_unspecified)
    except ValueError:
        return True


def urlsplit_host(url: str):
    from urllib.parse import urlsplit
    try:
        return urlsplit(url).hostname
    except Exception:
        return None


def _headers() -> dict:
    return {
        "User-Agent": random.choice(USER_AGENTS),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
    }


def looks_blocked(html: str, status: int) -> bool:
    if status in (403, 429, 503):
        return True
    if not html or len(html) < 400:
        return True
    low = html[:5000].lower()
    return any(m in low for m in _BLOCK_MARKERS)


class FetchResult:
    __slots__ = ("url", "final_url", "status_code", "html", "response_time_ms",
                 "content_size_bytes", "redirect_chain", "error", "method",
                 "fetch_status")

    def __init__(self, url: str):
        self.url = url
        self.final_url = url
        self.status_code: Optional[int] = None
        self.html: str = ""
        self.response_time_ms: Optional[int] = None
        self.content_size_bytes: Optional[int] = None
        self.redirect_chain: list = []
        self.error: Optional[str] = None
        self.method: str = "aiohttp"
        self.fetch_status: str = "ok"  # ok|timeout|connection_error|error|ssrf_blocked


async def fetch_page(session: aiohttp.ClientSession, url: str,
                     use_playwright: bool = False) -> FetchResult:
    """Скачивает страницу с ручным следованием редиректам.

    use_playwright=True — сразу эскалируем к headless-фетчеру (форс-режим из
    настроек аудита), иначе headless только при блокировке/пустом теле.
    """
    res = FetchResult(url)
    if not await assert_public_host(url):
        res.error = "ssrf_blocked"
        res.fetch_status = "ssrf_blocked"
        return res
    if use_playwright:
        ok = await _fetch_headless(res, url)
        if ok:
            return res

    started = time.monotonic()
    current = url
    try:
        for _hop in range(MAX_REDIRECTS + 1):
            async with session.get(
                current,
                headers=_headers(),
                allow_redirects=False,
                timeout=FETCH_TIMEOUT,
            ) as resp:
                res.status_code = resp.status
                if resp.status in (301, 302, 303, 307, 308):
                    loc = resp.headers.get("Location")
                    if not loc:
                        break
                    try:
                        from yarl import URL as _YURL
                        nxt = str(_YURL(current).join(_YURL(loc)))
                    except Exception:
                        nxt = loc
                    # БАГФИКС #1+#4: нормализуем цель редиректа, чтобы
                    # /page/ и /page не считались разными хопами.
                    nxt = normalize_url(nxt) or nxt
                    res.redirect_chain.append({"url": current, "status": resp.status})
                    if any(h["url"] == nxt for h in res.redirect_chain):
                        # петля: фиксируем дубликат в цепочке и выходим
                        res.redirect_chain.append({"url": nxt, "status": None})
                        break
                    if not await assert_public_host(nxt):
                        res.error = "ssrf_blocked_redirect"
                        break
                    current = nxt
                    continue
                body = await resp.content.read(MAX_BODY_BYTES + 1)
                if len(body) > MAX_BODY_BYTES:
                    body = body[:MAX_BODY_BYTES]
                ctype = (resp.headers.get("Content-Type") or "").lower()
                if "html" in ctype or not ctype:
                    charset = resp.charset or "utf-8"
                    try:
                        res.html = body.decode(charset, errors="replace")
                    except Exception:
                        res.html = body.decode("utf-8", errors="replace")
                res.content_size_bytes = len(body)
                res.final_url = current
                break
    except asyncio.TimeoutError:
        res.error = "timeout"
        res.fetch_status = "timeout"
    except aiohttp.ClientError as e:
        res.error = f"client_error: {e.__class__.__name__}"
        res.fetch_status = "connection_error"
    except Exception as e:  # pragma: no cover
        res.error = f"error: {e.__class__.__name__}"
        res.fetch_status = "error"
    res.response_time_ms = int((time.monotonic() - started) * 1000)

    # Эскалация: пустой body / 403 / антибот-заглушка → headless-фетчер
    if not use_playwright and (res.error or looks_blocked(res.html, res.status_code or 0)) \
            and (res.status_code is None or res.status_code < 500 or res.status_code in (503,)):
        await _fetch_headless(res, url)
    return res


async def _fetch_headless(res: FetchResult, url: str) -> bool:
    """POST /fetch_html к relevance_fetcher (curl_cffi → Playwright)."""
    if not HEADLESS_URL:
        return False
    headers = {"Content-Type": "application/json"}
    if INTERNAL_TOKEN:
        headers["X-Internal-Token"] = INTERNAL_TOKEN
    started = time.monotonic()
    try:
        timeout = aiohttp.ClientTimeout(total=60)
        async with aiohttp.ClientSession(timeout=timeout) as s:
            async with s.post(HEADLESS_URL, json={"url": url, "auto_escalate": True},
                              headers=headers) as resp:
                if resp.status != 200:
                    return False
                data = await resp.json(content_type=None)
    except Exception as e:
        logger.debug("headless fetch failed for %s: %s", url, e)
        return False
    html = (data or {}).get("html") or ""
    if not html:
        return False
    res.html = html[: MAX_BODY_BYTES]
    res.status_code = int((data or {}).get("status") or 200)
    res.final_url = (data or {}).get("final_url") or url
    res.content_size_bytes = len(res.html.encode("utf-8"))
    res.response_time_ms = int((time.monotonic() - started) * 1000)
    res.method = (data or {}).get("method") or "headless"
    res.error = None
    res.fetch_status = "ok"
    return True


async def head_request(session: aiohttp.ClientSession, url: str) -> dict:
    """HEAD-запрос для изображения: Content-Length + status. Никогда не GET."""
    out = {"status_code": None, "size_bytes": None}
    if not await assert_public_host(url):
        return out
    try:
        async with session.head(
            url, headers=_headers(), allow_redirects=True,
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            out["status_code"] = resp.status
            cl = resp.headers.get("Content-Length")
            if cl and cl.isdigit():
                out["size_bytes"] = int(cl)
    except Exception:
        pass
    return out
