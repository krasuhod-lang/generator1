"""M1 Competitor Scraper — сбор ТОП-10 страниц и извлечение контента.

SERP: Serper API (приоритет) или SerpAPI.
Рендер JS-страниц: headless-fetcher (relevance_fetcher, Playwright + stealth)
как фолбэк, когда обычный requests не отдал контент.
Очистка HTML: BeautifulSoup — убираем шапку/футер/навигацию/формы/скрипты.
"""

from __future__ import annotations

import logging
import re
from typing import Dict, List, Optional
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup

from ..config import CONFIG

logger = logging.getLogger("gist_py.m1")

_STRIP_TAGS = [
    "script", "style", "noscript", "header", "footer", "nav", "aside",
    "form", "iframe", "svg", "button", "select", "input",
]

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)


def fetch_serp(keyword: str, top_n: Optional[int] = None) -> List[Dict]:
    """Получить органическую выдачу через Serper API или SerpAPI."""
    top_n = top_n or CONFIG["serp_top_n"]
    if CONFIG["serper_api_key"]:
        resp = requests.post(
            "https://google.serper.dev/search",
            headers={"X-API-KEY": CONFIG["serper_api_key"]},
            json={"q": keyword, "gl": "ru", "hl": "ru", "num": top_n + 10},
            timeout=30,
        )
        resp.raise_for_status()
        organic = resp.json().get("organic", [])
        return [
            {"url": r.get("link", ""), "title": r.get("title", "")}
            for r in organic
            if r.get("link")
        ]
    if CONFIG["serpapi_api_key"]:
        resp = requests.get(
            "https://serpapi.com/search.json",
            params={
                "q": keyword,
                "engine": "google",
                "gl": "ru",
                "hl": "ru",
                "num": top_n + 10,
                "api_key": CONFIG["serpapi_api_key"],
            },
            timeout=30,
        )
        resp.raise_for_status()
        organic = resp.json().get("organic_results", [])
        return [
            {"url": r.get("link", ""), "title": r.get("title", "")}
            for r in organic
            if r.get("link")
        ]
    raise RuntimeError("Не задан SERPER_API_KEY / SERPAPI_API_KEY")


def is_blocked_domain(url: str) -> bool:
    """Исключение агрегаторов-монстров по стоп-листу доменов."""
    host = (urlparse(url).hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    return any(host == d or host.endswith("." + d) for d in CONFIG["domain_stoplist"])


def _fetch_html(url: str) -> str:
    try:
        resp = requests.get(
            url, headers={"User-Agent": USER_AGENT}, timeout=30, allow_redirects=True
        )
        if resp.ok and len(resp.text) > 500:
            return resp.text
    except requests.RequestException as exc:
        logger.info("requests fetch failed for %s: %s", url, exc)
    # Фолбэк на headless-fetcher (Playwright), если страница SPA/за WAF
    try:
        resp = requests.post(
            CONFIG["headless_fetcher_url"], json={"url": url}, timeout=90
        )
        if resp.ok:
            data = resp.json()
            return data.get("html") or data.get("content") or ""
    except requests.RequestException as exc:
        logger.info("headless fetch failed for %s: %s", url, exc)
    return ""


def extract_page(html: str, url: str) -> Optional[Dict]:
    """Очистить HTML и извлечь title/h1/headings/body_text/word_count."""
    if not html:
        return None
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(_STRIP_TAGS):
        tag.decompose()
    # Убираем типовые обвязки по классам/ролям
    for el in soup.find_all(
        attrs={"role": re.compile(r"navigation|banner|contentinfo|search", re.I)}
    ):
        el.decompose()
    for el in soup.find_all(
        class_=re.compile(r"(?:^|\b)(?:menu|breadcrumb|sidebar|cookie|popup|modal|subscribe)", re.I)
    ):
        el.decompose()

    title = (soup.title.get_text(strip=True) if soup.title else "") or ""
    h1_el = soup.find("h1")
    h1 = h1_el.get_text(" ", strip=True) if h1_el else ""
    headings = [
        h.get_text(" ", strip=True)
        for h in soup.find_all(["h2", "h3"])
        if h.get_text(strip=True)
    ]
    main = soup.find("main") or soup.find("article") or soup.body or soup
    body_text = re.sub(r"\s+", " ", main.get_text(" ", strip=True))
    word_count = len(body_text.split())
    return {
        "url": url,
        "title": title,
        "h1": h1,
        "headings": headings,
        "body_text": body_text,
        "word_count": word_count,
    }


def scrape_competitors(keyword: str, top_n: Optional[int] = None) -> List[Dict]:
    """Полный проход M1: SERP → фильтры → контент ТОП-N страниц."""
    top_n = top_n or CONFIG["serp_top_n"]
    pages: List[Dict] = []
    for item in fetch_serp(keyword, top_n):
        if len(pages) >= top_n:
            break
        url = item["url"]
        if is_blocked_domain(url):
            logger.info("Стоп-лист домен, пропуск: %s", url)
            continue
        page = extract_page(_fetch_html(url), url)
        if not page:
            continue
        if page["word_count"] < CONFIG["min_word_count"]:
            logger.info("word_count < %s, пропуск: %s", CONFIG["min_word_count"], url)
            continue
        pages.append(page)
    return pages
