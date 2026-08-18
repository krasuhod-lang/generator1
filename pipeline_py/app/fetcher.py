"""Слой 2 — Fetcher (загрузка страниц).

Тонкий HTTP-клиент к сервису ``relevance_fetcher`` (endpoint ``/fetch_html``),
который реализует обход анти-бот защит (TLS-fingerprint, JS-рендеринг) —
подробности в его README (раздел 3 ТЗ). Здесь мы не дублируем логику загрузки,
а лишь обращаемся к готовому сервису и приводим ответ к :class:`FetchResult`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import requests


@dataclass
class FetchResult:
    """Результат загрузки страницы."""

    success: bool
    url: str
    status_code: Optional[int]
    html: str
    engine_used: Optional[str] = None
    error_msg: Optional[str] = None
    blocked: bool = False


# HTTP-статусы, трактуемые как блокировка (WAF / rate-limit / недоступность).
_BLOCK_STATUSES = frozenset({403, 429, 503})


class Fetcher:
    """Клиент ``relevance_fetcher``.

    Параметры берутся из :data:`app.config.CONFIG`, но могут быть переопределены
    в конструкторе (удобно для тестов через ``session``-заглушку).
    """

    def __init__(
        self,
        base_url: str,
        timeout_ms: int = 20000,
        use_js_render: bool = False,
        auto_escalate: bool = True,
        internal_token: str = "",
        session: Optional[requests.Session] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_ms = timeout_ms
        self.use_js_render = use_js_render
        self.auto_escalate = auto_escalate
        self.internal_token = internal_token
        self._session = session or requests.Session()

    def fetch(self, url: str, proxy: Optional[str] = None) -> FetchResult:
        payload = {
            "url": url,
            "use_js_render": self.use_js_render,
            "auto_escalate": self.auto_escalate and not self.use_js_render,
            "timeout_ms": self.timeout_ms,
        }
        if proxy:
            payload["proxy"] = proxy
        headers = {}
        if self.internal_token:
            headers["X-Internal-Token"] = self.internal_token

        # Даём HTTP-клиенту запас поверх серверного таймаута попытки.
        http_timeout = self.timeout_ms / 1000 + 10
        try:
            resp = self._session.post(
                f"{self.base_url}/fetch_html",
                json=payload,
                headers=headers,
                timeout=http_timeout,
            )
        except requests.RequestException as exc:
            return FetchResult(
                success=False,
                url=url,
                status_code=None,
                html="",
                error_msg=f"fetcher request failed: {exc}",
                blocked=False,
            )

        try:
            data = resp.json()
        except ValueError:
            return FetchResult(
                success=False,
                url=url,
                status_code=resp.status_code,
                html="",
                error_msg="fetcher returned non-JSON response",
                blocked=resp.status_code in _BLOCK_STATUSES,
            )

        status_code = data.get("status_code")
        blocked = status_code in _BLOCK_STATUSES if status_code is not None else False
        return FetchResult(
            success=bool(data.get("success")),
            url=data.get("url", url),
            status_code=status_code,
            html=data.get("html") or "",
            engine_used=data.get("engine_used"),
            error_msg=data.get("error_msg"),
            blocked=blocked,
        )


__all__ = ["Fetcher", "FetchResult"]
