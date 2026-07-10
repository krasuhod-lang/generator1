"""Определение ошибок аудита (22+ проверки) и расчёт Health Score.

Чистые функции без I/O — легко тестировать. Каждая ошибка:
    { "code", "severity", "page_url", "context" }

Севериti и веса Health Score:
    critical → 10, high → 3, medium → 1, low → 0.3
    health_score = max(0, 100 - взвешенная сумма)
"""

from __future__ import annotations

from collections import defaultdict
from typing import Dict, List, Optional
from urllib.parse import urlsplit, urlunsplit

SEVERITY_WEIGHTS = {"critical": 10.0, "high": 3.0, "medium": 1.0, "low": 0.3}

# Код ошибки → (критичность, человекочитаемое описание для UI-подсказок)
ISSUE_DEFS: Dict[str, Dict[str, str]] = {
    "404_page":              {"severity": "critical", "title": "Страница 404",
                              "hint": "Страница отдаёт 404. Удалите ссылки на неё или восстановите контент/настройте 301-редирект."},
    "404_image":             {"severity": "high", "title": "Битое изображение (404)",
                              "hint": "Изображение недоступно. Исправьте src или загрузите файл."},
    "5xx_error":             {"severity": "critical", "title": "Ошибка сервера 5xx",
                              "hint": "Сервер вернул 5xx. Проверьте логи приложения/хостинг."},
    "redirect_chain":        {"severity": "medium", "title": "Цепочка редиректов",
                              "hint": "Более одного редиректа подряд. Ссылайтесь сразу на конечный URL."},
    "redirect_loop":         {"severity": "critical", "title": "Петля редиректов",
                              "hint": "URL встречается в цепочке дважды — бесконечный редирект. Исправьте правила."},
    "missing_title":         {"severity": "high", "title": "Отсутствует title",
                              "hint": "Добавьте уникальный тег <title> с ключевым запросом страницы."},
    "missing_description":   {"severity": "medium", "title": "Отсутствует description",
                              "hint": "Добавьте meta description 70–160 символов."},
    "missing_h1":            {"severity": "high", "title": "Отсутствует H1",
                              "hint": "Добавьте один заголовок H1, отражающий содержание страницы."},
    "duplicate_title":       {"severity": "high", "title": "Дубликат title",
                              "hint": "Title совпадает с другими страницами. Сделайте уникальным."},
    "duplicate_description": {"severity": "medium", "title": "Дубликат description",
                              "hint": "Description совпадает с другими страницами. Сделайте уникальным."},
    "title_too_long":        {"severity": "medium", "title": "Title слишком длинный",
                              "hint": "Более 70 символов — обрежется в выдаче. Сократите."},
    "title_too_short":       {"severity": "low", "title": "Title слишком короткий",
                              "hint": "Менее 30 символов — не использует потенциал сниппета."},
    "description_too_long":  {"severity": "medium", "title": "Description слишком длинный",
                              "hint": "Более 160 символов — обрежется в выдаче. Сократите."},
    "multiple_h1":           {"severity": "high", "title": "Несколько H1",
                              "hint": "На странице больше одного H1. Оставьте один."},
    "duplicate_content":     {"severity": "critical", "title": "Дубликат контента",
                              "hint": "Текст страницы полностью совпадает с другой. Настройте canonical или объедините страницы."},
    "mixed_content":         {"severity": "high", "title": "Mixed content (http на https)",
                              "hint": "HTTPS-страница грузит ресурсы по http:// — браузеры блокируют. Замените на https://."},
    "orphan_page":           {"severity": "high", "title": "Страница-сирота",
                              "hint": "URL есть в sitemap, но на него нет внутренних ссылок. Добавьте перелинковку."},
    "large_image":           {"severity": "medium", "title": "Тяжёлое изображение (>100KB)",
                              "hint": "Сожмите изображение (WebP/AVIF) — ускорит загрузку."},
    "missing_alt":           {"severity": "medium", "title": "Изображение без alt",
                              "hint": "Добавьте атрибут alt с описанием изображения."},
    "canonical_conflict":    {"severity": "high", "title": "Конфликт canonical",
                              "hint": "Canonical указывает на URL вне обхода — сигналы ранжирования уходят «в никуда»."},
    "noindex_in_sitemap":    {"severity": "critical", "title": "noindex в sitemap",
                              "hint": "Страница с noindex присутствует в sitemap. Уберите её из sitemap или снимите noindex."},
    "deep_page":             {"severity": "low", "title": "Глубокая страница (>4 кликов)",
                              "hint": "Страница дальше 4 кликов от главной — хуже краулится. Сократите вложенность."},
    "low_text_ratio":        {"severity": "medium", "title": "Низкий text/HTML ratio (<10%)",
                              "hint": "Мало текста относительно кода. Добавьте контент или облегчите разметку."},
}

TITLE_MAX_CHARS = 70
TITLE_MIN_CHARS = 30
DESCRIPTION_MAX_CHARS = 160
LARGE_IMAGE_BYTES = 102400  # 100 KB
DEEP_PAGE_DEPTH = 4
LOW_TEXT_RATIO = 0.10


def _issue(code: str, page_url: str, context: Optional[dict] = None) -> dict:
    return {
        "code": code,
        "severity": ISSUE_DEFS[code]["severity"],
        "page_url": page_url,
        "context": context or {},
    }


def _norm_url(u: str) -> str:
    """Нормализация URL для сравнения canonical: без фрагмента и trailing slash."""
    if not u:
        return ""
    try:
        parts = urlsplit(u.strip())
        path = parts.path or "/"
        if path != "/" and path.endswith("/"):
            path = path.rstrip("/")
        return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, parts.query, ""))
    except Exception:
        return u


def page_issues(page: dict) -> List[dict]:
    """Проверки по одной странице (без cross-page контекста)."""
    issues: List[dict] = []
    url = page.get("url", "")
    status = page.get("status_code")

    if status == 404:
        issues.append(_issue("404_page", url, {"status_code": status}))
    if status is not None and status >= 500:
        issues.append(_issue("5xx_error", url, {"status_code": status}))

    chain = page.get("redirect_chain") or []
    if len(chain) > 1:
        issues.append(_issue("redirect_chain", url, {"chain": chain}))
    if len(chain) != len(set(chain)):
        issues.append(_issue("redirect_loop", url, {"chain": chain}))

    # Контентные проверки имеют смысл только для успешно скачанных HTML.
    if status is None or status != 200 or not page.get("parsed"):
        return issues

    title = (page.get("title") or {}).get("text", "") or ""
    descr = (page.get("meta_description") or {}).get("text", "") or ""
    h1 = page.get("h1") or []

    if not title.strip():
        issues.append(_issue("missing_title", url))
    else:
        tlen = (page.get("title") or {}).get("length_chars", len(title))
        if tlen > TITLE_MAX_CHARS:
            issues.append(_issue("title_too_long", url, {"length_chars": tlen}))
        elif tlen < TITLE_MIN_CHARS:
            issues.append(_issue("title_too_short", url, {"length_chars": tlen}))

    if not descr.strip():
        issues.append(_issue("missing_description", url))
    else:
        dlen = (page.get("meta_description") or {}).get("length_chars", len(descr))
        if dlen > DESCRIPTION_MAX_CHARS:
            issues.append(_issue("description_too_long", url, {"length_chars": dlen}))

    if len(h1) == 0:
        issues.append(_issue("missing_h1", url))
    elif len(h1) > 1:
        issues.append(_issue("multiple_h1", url, {"count": len(h1), "texts": [x.get("text", "") for x in h1][:5]}))

    for mc in page.get("mixed_content") or []:
        issues.append(_issue("mixed_content", url, mc))

    for img in page.get("images") or []:
        alt = img.get("alt")
        if alt is None or str(alt).strip() == "":
            issues.append(_issue("missing_alt", url, {"src": img.get("src")}))
        size = img.get("size_bytes")
        if size is not None and size > LARGE_IMAGE_BYTES:
            issues.append(_issue("large_image", url, {"src": img.get("src"), "size_bytes": size}))
        if img.get("status_code") == 404:
            issues.append(_issue("404_image", url, {"src": img.get("src")}))

    depth = page.get("crawl_depth")
    if depth is not None and depth > DEEP_PAGE_DEPTH:
        issues.append(_issue("deep_page", url, {"crawl_depth": depth}))

    ratio = page.get("text_html_ratio")
    if ratio is not None and ratio < LOW_TEXT_RATIO:
        issues.append(_issue("low_text_ratio", url, {"text_html_ratio": ratio}))

    return issues


def find_duplicate_content(pages: dict) -> Dict[str, List[str]]:
    """content_hash → [urls] для хешей, встречающихся у >1 URL."""
    hash_map = defaultdict(list)
    for url, data in pages.items():
        h = data.get("content_hash")
        if h and data.get("status_code") == 200:
            hash_map[h].append(url)
    return {h: urls for h, urls in hash_map.items() if len(urls) > 1}


def find_orphan_pages(sitemap_urls: set, bfs_urls: set) -> List[str]:
    """URL есть в sitemap, но не найден BFS-обходом."""
    return sorted(sitemap_urls - bfs_urls)


def site_issues(pages: dict, sitemap_urls: set) -> List[dict]:
    """Cross-page проверки: дубли title/description/контента, canonical,
    noindex-in-sitemap, сироты."""
    issues: List[dict] = []
    crawled = {u for u, p in pages.items() if p.get("status_code") is not None}
    norm_crawled = {_norm_url(u) for u in crawled}

    # Дубли title / description
    title_map = defaultdict(list)
    descr_map = defaultdict(list)
    for url, p in pages.items():
        if p.get("status_code") != 200 or not p.get("parsed"):
            continue
        t = ((p.get("title") or {}).get("text") or "").strip().lower()
        d = ((p.get("meta_description") or {}).get("text") or "").strip().lower()
        if t:
            title_map[t].append(url)
        if d:
            descr_map[d].append(url)
    for t, urls in title_map.items():
        if len(urls) > 1:
            for u in urls:
                issues.append(_issue("duplicate_title", u, {"duplicates": [x for x in urls if x != u][:20]}))
    for d, urls in descr_map.items():
        if len(urls) > 1:
            for u in urls:
                issues.append(_issue("duplicate_description", u, {"duplicates": [x for x in urls if x != u][:20]}))

    # Дубли контента
    for h, urls in find_duplicate_content(pages).items():
        for u in urls:
            issues.append(_issue("duplicate_content", u, {"content_hash": h, "duplicates": [x for x in urls if x != u][:20]}))

    # canonical_conflict + noindex_in_sitemap
    norm_sitemap = {_norm_url(u) for u in sitemap_urls}
    for url, p in pages.items():
        if p.get("status_code") != 200 or not p.get("parsed"):
            continue
        idx = p.get("indexability") or {}
        canonical = idx.get("canonical")
        if canonical and _norm_url(canonical) != _norm_url(url) and _norm_url(canonical) not in norm_crawled:
            issues.append(_issue("canonical_conflict", url, {"canonical": canonical}))
        robots = (idx.get("meta_robots") or "").lower()
        if "noindex" in robots and _norm_url(url) in norm_sitemap:
            issues.append(_issue("noindex_in_sitemap", url, {"meta_robots": idx.get("meta_robots")}))

    # Сироты
    for u in find_orphan_pages(norm_sitemap, {_norm_url(x) for x in pages.keys()}):
        issues.append(_issue("orphan_page", u))

    return issues


def summarize(issues: List[dict], total_pages: int) -> dict:
    counts = {"critical": 0, "high": 0, "medium": 0, "low": 0}
    for it in issues:
        sev = it.get("severity")
        if sev in counts:
            counts[sev] += 1
    score = 100.0
    for sev, n in counts.items():
        score -= SEVERITY_WEIGHTS[sev] * n
    return {
        "total_pages": total_pages,
        "issues_critical": counts["critical"],
        "issues_high": counts["high"],
        "issues_medium": counts["medium"],
        "issues_low": counts["low"],
        "health_score": max(0, round(score)),
    }
