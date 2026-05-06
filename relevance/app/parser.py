"""HTML → clean text extractor.

Принцип: «мы берём 100% полезного текста со страницы».

1. BeautifulSoup чистит шум:
   * стоп-теги вырезаются полностью (script, style, nav, footer, …);
   * элементы с подозрительными class/id (menu, sidebar, cookie, ads, …)
     удаляются по регулярному выражению.
2. Текст собирается из расширенного набора структурных тегов
   (p, h1..h6, li, td, th, blockquote, dt, dd, figcaption, article,
   section, main, div, span). div/span включены, потому что современные
   сайты часто верстают абзацы через div — ранее мы теряли до 60-70%
   контента. Дедупликация по тексту убирает дубли от вложенных div.
3. Если очищенный текст оказался слишком коротким (< MIN_BODY_TEXT_CHARS),
   делаем второй заход через readability-lxml — иногда readability
   достаёт основной контент даже там, где BS4 видит «всё в одном div».
4. Если оба прохода вернули мало — отдаём наиболее длинный из двух
   результатов. Никаких отбрасываний «если меньше N» — берём всё.
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

# Из каких именно тегов собирать текст. Включаем div/span/article/section —
# современные сайты часто верстают абзацы через div, и без них мы теряли
# существенную часть контента. Дубли вложенных блоков убирает дедупликация
# по подстроке-родителю в _collect_text_blocks().
CONTENT_TAGS = (
    "p", "h1", "h2", "h3", "h4", "h5", "h6",
    "li", "td", "th",
    "blockquote", "dt", "dd", "figcaption", "caption", "summary",
    "article", "section", "main",
    "div", "span",
)

# Очень короткие куски (1-2 слова) — это, как правило, навигация / breadcrumb.
# Снижено с 8 до 4 — на современных сайтах одно-двухсловные подзаголовки и
# элементы списков тоже несут смысл (бренды, регионы, теги).
MIN_BLOCK_LEN_CHARS = 4

# Если после первого прохода BS4 текста меньше — пробуем readability как
# второй источник и берём максимум из двух.
MIN_BODY_TEXT_CHARS = 800


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


def _make_soup(html: str) -> BeautifulSoup:
    """lxml-парсер быстрее на больших страницах; html.parser как запасной."""
    try:
        return BeautifulSoup(html, "lxml")
    except Exception:
        return BeautifulSoup(html, "html.parser")


def _collect_text_blocks(soup: BeautifulSoup) -> List[str]:
    """Собирает текстовые блоки из CONTENT_TAGS с дедупликацией.

    Дедупликация важна потому, что при включении div/span один и тот же
    текст может встретиться 3-4 раза (вложенные обёртки). Алгоритм:
    идём от глубоких узлов к поверхностным, и если текст узла полностью
    совпадает с уже собранным блоком (или является его супер-строкой) —
    оставляем более длинную версию.
    """
    seen: List[str] = []
    seen_set = set()
    for tag in soup.find_all(CONTENT_TAGS):
        text = tag.get_text(separator=" ", strip=True)
        text = re.sub(r"\s+", " ", text).strip()
        if len(text) < MIN_BLOCK_LEN_CHARS:
            continue
        if text in seen_set:
            continue
        seen_set.add(text)
        seen.append(text)
    return seen


def _strip_text_dups(blocks: List[str]) -> List[str]:
    """Убирает блоки, которые целиком содержатся в более длинном соседе.

    Сортируем по длине убыв. и выкидываем те, чей текст уже встречается
    как подстрока в принятом длинном блоке. Это снимает дубли «div >
    div > p»: оставляем самый информативный (обычно самый длинный) узел.
    """
    if len(blocks) <= 1:
        return blocks
    accepted: List[str] = []
    for b in sorted(blocks, key=len, reverse=True):
        is_subset = False
        for a in accepted:
            # быстрая отсечка: если b короче a И b in a — выбрасываем
            if len(b) < len(a) and b in a:
                is_subset = True
                break
        if not is_subset:
            accepted.append(b)
    # сохраняем приблизительный исходный порядок (по позиции в blocks)
    order = {b: i for i, b in enumerate(blocks)}
    accepted.sort(key=lambda x: order.get(x, 1 << 30))
    return accepted


def extract_text_blocks(html: str) -> List[str]:
    """Возвращает список текстовых блоков (по одному на p/h*/li/div/…).

    Алгоритм: сначала чистим шум на полном документе, собираем все
    содержательные блоки. Если блоков мало (страница странная) — пробуем
    второй заход через readability и берём то, что длиннее.
    """
    if not html or not html.strip():
        return []

    # ── Pass 1: full body, минус шум, расширенный набор тегов ────────────
    soup_full = _make_soup(html)
    _strip_noise(soup_full)
    blocks_full = _collect_text_blocks(soup_full)
    blocks_full = _strip_text_dups(blocks_full)
    full_chars = sum(len(b) for b in blocks_full)

    # Если из полного дерева вытащили достаточно — используем как есть.
    # Это и есть «100% полезной информации».
    if full_chars >= MIN_BODY_TEXT_CHARS:
        return blocks_full

    # ── Pass 2: readability как fallback ────────────────────────────────
    try:
        main_html = _readability_main_html(html)
        soup_main = _make_soup(main_html)
        _strip_noise(soup_main)
        blocks_main = _collect_text_blocks(soup_main)
        blocks_main = _strip_text_dups(blocks_main)
        main_chars = sum(len(b) for b in blocks_main)
    except Exception:
        blocks_main = []
        main_chars = 0

    # Возвращаем максимум — даже короткий результат лучше пустого.
    return blocks_full if full_chars >= main_chars else blocks_main


def extract_full_text(html: str) -> str:
    """Удобная обёртка: один большой текст для документа целиком."""
    return "\n".join(extract_text_blocks(html))
