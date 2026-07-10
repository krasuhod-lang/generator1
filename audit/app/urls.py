"""Нормализация URL (БАГФИКС #1 ТЗ).

Единая точка нормализации для краулера и фетчера:
    * убираем trailing slash (кроме корня "/") — /page/ == /page;
    * сортируем query-параметры (pg=2&cat=1 == cat=1&pg=2);
    * убираем fragment (#якорь) — не влияет на контент;
    * host — в lower case, дефолтные порты (80/443) отбрасываются.

Без этого краулер добавлял оба варианта /page/ и /page → двойное
сканирование и ложные duplicate_content.
"""

from __future__ import annotations

from typing import Optional
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit


def normalize_url(url: str) -> Optional[str]:
    """Каноническая форма URL. None — если URL не парсится/не http(s)."""
    try:
        parsed = urlsplit((url or "").strip())
    except Exception:
        return None
    if parsed.scheme not in ("http", "https"):
        return None
    host = (parsed.hostname or "").lower()
    if not host:
        return None
    netloc = host
    if parsed.port and parsed.port not in (80, 443):
        netloc = f"{host}:{parsed.port}"

    path = parsed.path or "/"
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/")

    query = ""
    if parsed.query:
        params = parse_qs(parsed.query, keep_blank_values=True)
        query = urlencode(sorted(params.items()), doseq=True)

    return urlunsplit((parsed.scheme, netloc, path, query, ""))
