import re

with open('relevance/app/parser.py', 'r', encoding='utf-8') as f:
    content = f.read()

# Fix _strip_high_link_density
old_link_density = """def _strip_high_link_density(soup: BeautifulSoup) -> None:
    \"\"\"Удаляет контейнеры (ul/ol/div/section), у которых доля текста внутри
    `<a>` превышает порог. Это эвристика Mozilla Readability — у меню,
    breadcrumb и related-блоков link density почти всегда > 60%.

    Чтобы не убить нормальные списки (например, навигация по статье — это
    тоже список ссылок, но короткий), требуем ещё минимум 80 символов
    суммарного текста: иначе блок проще оставить, риск удалить осмысленный
    короткий список выше, чем риск пропустить мини-меню.\"\"\"
    for tag_name in ("ul", "ol", "div", "section"):
        # копируем список — будем удалять во время итерации
        for el in list(soup.find_all(tag_name)):
            if el.attrs is None:
                continue
            text = el.get_text(" ", strip=True)
            n = len(text)
            if n < 80:
                continue
            anchor_chars = sum(
                len(a.get_text(" ", strip=True))
                for a in el.find_all("a")
            )
            if anchor_chars / max(n, 1) >= LINK_DENSITY_NOISE_RATIO:
                try:
                    el.decompose()
                except Exception:
                    pass"""

new_link_density = """def _strip_high_link_density(soup: BeautifulSoup) -> None:
    \"\"\"Удаляет контейнеры (ul/ol/div/section), у которых доля текста внутри
    `<a>` превышает порог. Это эвристика Mozilla Readability — у меню,
    breadcrumb и related-блоков link density почти всегда > 60%.

    Чтобы не убить нормальные списки (например, навигация по статье — это
    тоже список ссылок, но короткий), требуем ещё минимум 80 символов
    суммарного текста: иначе блок проще оставить, риск удалить осмысленный
    короткий список выше, чем риск пропустить мини-меню.\"\"\"
    for el in reversed(soup.find_all(["ul", "ol", "div", "section"])):
        if el.parent is None or el.attrs is None:
            continue
        text = el.get_text(" ", strip=True)
        n = len(text)
        if n < 80:
            continue
        anchor_chars = sum(
            len(a.get_text(" ", strip=True))
            for a in el.find_all("a")
        )
        if anchor_chars / max(n, 1) >= LINK_DENSITY_NOISE_RATIO:
            try:
                el.decompose()
            except Exception:
                pass"""

content = content.replace(old_link_density, new_link_density)

# Fix _collect_text_blocks
old_collect = """def _collect_text_blocks(soup: BeautifulSoup, tags: Tuple[str, ...]) -> List[str]:
    \"\"\"Собирает текстовые блоки из заданных тегов с дедупликацией по строке.\"\"\"
    seen: List[str] = []
    seen_set = set()
    for tag in soup.find_all(tags):
        text = tag.get_text(separator=" ", strip=True)
        text = re.sub(r"\s+", " ", text).strip()
        if len(text) < MIN_BLOCK_LEN_CHARS:
            continue
        if text in seen_set:
            continue
        seen_set.add(text)
        seen.append(text)
    return seen"""

new_collect = """def _collect_text_blocks(soup: BeautifulSoup, tags: Tuple[str, ...]) -> List[str]:
    \"\"\"Собирает текстовые блоки из заданных тегов с дедупликацией по DOM и строке.\"\"\"
    seen: List[str] = []
    seen_set = set()
    tag_set = set(tags)
    for tag in soup.find_all(tags):
        if any(p.name in tag_set for p in tag.parents):
            continue
        text = tag.get_text(separator=" ", strip=True)
        text = re.sub(r"\s+", " ", text).strip()
        if len(text) < MIN_BLOCK_LEN_CHARS:
            continue
        if text in seen_set:
            continue
        seen_set.add(text)
        seen.append(text)
    return seen"""

content = content.replace(old_collect, new_collect)

# Remove _strip_text_dups entirely and its usages
content = re.sub(r'def _strip_text_dups\(blocks: List\[str\]\) -> List\[str\]:\n(?:    .*\n)*    return accepted\n', '', content)
content = content.replace('blocks = _strip_text_dups(blocks)', '')
content = content.replace('return _strip_text_dups(blocks)', 'return blocks')

with open('relevance/app/parser.py', 'w', encoding='utf-8') as f:
    f.write(content)
