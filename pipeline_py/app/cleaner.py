"""Слой 3 — Очиститель HTML.

Удаляет служебные теги и «шум» (script/style/nav/footer/header/aside/forms и
пр.), приводит документ к чистому тексту, пригодному для LLM-анализа (Слой 4).
Возвращает как основной текст, так и заголовок страницы.

Реализация — на BeautifulSoup (уже используется в других сервисах репозитория);
при отсутствии lxml используется встроенный парсер ``html.parser``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List

from bs4 import BeautifulSoup

# Теги, содержимое которых не несёт полезного контента.
_NOISE_TAGS = (
    "script",
    "style",
    "noscript",
    "template",
    "svg",
    "iframe",
    "nav",
    "footer",
    "header",
    "aside",
    "form",
    "button",
    "input",
    "select",
    "option",
)

_WS_RE = re.compile(r"[ \t\r\f\v]+")
_MULTI_NL_RE = re.compile(r"\n{3,}")


@dataclass
class CleanResult:
    """Результат очистки HTML."""

    title: str
    text: str

    @property
    def is_empty(self) -> bool:
        return not self.text.strip()


def _pick_parser() -> str:
    try:  # pragma: no cover - зависит от окружения
        import lxml  # noqa: F401

        return "lxml"
    except ImportError:  # pragma: no cover
        return "html.parser"


def clean_html(html: str) -> CleanResult:
    """Очистить HTML: убрать шумовые теги, вернуть заголовок и текст."""
    if not html or not html.strip():
        return CleanResult(title="", text="")

    soup = BeautifulSoup(html, _pick_parser())

    # Заголовок берём до удаления <head>.
    title = ""
    if soup.title and soup.title.string:
        title = soup.title.string.strip()

    # Комментарии.
    from bs4 import Comment

    for comment in soup.find_all(string=lambda t: isinstance(t, Comment)):
        comment.extract()

    # Шумовые теги вместе с содержимым.
    for tag in soup.find_all(_NOISE_TAGS):
        tag.decompose()

    # Предпочитаем основной контент, если он размечен.
    root = soup.find("article") or soup.find("main") or soup.body or soup

    text = root.get_text(separator="\n")
    text = _normalize_text(text)
    return CleanResult(title=title, text=text)


def _normalize_text(text: str) -> str:
    lines: List[str] = []
    for line in text.split("\n"):
        collapsed = _WS_RE.sub(" ", line).strip()
        lines.append(collapsed)
    joined = "\n".join(lines)
    joined = _MULTI_NL_RE.sub("\n\n", joined)
    return joined.strip()


__all__ = ["CleanResult", "clean_html"]
