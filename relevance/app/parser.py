"""HTML → clean text extractor.

1. readability-lxml извлекает основной контент (article / content area).
2. BeautifulSoup чистит шум:
   * стоп-теги вырезаются полностью (script, style, nav, footer, …);
   * элементы с подозрительными class/id (menu, sidebar, cookie, ads, …)
     удаляются по регулярному выражению.
3. Текст собирается ТОЛЬКО из p, h1..h6, li, td, th. div/span намеренно
   не используются как структурные блоки — они дают много мусора.
"""

from __future__ import annotations

import re
from typing import List

from bs4 import BeautifulSoup
from readability import Document

# Структурные теги, которые гарантированно являются "шумом" (навигация,
# подвалы, скрипты, формы, виджеты, иконки). Удаляются полностью.
NOISE_TAGS = (
    "script", "style", "noscript",
    "nav", "footer", "header", "aside",
    "form", "iframe", "svg", "canvas",
    "button", "dialog", "template",
)

# RegExp по class и id (case-insensitive). Любой элемент, у которого
# встречается одно из ключевых слов, вырезается вместе с детьми.
NOISE_CLASS_ID_RE = re.compile(
    r"(menu|nav|footer|header|sidebar|cookie|modal|popup|"
    r"banner|ads|comment|promo|widget|social)",
    re.IGNORECASE,
)

# Из каких именно тегов собирать текст. div/span — нет, чтобы не цеплять
# обвязку. Текст внутри <p><span>…</span></p> всё равно вытащится через
# get_text() на уровне <p>.
CONTENT_TAGS = ("p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "td", "th")

# Очень короткие куски (1-2 слова) — это, как правило, навигация / breadcrumb.
MIN_BLOCK_LEN_CHARS = 8


def _strip_noise(soup: BeautifulSoup) -> None:
    """Удаляет шумовые теги и элементы с class/id, попадающими под NOISE_CLASS_ID_RE."""
    for tag_name in NOISE_TAGS:
        for el in soup.find_all(tag_name):
            el.decompose()

    # Поиск по class
    for el in soup.find_all(class_=True):
        classes = el.get("class") or []
        joined = " ".join(classes) if isinstance(classes, list) else str(classes)
        if NOISE_CLASS_ID_RE.search(joined):
            el.decompose()

    # Поиск по id
    for el in soup.find_all(id=True):
        el_id = el.get("id") or ""
        if isinstance(el_id, list):
            el_id = " ".join(el_id)
        if NOISE_CLASS_ID_RE.search(str(el_id)):
            el.decompose()


def _readability_main_html(html: str) -> str:
    """Возвращает HTML основного контента по readability. При сбое — исходный HTML."""
    try:
        # Document парсит html и выделяет «основной текст»
        return Document(html).summary(html_partial=True) or html
    except Exception:
        # readability крайне толерантен к мусору, но на пустых/битых страницах
        # может бросить — fallback на исходник.
        return html


def extract_text_blocks(html: str) -> List[str]:
    """Возвращает список текстовых блоков (по одному на p/h*/li/td/th)."""
    if not html or not html.strip():
        return []

    main_html = _readability_main_html(html)

    # lxml-парсер быстрее на больших страницах; html.parser как запасной
    try:
        soup = BeautifulSoup(main_html, "lxml")
    except Exception:
        soup = BeautifulSoup(main_html, "html.parser")

    _strip_noise(soup)

    blocks: List[str] = []
    for tag in soup.find_all(CONTENT_TAGS):
        text = tag.get_text(separator=" ", strip=True)
        # Сжимаем все whitespace последовательности в один пробел
        text = re.sub(r"\s+", " ", text).strip()
        if len(text) >= MIN_BLOCK_LEN_CHARS:
            blocks.append(text)

    return blocks


def extract_full_text(html: str) -> str:
    """Удобная обёртка: один большой текст для документа целиком."""
    return "\n".join(extract_text_blocks(html))
