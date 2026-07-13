"""Извлечение контентных метрик страницы: BS4 + trafilatura (+ readability fallback).

Возвращает словарь с полями по ТЗ (3.2 контентные параметры, 3.3 ссылочный граф,
mixed content). Никакого I/O — только парсинг переданного HTML.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, Optional
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup

logger = logging.getLogger("audit.parser")

try:
    import trafilatura
    _TRAFILATURA = True
except Exception:  # pragma: no cover
    trafilatura = None  # type: ignore[assignment]
    _TRAFILATURA = False

try:
    from readability import Document as _ReadabilityDocument
    _READABILITY = True
except Exception:  # pragma: no cover
    _ReadabilityDocument = None  # type: ignore[assignment]
    _READABILITY = False

# Приближение ширины сниппета: символ ≈ 7.5px в шрифте выдачи Google.
PX_PER_CHAR = 7.5

_MIXED_SELECTORS = [("img", "src"), ("script", "src"), ("link", "href"),
                    ("iframe", "src"), ("audio", "src"), ("video", "src")]

_SKIP_SCHEMES = ("mailto:", "tel:", "javascript:", "data:", "#")

# БАГФИКС #2: порог «полноценного текста». trafilatura возвращает пустую
# строку для страниц-листингов (/services/, /blog/) — MD5 от пустоты совпадал
# на десятках страниц и весь сайт помечался дублем.
MIN_TEXT_LEN = 150

# ТЗ 5: каскад trafilatura → readability → BS4 может зависнуть на невалидном
# или огромном HTML и заблокировать всю волну asyncio.gather. Парсим в пуле
# потоков с жёстким таймаутом.
PARSE_TIMEOUT_S = 10.0
_executor = ThreadPoolExecutor(max_workers=4)


async def parse_page_async(url: str, html: str) -> Optional[dict]:
    """parse_page в ThreadPoolExecutor с таймаутом (ТЗ 5).

    None при таймауте — страница остаётся parsed=False, но не блокирует волну."""
    loop = asyncio.get_running_loop()
    try:
        return await asyncio.wait_for(
            loop.run_in_executor(_executor, parse_page, url, html),
            timeout=PARSE_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        logger.warning("parse timeout (>%ss) for %s", PARSE_TIMEOUT_S, url)
        return None


def get_content_hash(raw_html: str, clean_text: str) -> dict:
    """Умный хеш контента (БАГФИКС #2).

    text_len >= 150 — хеш нормализованного текста (type=text_content);
    иначе (листинг/пустая страница) — хеш HTML-структуры без
    script/style/svg (type=html_structure). duplicate_content считается
    только для type == "text_content".
    """
    text_len = len((clean_text or "").strip())

    if text_len < MIN_TEXT_LEN:
        stripped = re.sub(
            r"<(script|style|svg)[^>]*>.*?</\1>",
            "", raw_html or "", flags=re.DOTALL | re.IGNORECASE,
        )
        stripped = re.sub(r"\s+", " ", stripped).strip()
        h = hashlib.md5(stripped.encode("utf-8"), usedforsecurity=False).hexdigest() if stripped else None
        return {"hash": h, "type": "html_structure", "text_len": text_len}

    normalized = re.sub(r"\s+", " ", clean_text.strip().lower())
    h = hashlib.md5(normalized.encode("utf-8"), usedforsecurity=False).hexdigest()
    return {"hash": h, "type": "text_content", "text_len": text_len}


def _clean_text(html: str, soup: BeautifulSoup) -> str:
    """trafilatura → readability-lxml → BS4 get_text() (последний рубеж)."""
    if _TRAFILATURA:
        try:
            txt = trafilatura.extract(html, include_comments=False, include_tables=True)
            if txt and len(txt) > 100:
                return txt
        except Exception as e:  # pragma: no cover
            logger.debug("trafilatura failed: %s", e)
    if _READABILITY:
        try:
            doc = _ReadabilityDocument(html)
            summary = doc.summary(html_partial=True)
            txt = BeautifulSoup(summary, "lxml").get_text(" ", strip=True)
            if txt and len(txt) > 100:
                return txt
        except Exception as e:  # pragma: no cover
            logger.debug("readability failed: %s", e)
    try:
        for tag in soup(["script", "style", "noscript", "template"]):
            tag.extract()
        return soup.get_text(" ", strip=True)
    except Exception:  # pragma: no cover
        return ""


def _same_domain(url: str, base_host: str) -> bool:
    try:
        host = urlsplit(url).hostname or ""
        host = host.lower().lstrip("www.")
        return host == base_host or host.endswith("." + base_host)
    except Exception:
        return False


def base_hostname(url: str) -> str:
    host = (urlsplit(url).hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


def check_mixed_content(soup: BeautifulSoup, page_url: str) -> List[dict]:
    if not page_url.startswith("https://"):
        return []
    found = []
    for tag, attr in _MIXED_SELECTORS:
        for el in soup.find_all(tag, **{attr: True}):
            val = el.get(attr, "")
            if isinstance(val, str) and val.startswith("http://"):
                found.append({"tag": tag, "url": val[:500]})
    return found


def parse_page(url: str, html: str) -> dict:
    """Полный разбор HTML страницы → контентные метрики + ссылки + изображения."""
    soup = BeautifulSoup(html or "", "lxml")

    title_text = ""
    if soup.title and soup.title.string:
        title_text = re.sub(r"\s+", " ", soup.title.string).strip()

    descr_text = ""
    md = soup.find("meta", attrs={"name": re.compile(r"^description$", re.I)})
    if md and md.get("content"):
        descr_text = re.sub(r"\s+", " ", md["content"]).strip()

    h1 = [{"text": re.sub(r"\s+", " ", h.get_text(" ", strip=True))[:300]}
          for h in soup.find_all("h1")]
    h2 = [{"text": re.sub(r"\s+", " ", h.get_text(" ", strip=True))[:300]}
          for h in soup.find_all("h2")]

    # Indexability
    robots_meta = soup.find("meta", attrs={"name": re.compile(r"^robots$", re.I)})
    meta_robots = (robots_meta.get("content") or "").strip() if robots_meta else None
    canonical_link = soup.find("link", rel=lambda v: v and "canonical" in v)
    canonical = None
    if canonical_link and canonical_link.get("href"):
        canonical = urljoin(url, canonical_link["href"].strip())

    hreflang = []
    for link in soup.find_all("link", rel=lambda v: v and "alternate" in v):
        lang = link.get("hreflang")
        href = link.get("href")
        if lang and href:
            hreflang.append({"lang": lang, "url": urljoin(url, href.strip())})

    # Mixed content
    mixed = check_mixed_content(soup, url)

    # Ссылки
    base_host = base_hostname(url)
    outl_int: List[str] = []
    outl_ext: List[str] = []
    anchors: List[dict] = []
    seen_int, seen_ext = set(), set()
    for a in soup.find_all("a", href=True):
        href = (a.get("href") or "").strip()
        if not href or href.lower().startswith(_SKIP_SCHEMES):
            continue
        absu = urljoin(url, href)
        parts = urlsplit(absu)
        if parts.scheme not in ("http", "https"):
            continue
        absu = absu.split("#", 1)[0]
        if not absu:
            continue
        rel = a.get("rel") or ["dofollow"]
        if isinstance(rel, str):
            rel = [rel]
        anchors.append({
            "url": absu,
            "text": re.sub(r"\s+", " ", a.get_text(" ", strip=True))[:200],
            "rel": "nofollow" if "nofollow" in [r.lower() for r in rel] else "dofollow",
        })
        if _same_domain(absu, base_host):
            if absu not in seen_int:
                seen_int.add(absu)
                outl_int.append(absu)
        else:
            if absu not in seen_ext:
                seen_ext.add(absu)
                outl_ext.append(absu)

    # Изображения (size/status добираются HEAD-запросами в краулере)
    images: List[dict] = []
    seen_img = set()
    for img in soup.find_all("img"):
        src = (img.get("src") or "").strip()
        if not src or src.lower().startswith(("data:", "javascript:")):
            continue
        absu = urljoin(url, src)
        if absu in seen_img:
            continue
        seen_img.add(absu)
        images.append({
            "src": absu,
            "alt": img.get("alt"),
            "size_bytes": None,
            "status_code": None,
        })

    # Чистый текст и производные метрики
    clean = _clean_text(html or "", soup) or ""
    raw_len = len((html or "").encode("utf-8")) or 1
    clean_bytes = clean.encode("utf-8")
    # БАГФИКС #2: умный хеш с порогом MIN_TEXT_LEN (MD5 — только дедупликация).
    ch = get_content_hash(html or "", clean)

    return {
        "parsed": True,
        "title": {
            "text": title_text,
            "length_chars": len(title_text),
            "length_px": round(len(title_text) * PX_PER_CHAR),
        },
        "meta_description": {
            "text": descr_text,
            "length_chars": len(descr_text),
            "length_px": round(len(descr_text) * PX_PER_CHAR),
        },
        "h1": h1,
        "h2": h2,
        "word_count": len(clean.split()),
        "text_html_ratio": round(len(clean_bytes) / raw_len, 4),
        # MD5 — только для дедупликации контента (не криптография).
        "content_hash": ch["hash"],
        "content_hash_type": ch["type"],
        "clean_text_len": ch["text_len"],
        "indexability": {
            "meta_robots": meta_robots,
            "canonical": canonical,
        },
        "hreflang": hreflang[:50],
        "mixed_content": mixed[:100],
        "outlinks_internal": outl_int,
        "outlinks_external": outl_ext[:200],
        "anchors": anchors[:500],
        "images": images[:200],
    }
