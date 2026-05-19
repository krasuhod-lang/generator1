"""HTML → clean text extractor.

Принципы (после регресса PR #90 «80% сайтов перестали парситься»):

1. **Двухуровневая логика**. Сначала собираем текст только из «жирных»
   контентных тегов (`p`, `h1..h6`, `li`, `blockquote`, `article`,
   `section`, `main`, `td`, `th`, `dl/dt/dd`, `figcaption`). Если их
   суммарно ≥ ``HEAVY_TAGS_MIN_CHARS`` (по умолчанию 800), считаем
   страницу нормально размеченной и возвращаем именно их. Это убирает
   мусор от навигации/фильтров на сайтах с обильным `<div>`/`<span>`
   layout'ом (раньше div/span в первом проходе всегда давали > 800
   символов — fallback на readability/trafilatura не запускался).

2. **Параллельный прогон trafilatura**. trafilatura — лучший открытый
   экстрактор для русскоязычного web (f1 ~0.92 vs ~0.70 у readability).
   Гоняем его одновременно с BS4-проходом и берём наиболее качественный
   результат: при сравнимых длинах предпочитаем тот, у которого выше
   text/HTML ratio (= меньше boilerplate'а). Если оба не дали > 200
   символов — fallback на readability-lxml; если и он молчит — расширяем
   зону до `div`/`span` и берём максимум.

3. **Расширенный NOISE-фильтр**. Помимо классики (menu/nav/footer/…)
   режем breadcrumb/tab/pagination/share/subscribe/related/author-info/
   tag-cloud/also-read/feedback/recommend/widget/promo/banner и любые
   контейнеры, в которых доля символов ссылок > 60% (классическая
   эвристика «link-density», взятая из Mozilla Readability и Trafilatura).

4. **Diagnostic blob**. ``extract_with_diagnostics`` дополнительно
   возвращает структуру с метриками: какой метод сработал, длина
   очищенного текста, длина исходного HTML, text/HTML ratio, тексты
   `<a>`-тегов в основном содержимом (для anchor-zone метрик),
   empty-reason при пустом результате (`rendered_by_js` / `bs4_too_short`
   / `noise_only`). Это критично для оператора: видно, какие страницы
   скачались, но дали мусор / SPA / пустые шаблоны.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from bs4 import BeautifulSoup, NavigableString, Tag
from bs4.element import Comment as _Bs4Comment
from readability import Document

try:
    import trafilatura
    _TRAFILATURA_AVAILABLE = True
except Exception:  # pragma: no cover — отсутствие пакета не должно ронять сервис
    trafilatura = None  # type: ignore[assignment]
    _TRAFILATURA_AVAILABLE = False


# ── Конфигурируемые пороги (env override) ─────────────────────────────────────

def _env_int(name: str, default: int, *, lo: int, hi: int) -> int:
    try:
        v = int(os.environ.get(name, "").strip())
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, v))


# Сколько символов «жирных» тегов считается «достаточно». Если этого набралось
# — расширять зону до div/span НЕ нужно, иначе замусорим выдачу навигацией.
HEAVY_TAGS_MIN_CHARS = _env_int(
    "RELEVANCE_HEAVY_TAGS_MIN_CHARS", 800, lo=200, hi=20000,
)

# Если основной проход дал меньше — пытаемся trafilatura, потом readability,
# в самом конце расширяем зону до div/span (как в старой реализации).
MIN_BODY_TEXT_CHARS = _env_int(
    "RELEVANCE_MIN_BODY_TEXT_CHARS", 800, lo=100, hi=20000,
)

# Любой контейнер, в котором символов внутри `<a>` больше этой доли от
# общего текста — считаем boilerplate (меню/breadcrumb/related-блок).
LINK_DENSITY_NOISE_RATIO = float(
    os.environ.get("RELEVANCE_LINK_DENSITY_NOISE_RATIO", "0.6")
)

# Минимальная длина блока, чтобы он попал в выдачу. Снижено с 8 до 4 в PR #90,
# но мы оставляем 4 — короткие списки/теги тоже несут смысл.
MIN_BLOCK_LEN_CHARS = 4

# ── Флаг полно-DOM-режима парсинга (Слой 2, Sandbox) ──────────────────────────
# По умолчанию ВЫКЛЮЧЕН: legacy-конвейер (heavy/trafilatura/readability/wide)
# работает байт-в-байт как раньше. Когда флаг = true, после legacy-прохода
# запускается дополнительный зональный walker, который:
#   • заполняет ParseResult.zoned_blocks (полная карта зон + hidden),
#   • расширяет ParseDiagnostics новыми полями (zone_chars/zone_word_count/
#     hidden_chars/hidden_reasons),
#   • ПЕРЕЗАПИСЫВАЕТ ParseResult.blocks → только видимый текст из зон main+
#     unknown (контракт E из спецификации).
# pipeline.js / comparison.py / Vue фронтенд в этой задаче не трогаем.
#
# 2026-05 update: по требованию заказчика «парсер должен идеально собирать
# весь контент, который сканируется поисковыми роботами (шапка, подвал,
# тело)» — дефолт переключаем на ON. .env.example менять запрещено
# (см. memories: env configuration), поэтому управление полностью в коде.
# Env-override остаётся как явный kill-switch для отладки: чтобы выключить
# walker — `RELEVANCE_FULL_DOM_MODE=false|0|off|no`.
FULL_DOM_MODE = os.environ.get("RELEVANCE_FULL_DOM_MODE", "").strip().lower() not in (
    "0", "false", "no", "off",
)

# Регулярка для «человеческого» подсчёта слов: кириллица, латиница, цифры
# (включая дефисные составные — «бизнес-ланч»). Используется только в
# диагностике для прозрачности подсчёта, не влияет на BM25/n-граммы.
_WORD_COUNT_RE = re.compile(r"[A-Za-zА-Яа-яЁё0-9]+(?:-[A-Za-zА-Яа-яЁё0-9]+)*")


# ── Список «шумовых» структурных тегов (вырезаются полностью) ─────────────────
NOISE_TAGS = (
    "script", "style", "noscript",
    "nav", "footer", "header", "aside",
    "form", "iframe", "svg", "canvas",
    "button", "dialog", "template",
)

# Расширенный regex по class/id — ловит и БЭМ-нотацию (`b-header__nav`),
# и «современные» контейнеры (related/share/subscribe/author-info/tag-cloud…).
NOISE_CLASS_ID_RE = re.compile(
    r"("
    r"menu|nav(?!igation_main)|navbar|footer|header|sidebar|"
    r"breadcrumb|breadcrumbs|crumb|"
    r"cookie|gdpr|consent|"
    r"modal|popup|overlay|lightbox|"
    r"banner|ads?|advert|promo|"
    r"comment|comments|disqus|"
    r"widget|widgets|"
    r"social|share|sharing|repost|"
    r"subscribe|subscription|newsletter|"
    r"related|recommend|also[-_]?read|see[-_]?also|"
    r"author[-_]?info|author[-_]?bio|author[-_]?card|"
    r"tag[-_]?cloud|tagcloud|"
    r"pagination|pager|paginator|"
    r"feedback|review[-_]?form|"
    r"copyright|legal[-_]?notice|disclaimer|"
    r"toolbar|hamburger|burger|drawer|"
    r"login|signin|signup|register|"
    r"search[-_]?form|search[-_]?bar|"
    r"skip[-_]?link|a11y[-_]?skip|"
    r"floating|sticky[-_]?(top|bottom|nav)|"
    r"language[-_]?switch|lang[-_]?switch|"
    r"hreflang|"
    r"chat[-_]?widget|chat[-_]?bot"
    r")",
    re.IGNORECASE,
)

# Из каких именно тегов собирать «жирный» (heavy) текст в первом проходе.
# Здесь намеренно НЕТ div/span/article — это и есть основная защита от мусора.
HEAVY_CONTENT_TAGS = (
    "p", "h1", "h2", "h3", "h4", "h5", "h6",
    "li", "td", "th",
    "blockquote", "dt", "dd", "figcaption", "caption", "summary",
    "article", "section", "main",
    "pre",
)

# Расширенный набор для последнего fallback-прохода (если предыдущие пусты).
WIDE_CONTENT_TAGS = HEAVY_CONTENT_TAGS + ("div", "span")


# ── Diagnostics ───────────────────────────────────────────────────────────────

@dataclass
class ParseDiagnostics:
    """Структурная диагностика по одному документу — попадает в API-ответ.

    Помогает оператору отличить «WAF не пустил» от «парсер не справился»
    от «SPA, нужен headless»."""

    method: str = "none"            # heavy_bs4 / trafilatura / readability / wide_bs4 / none
    text_chars: int = 0
    word_count: int = 0             # «сырой» подсчёт словоформ в основном тексте
                                    # (не зависит от лемматизации / стоп-слов —
                                    # для прозрачности в UI)
    html_chars: int = 0
    text_html_ratio: float = 0.0    # text / html, грубая мера «полезности»
    block_count: int = 0
    anchor_text_chars: int = 0      # сколько символов внутри <a> в основном контенте
    link_density: float = 0.0       # anchor_text / text (предупреждение о boilerplate)
    empty_reason: Optional[str] = None
    candidates: Dict[str, int] = field(default_factory=dict)  # method -> chars

    # ── Full-DOM mode (RELEVANCE_FULL_DOM_MODE=true) ──────────────────────
    # Заполняются ТОЛЬКО когда включён флаг полно-DOM-парсинга. В legacy-режиме
    # остаются пустыми, чтобы не раздувать ответ и не ломать исторические
    # снапшоты диагностики в БД.
    zone_chars: Dict[str, int] = field(default_factory=dict)
    zone_word_count: Dict[str, int] = field(default_factory=dict)
    hidden_chars: int = 0
    hidden_reasons: Dict[str, int] = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "method":           self.method,
            "text_chars":       self.text_chars,
            "word_count":       self.word_count,
            "html_chars":       self.html_chars,
            "text_html_ratio":  round(self.text_html_ratio, 4),
            "block_count":      self.block_count,
            "anchor_text_chars":self.anchor_text_chars,
            "link_density":     round(self.link_density, 4),
            "empty_reason":     self.empty_reason,
            "candidates":       dict(self.candidates),
            "zone_chars":       dict(self.zone_chars),
            "zone_word_count":  dict(self.zone_word_count),
            "hidden_chars":     self.hidden_chars,
            "hidden_reasons":   dict(self.hidden_reasons),
        }


@dataclass
class ParseResult:
    """Сырой результат — текстовые блоки + diagnostics + анкор-текст."""

    blocks: List[str] = field(default_factory=list)
    diagnostics: ParseDiagnostics = field(default_factory=ParseDiagnostics)
    anchor_text: str = ""           # объединённый текст всех `<a>` в контенте
    # Текст «теговой зоны» (header/footer/nav/aside) — «сквозное меню» сайта,
    # шапка и подвал. Идёт отдельным мини-корпусом для расчёта tag_zone_vocab.
    tag_zone_text: str = ""
    # Заголовки h2..h6 в порядке появления, нужны для рекомендаций по
    # структуре статьи (пересечения с конкурентами).
    headings: List[Dict] = field(default_factory=list)  # [{level:'h2', text:'…'}, ...]
    # Полная зональная карта DOM. None в legacy-режиме (флаг выключен) —
    # это сигнал потребителям, что сейчас работает старая логика, и
    # zoned_blocks недоступна. См. README full-DOM mode (Слой 2).
    zoned_blocks: Optional[List[Dict]] = None

    @property
    def text(self) -> str:
        return "\n".join(self.blocks)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _make_soup(html: str) -> BeautifulSoup:
    """lxml-парсер быстрее на больших страницах; html.parser как запасной."""
    try:
        return BeautifulSoup(html, "lxml")
    except Exception:
        return BeautifulSoup(html, "html.parser")


def _strip_noise(soup: BeautifulSoup) -> None:
    """Удаляет шумовые теги и элементы, попадающие под NOISE_CLASS_ID_RE."""
    for tag_name in NOISE_TAGS:
        for el in soup.find_all(tag_name):
            try:
                el.decompose()
            except Exception:
                pass

    # class. Итерируем по списку (find_all уже материализует), но parent-decompose
    # может оставить «осиротевшие» элементы у которых .attrs стал None.
    for el in list(soup.find_all(class_=True)):
        if el.attrs is None:
            continue
        classes = el.get("class") or []
        joined = " ".join(classes) if isinstance(classes, list) else str(classes)
        if NOISE_CLASS_ID_RE.search(joined):
            try:
                el.decompose()
            except Exception:
                pass

    # id
    for el in list(soup.find_all(id=True)):
        if el.attrs is None:
            continue
        el_id = el.get("id") or ""
        if isinstance(el_id, list):
            el_id = " ".join(el_id)
        if NOISE_CLASS_ID_RE.search(str(el_id)):
            try:
                el.decompose()
            except Exception:
                pass

    # role-based noise (ARIA): role=navigation/banner/complementary/contentinfo
    for el in list(soup.find_all(attrs={"role": True})):
        if el.attrs is None:
            continue
        role = str(el.get("role") or "").lower().strip()
        if role in ("navigation", "banner", "complementary", "contentinfo", "search"):
            try:
                el.decompose()
            except Exception:
                pass


def _strip_high_link_density(soup: BeautifulSoup) -> None:
    """Удаляет контейнеры (ul/ol/div/section), у которых доля текста внутри
    `<a>` превышает порог. Это эвристика Mozilla Readability — у меню,
    breadcrumb и related-блоков link density почти всегда > 60%.

    Чтобы не убить нормальные списки (например, навигация по статье — это
    тоже список ссылок, но короткий), требуем ещё минимум 80 символов
    суммарного текста: иначе блок проще оставить, риск удалить осмысленный
    короткий список выше, чем риск пропустить мини-меню."""
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
                    pass


def _collect_text_blocks(soup: BeautifulSoup, tags: Tuple[str, ...]) -> List[str]:
    """Собирает текстовые блоки из заданных тегов с дедупликацией по строке."""
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
    return seen


def _strip_text_dups(blocks: List[str]) -> List[str]:
    """Убирает блоки, целиком содержащиеся в более длинном соседе."""
    if len(blocks) <= 1:
        return blocks
    accepted: List[str] = []
    for b in sorted(blocks, key=len, reverse=True):
        is_subset = False
        for a in accepted:
            if len(b) < len(a) and b in a:
                is_subset = True
                break
        if not is_subset:
            accepted.append(b)
    order = {b: i for i, b in enumerate(blocks)}
    accepted.sort(key=lambda x: order.get(x, 1 << 30))
    return accepted


def _collect_anchor_text(soup: BeautifulSoup) -> str:
    """Собирает текст всех `<a>` в очищенном дереве (после _strip_noise).

    Используется для anchor-zone-метрик: какие LSI-слова конкуренты
    проставляют ссылками. Внутри Яндекса это важный фактор внутреннего
    ссылочного веса."""
    anchors: List[str] = []
    for a in soup.find_all("a"):
        t = a.get_text(separator=" ", strip=True)
        t = re.sub(r"\s+", " ", t).strip()
        if t:
            anchors.append(t)
    return " ".join(anchors)


# Регекспы class/id-хинтов для определения header/footer/menu (для случаев,
# когда сайт использует <div class="header"> вместо семантического <header>).
_TAG_ZONE_CLASS_RE = re.compile(
    r"(?:^|[-_\s])("
    r"header|site[-_]?header|page[-_]?header|top[-_]?bar|topbar|masthead|"
    r"footer|site[-_]?footer|page[-_]?footer|bottom[-_]?bar|colophon|"
    r"menu|menus|main[-_]?menu|nav|navbar|navigation|"
    r"sidebar|aside"
    r")(?:[-_\s]|$)",
    re.IGNORECASE,
)


def extract_tag_zone_text(html: str) -> str:
    """Собирает текст «теговой зоны» = шапка + подвал + сквозное меню + sidebar.

    Используется для отдельного мини-корпуса tag_zone_vocabulary — какие
    LSI-слова конкуренты выводят в шапке/подвале (заказчик: «надо учитывать
    сквозное меню»). Парсим RAW HTML, минуя _strip_noise (которая как раз
    эти зоны выпиливает), но осторожно — не дёргаем script/style/noscript.

    Возвращает один большой текст (как `anchor_text`); нормализатор сам
    разрежет на леммы.
    """
    if not html or not html.strip():
        return ""
    try:
        soup = _make_soup(html)
    except Exception:
        return ""

    # Удаляем заведомо мусорные теги (но НЕ header/footer/nav — они нам нужны!).
    for t in ("script", "style", "noscript", "template", "iframe", "svg", "canvas"):
        for el in soup.find_all(t):
            try:
                el.decompose()
            except Exception:
                pass

    chunks: List[str] = []
    seen_chunk_ids = set()  # id(node) → не дублируем вложенные совпадения

    def _harvest(node) -> None:
        if node is None or id(node) in seen_chunk_ids:
            return
        seen_chunk_ids.add(id(node))
        text = node.get_text(separator=" ", strip=True)
        text = re.sub(r"\s+", " ", text).strip()
        if text and len(text) >= 2:
            chunks.append(text)

    # 1) Семантические теги.
    for tag in ("header", "footer", "nav", "aside"):
        for el in soup.find_all(tag):
            _harvest(el)

    # 2) ARIA role'ы.
    for role in ("banner", "navigation", "contentinfo", "complementary"):
        for el in soup.find_all(attrs={"role": role}):
            _harvest(el)

    # 3) Class/id-хинты (BЭМ + просто "header"/"footer"/"menu").
    for el in soup.find_all(class_=True):
        try:
            classes = el.get("class") or []
            joined = " ".join(classes) if isinstance(classes, list) else str(classes)
            if _TAG_ZONE_CLASS_RE.search(joined):
                _harvest(el)
        except Exception:
            pass
    for el in soup.find_all(id=True):
        try:
            el_id = el.get("id") or ""
            if isinstance(el_id, list):
                el_id = " ".join(el_id)
            if _TAG_ZONE_CLASS_RE.search(str(el_id)):
                _harvest(el)
        except Exception:
            pass

    return " \n ".join(chunks)


def extract_headings(html: str) -> List[Dict]:
    """Собирает заголовки h2..h6 в порядке появления.

    Возвращает [{level:'h2', text:'…'}, ...]. h1 намеренно пропускаем —
    это обычно title статьи, который мало помогает при рекомендациях
    структуры (нужны именно подразделы)."""
    if not html or not html.strip():
        return []
    try:
        soup = _make_soup(html)
    except Exception:
        return []
    # Шум вырезаем (footer-меню/nav часто содержит <h3>Контакты</h3>),
    # чтобы рекомендации были релевантны контенту, а не шапке/подвалу.
    _strip_noise(soup)

    out: List[Dict] = []
    for tag in soup.find_all(["h2", "h3", "h4", "h5", "h6"]):
        text = tag.get_text(separator=" ", strip=True)
        text = re.sub(r"\s+", " ", text).strip()
        if not text or len(text) < 2 or len(text) > 250:
            continue
        out.append({"level": tag.name.lower(), "text": text})
    return out


# ── Extraction passes ─────────────────────────────────────────────────────────

def _heavy_bs4_pass(html: str) -> Tuple[List[str], BeautifulSoup]:
    """Pass 1: чистим шум + берём ТОЛЬКО «жирные» теги (без div/span)."""
    soup = _make_soup(html)
    _strip_noise(soup)
    _strip_high_link_density(soup)
    blocks = _collect_text_blocks(soup, HEAVY_CONTENT_TAGS)
    blocks = _strip_text_dups(blocks)
    return blocks, soup


def _trafilatura_pass(html: str) -> List[str]:
    """Pass 2: trafilatura — лучший open-source экстрактор для RU web."""
    if not _TRAFILATURA_AVAILABLE or not html:
        return []
    try:
        # favor_recall=True даёт чуть больше текста (важно для коротких
        # страниц услуг); no_fallback=False — позволяем trafilatura
        # самой использовать свои внутренние fallback'и.
        text = trafilatura.extract(
            html,
            include_comments=False,
            include_tables=True,
            favor_recall=True,
            deduplicate=True,
            no_fallback=False,
        )
    except Exception:
        return []
    if not text:
        return []
    blocks = [
        re.sub(r"\s+", " ", line).strip()
        for line in text.splitlines()
        if len(line.strip()) >= MIN_BLOCK_LEN_CHARS
    ]
    # дедуп точных дубликатов, сохранение порядка
    seen = set()
    out = []
    for b in blocks:
        if b in seen:
            continue
        seen.add(b)
        out.append(b)
    return out


def _readability_pass(html: str) -> List[str]:
    """Pass 3: readability-lxml — старый, но надёжный fallback."""
    try:
        main_html = Document(html).summary(html_partial=True) or ""
    except Exception:
        return []
    if not main_html:
        return []
    soup_main = _make_soup(main_html)
    _strip_noise(soup_main)
    _strip_high_link_density(soup_main)
    blocks = _collect_text_blocks(soup_main, HEAVY_CONTENT_TAGS)
    return _strip_text_dups(blocks)


def _wide_bs4_pass(html: str) -> List[str]:
    """Pass 4: расширенная зона (включая div/span) — последний рубеж для
    SPA-страниц с минималистичной разметкой. Применяем дедуп от общего
    к частному, чтобы не плодить мусор от вложенных обёрток."""
    soup = _make_soup(html)
    _strip_noise(soup)
    _strip_high_link_density(soup)
    blocks = _collect_text_blocks(soup, WIDE_CONTENT_TAGS)
    blocks = _strip_text_dups(blocks)
    return blocks


def _pick_best(
    candidates: Dict[str, List[str]],
    *,
    html_chars: int,
) -> Tuple[str, List[str]]:
    """Выбирает наилучший результат: при сравнимых длинах предпочитаем
    тот, у которого выше text/HTML ratio (= меньше boilerplate'а).

    Правило: если два кандидата близки по длине (отличие < 30%), берём
    тот, что НЕ wide_bs4 (предпочитаем чистый/heavy/trafilatura). Иначе
    — самый длинный."""
    # Только непустые
    pairs = [(name, blocks) for name, blocks in candidates.items() if blocks]
    if not pairs:
        return "none", []

    # Сначала отбрасываем заведомо проигрышные (wide_bs4 если есть лучшие)
    non_wide = [(n, b) for n, b in pairs if n != "wide_bs4"]
    pool = non_wide if non_wide else pairs

    # Сортируем по убыванию длины
    pool.sort(key=lambda x: sum(len(b) for b in x[1]), reverse=True)
    best_name, best_blocks = pool[0]
    best_chars = sum(len(b) for b in best_blocks)

    # Пытаемся апгрейдиться, если есть кандидат с лучшим text/HTML ratio
    # при сравнимой длине (защита от случая «trafilatura дала чистый
    # короткий текст, а bs4 — длинный с боковой панелью»).
    if html_chars > 0:
        for name, blocks in pool[1:]:
            chars = sum(len(b) for b in blocks)
            if chars < best_chars * 0.7:
                continue
            # сравнимая длина — выбираем наибольший text/HTML ratio
            ratio_best = best_chars / max(html_chars, 1)
            ratio_cand = chars / max(html_chars, 1)
            # предпочитаем кандидата, если его ratio выше И длина не сильно меньше
            if ratio_cand > ratio_best * 1.05:
                best_name, best_blocks = name, blocks
                best_chars = chars

    return best_name, best_blocks


# ── Public API ────────────────────────────────────────────────────────────────

def extract_with_diagnostics(html: str) -> ParseResult:
    """Главная точка входа. Возвращает ``ParseResult`` со всем — блоками,
    диагностикой и анкор-текстом основного содержимого."""

    diag = ParseDiagnostics()
    if not html or not html.strip():
        diag.empty_reason = "empty_html"
        return ParseResult(blocks=[], diagnostics=diag, anchor_text="")

    diag.html_chars = len(html)

    # ── Pass 1: heavy bs4 ────────────────────────────────────────────────────
    heavy_blocks, heavy_soup = _heavy_bs4_pass(html)
    heavy_chars = sum(len(b) for b in heavy_blocks)
    diag.candidates["heavy_bs4"] = heavy_chars

    candidates: Dict[str, List[str]] = {}
    candidates["heavy_bs4"] = heavy_blocks

    # Если набрали достаточно «жирных» — этого достаточно как baseline.
    # Но всё равно гоняем trafilatura для возможного апгрейда (он чище).
    traf_blocks = _trafilatura_pass(html)
    diag.candidates["trafilatura"] = sum(len(b) for b in traf_blocks)
    if traf_blocks:
        candidates["trafilatura"] = traf_blocks

    # readability — только если оба основных слабоваты
    if heavy_chars < MIN_BODY_TEXT_CHARS and not traf_blocks:
        rd_blocks = _readability_pass(html)
        diag.candidates["readability"] = sum(len(b) for b in rd_blocks)
        if rd_blocks:
            candidates["readability"] = rd_blocks

    # wide bs4 — самый last resort, для SPA. Запускаем, только если ВСЕ
    # предыдущие методы дали меньше MIN_BODY_TEXT_CHARS.
    best_so_far = max(
        (sum(len(b) for b in v) for v in candidates.values()),
        default=0,
    )
    if best_so_far < MIN_BODY_TEXT_CHARS:
        wide_blocks = _wide_bs4_pass(html)
        diag.candidates["wide_bs4"] = sum(len(b) for b in wide_blocks)
        if wide_blocks:
            candidates["wide_bs4"] = wide_blocks

    method, blocks = _pick_best(candidates, html_chars=diag.html_chars)
    diag.method = method
    diag.text_chars = sum(len(b) for b in blocks)
    diag.block_count = len(blocks)
    diag.text_html_ratio = diag.text_chars / max(diag.html_chars, 1)

    # Сырой подсчёт слов в основном тексте — независимо от лемматизатора
    # и стоп-слов. Нужен в UI для прозрачности (чтобы оператор видел,
    # сколько вообще словоформ на странице, а не только сколько уникальных
    # лемм попало в BM25-словарь).  `\w+` ловит и кириллицу, и латиницу,
    # и цифры — это «человеческое» определение слова.
    if blocks:
        joined_text = " ".join(blocks)
        diag.word_count = len(_WORD_COUNT_RE.findall(joined_text))

    # Anchor text — берём всегда из heavy_soup (после _strip_noise/link-density).
    # Это «легитимные» ссылки внутри контента, без меню/footer'а.
    anchor_text = _collect_anchor_text(heavy_soup)
    diag.anchor_text_chars = len(anchor_text)
    diag.link_density = (
        diag.anchor_text_chars / max(diag.text_chars, 1)
        if diag.text_chars > 0 else 0.0
    )

    if diag.text_chars == 0:
        # Категоризируем причину пустоты — оператору это очень нужно.
        # rendered_by_js: HTML не пустой, но в нём почти нет текстовых
        # узлов (типичный SPA с `<div id="root"></div>`).
        soup = heavy_soup
        body_text = soup.get_text(" ", strip=True) if soup else ""
        body_text_chars = len(re.sub(r"\s+", " ", body_text))
        if diag.html_chars > 1000 and body_text_chars < 200:
            diag.empty_reason = "rendered_by_js"
        elif diag.html_chars > 0 and body_text_chars < 200:
            diag.empty_reason = "tiny_html"
        else:
            diag.empty_reason = "noise_only"

    zoned_blocks: Optional[List[Dict]] = None

    # ── Слой 2: полно-DOM-режим (опционально, за флагом) ──────────────────
    # Запускается ПОСЛЕ legacy-прохода, поверх исходного HTML (а не очищенного
    # heavy_soup, у которого уже выпилены header/footer/nav/aside): walker'у
    # нужно увидеть всю структуру, чтобы корректно классифицировать зоны и
    # подсчитать hidden-метрики. Согласно контракту E мы при этом
    # ПЕРЕЗАПИСЫВАЕМ blocks/text_chars/word_count/block_count так, чтобы
    # туда попадал только видимый текст из зон main+unknown — это и есть
    # «100% совместимость» (раньше footer/nav/aside тоже выпиливались, теперь
    # выпиливаются ровно те же зоны, но через явный zoning, а не через
    # decompose в _strip_noise).
    if FULL_DOM_MODE:
        try:
            zoned_blocks, zone_chars, zone_word_count, hidden_chars, hidden_reasons = (
                _full_dom_extract(html)
            )
        except Exception as exc:  # pragma: no cover — walker не должен валить весь парсер
            zoned_blocks = None
            diag.empty_reason = diag.empty_reason or f"full_dom_walker_failed:{type(exc).__name__}"
        else:
            diag.zone_chars = zone_chars
            diag.zone_word_count = zone_word_count
            diag.hidden_chars = hidden_chars
            diag.hidden_reasons = hidden_reasons

            # Контракт «полный охват» (по требованию заказчика «парсер должен
            # собирать весь контент, который сканируется поисковыми роботами:
            # шапку, подвал и тело страницы»): blocks = весь видимый текст из
            # main + unknown + header + footer + nav + aside + boilerplate_links.
            # Hidden и attributes (alt/title/aria-label) НЕ кладём — Google их
            # тоже учитывает с понижающим весом, но в нашем основном корпусе
            # лемм они исказили бы статистику.
            VISIBLE_CONTENT_ZONES = (
                "main", "unknown", "header", "footer", "nav", "aside",
                "boilerplate_links",
            )
            visible_main_unknown = [
                zb["text"] for zb in zoned_blocks
                if not zb.get("is_hidden")
                and zb.get("zone") in VISIBLE_CONTENT_ZONES
                and len(zb.get("text", "")) >= MIN_BLOCK_LEN_CHARS
            ]
            blocks = visible_main_unknown
            diag.text_chars = sum(len(b) for b in blocks)
            diag.block_count = len(blocks)
            diag.text_html_ratio = diag.text_chars / max(diag.html_chars, 1)
            diag.word_count = (
                len(_WORD_COUNT_RE.findall(" ".join(blocks))) if blocks else 0
            )
            # link_density пересчёт от нового text_chars (anchor_text сам считаем
            # как раньше из heavy_soup — это «легитимные» ссылки внутри контента).
            diag.link_density = (
                diag.anchor_text_chars / max(diag.text_chars, 1)
                if diag.text_chars > 0 else 0.0
            )
            # Если empty_reason был выставлен по legacy-проходу, но full-DOM
            # нашёл видимый main/unknown текст — снимаем флаг.
            if blocks and diag.empty_reason in ("noise_only", "tiny_html", "rendered_by_js"):
                diag.empty_reason = None

    return ParseResult(
        blocks=blocks,
        diagnostics=diag,
        anchor_text=anchor_text,
        zoned_blocks=zoned_blocks,
        tag_zone_text=extract_tag_zone_text(html),
        headings=extract_headings(html),
    )


def extract_text_blocks(html: str) -> List[str]:
    """Backward-compat: только список блоков без диагностики."""
    return extract_with_diagnostics(html).blocks


def extract_full_text(html: str) -> str:
    """Backward-compat: один большой текст для документа целиком."""
    return extract_with_diagnostics(html).text



# ════════════════════════════════════════════════════════════════════════════
#                  Слой 2: Full-DOM zoning walker
# ════════════════════════════════════════════════════════════════════════════
#
# Реализация спецификации A–G. Запускается ТОЛЬКО когда выставлен флаг
# RELEVANCE_FULL_DOM_MODE=true. Самодостаточный модуль — не использует
# legacy-функции _strip_noise / _strip_high_link_density (которые decompose'ят
# узлы и тем самым делают зональную классификацию невозможной).
# Главное публичное API: `_full_dom_extract(html)`, вызывается из
# `extract_with_diagnostics`.
#
# Контракт зон (см. Спецификация §A):
#   - attributes        (приоритет 100) — текст из alt/title/aria-label
#   - boilerplate_links (приоритет 90)  — контейнеры с link-density >= 0.6
#   - nav               (приоритет 80)  — <nav>/role=navigation/menu-классы
#   - noise_other       (приоритет 70)  — NOISE_CLASS_ID_RE без семантики
#   - header            (приоритет 70)
#   - footer            (приоритет 70)
#   - aside             (приоритет 70)
#   - main              (приоритет 50)  — <main>/<article>
#   - unknown           (приоритет 0)   — дефолт
# is_hidden — параллельный булев флаг (см. §C).

ZONE_MAIN = "main"
ZONE_HEADER = "header"
ZONE_NAV = "nav"
ZONE_FOOTER = "footer"
ZONE_ASIDE = "aside"
ZONE_BOILERPLATE = "boilerplate_links"
ZONE_NOISE = "noise_other"
ZONE_ATTRIBUTES = "attributes"
ZONE_UNKNOWN = "unknown"

ZONE_LABELS = (
    ZONE_MAIN, ZONE_HEADER, ZONE_NAV, ZONE_FOOTER, ZONE_ASIDE,
    ZONE_BOILERPLATE, ZONE_NOISE, ZONE_ATTRIBUTES, ZONE_UNKNOWN,
)

ZONE_PRIORITY: Dict[str, int] = {
    ZONE_ATTRIBUTES:   100,
    ZONE_BOILERPLATE:  90,
    ZONE_NAV:          80,
    ZONE_NOISE:        70,
    ZONE_HEADER:       70,
    ZONE_FOOTER:       70,
    ZONE_ASIDE:        70,
    ZONE_MAIN:         50,
    ZONE_UNKNOWN:      0,
}

# Блочные теги, которые рвут поток текста и порождают отдельные блоки.
# inline-теги (span, a, b, strong, em, i, u, mark, small, sub, sup, code,
# abbr, cite, q, time, br) специально НЕ в этом списке: их текст склеивается
# в текст ближайшего блочного предка (см. спецификацию §B).
_BLOCK_LEVEL_TAGS = frozenset({
    "p", "div", "section", "article", "main", "header", "footer", "nav", "aside",
    "li", "ul", "ol", "dl", "dt", "dd",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "blockquote", "pre", "figure", "figcaption", "caption",
    "table", "thead", "tbody", "tfoot", "tr", "td", "th",
    "form", "fieldset", "legend",
    "address", "details", "summary",
    "hr", "body", "html",
})

# Теги, которые целиком пропускаем (не спускаемся внутрь).
_FULL_DOM_SKIP_TAGS = frozenset({"script", "style", "template"})

# Класс/id-хинты для конкретных семантических зон (более узкие, чем
# глобальный NOISE_CLASS_ID_RE). Если узел совпадает И с ними, и с
# NOISE_CLASS_ID_RE — приоритет у семантической зоны.
_NAV_HINT_RE = re.compile(
    r"(?:^|[-_\s])(?:menu|menus|main[-_]?menu|nav|navbar|navigation|"
    r"breadcrumb|breadcrumbs|crumb|crumbs|pagination|pager)(?:[-_\s]|$)",
    re.IGNORECASE,
)
_HEADER_HINT_RE = re.compile(
    r"(?:^|[-_\s])(?:header|site[-_]?header|page[-_]?header|"
    r"top[-_]?bar|topbar|masthead)(?:[-_\s]|$)",
    re.IGNORECASE,
)
_FOOTER_HINT_RE = re.compile(
    r"(?:^|[-_\s])(?:footer|site[-_]?footer|page[-_]?footer|"
    r"bottom[-_]?bar|colophon)(?:[-_\s]|$)",
    re.IGNORECASE,
)
_ASIDE_HINT_RE = re.compile(
    r"(?:^|[-_\s])(?:sidebar|side[-_]?bar|aside|side[-_]?nav|"
    r"side[-_]?col|side[-_]?column|secondary|complementary)(?:[-_\s]|$)",
    re.IGNORECASE,
)

# §C: классы, гарантированно скрывающие текст визуально (a11y-приёмы).
_HIDDEN_CLASS_RE = re.compile(
    r"(?:^|\s)(?:sr-only|sr_only|visually-hidden|visually_hidden|"
    r"hidden|d-none|is-hidden)(?:\s|$)",
    re.IGNORECASE,
)

# §C: inline-CSS regex'ы. Парсим ТОЛЬКО атрибут style текущего узла
# (а наследование от предков обеспечивается нашим walker'ом — родитель
# уже передал свой is_hidden вниз). Глобальные <style>-теги не парсим
# (без cssutils — спецификация явно это запрещает).
_RE_DISPLAY_NONE     = re.compile(r"display\s*:\s*none\b",    re.IGNORECASE)
_RE_VISIBILITY_HIDDEN = re.compile(r"visibility\s*:\s*hidden\b", re.IGNORECASE)
_RE_OPACITY_ZERO     = re.compile(r"opacity\s*:\s*0(?:\.0+)?(?![.\d])", re.IGNORECASE)
_RE_POSITION_ABS     = re.compile(r"position\s*:\s*absolute\b",   re.IGNORECASE)
_RE_OFFSCREEN_OFFSET = re.compile(r"(?:left|top)\s*:\s*-\d{3,}px\b", re.IGNORECASE)


def _resolve_zone(parent_zone: str, own_zones: set) -> str:
    """Выбирает эффективную зону по приоритету (см. §A).

    Унаследованная от предка зона участвует наравне с собственными
    сигналами текущего узла — поэтому если ребёнок попадает в более
    приоритетную зону (например, `<nav>` внутри `<main>`), он её и
    получает; и наоборот, если ребёнок без своих сигналов — он
    наследует зону предка."""
    candidates = set(own_zones) if own_zones else set()
    if parent_zone:
        candidates.add(parent_zone)
    if not candidates:
        return ZONE_UNKNOWN
    return max(candidates, key=lambda z: ZONE_PRIORITY.get(z, 0))


def _classify_node_zones(node: Tag) -> set:
    """Возвращает СОБСТВЕННЫЕ zone-сигналы узла (без учёта родителя).

    Не возвращает ZONE_BOILERPLATE — boilerplate определяется отдельным
    проходом по link-density (см. _collect_boilerplate_containers)."""
    zones: set = set()
    name = (node.name or "").lower()

    # Семантические HTML5 теги
    if name == "main" or name == "article":
        zones.add(ZONE_MAIN)
    elif name == "header":
        zones.add(ZONE_HEADER)
    elif name == "nav":
        zones.add(ZONE_NAV)
    elif name == "footer":
        zones.add(ZONE_FOOTER)
    elif name == "aside":
        zones.add(ZONE_ASIDE)

    attrs = node.attrs or {}

    # ARIA role
    role = attrs.get("role")
    if role:
        if isinstance(role, list):
            role = " ".join(str(x) for x in role)
        role = str(role).lower().strip()
        if role == "navigation":
            zones.add(ZONE_NAV)
        elif role == "banner":
            zones.add(ZONE_HEADER)
        elif role == "contentinfo":
            zones.add(ZONE_FOOTER)
        elif role == "complementary":
            zones.add(ZONE_ASIDE)
        elif role == "main":
            zones.add(ZONE_MAIN)

    # Class + id (объединяем для regex-проверок)
    classes = attrs.get("class") or []
    if isinstance(classes, str):
        classes = [classes]
    cls_str = " ".join(str(c) for c in classes)
    eid = attrs.get("id") or ""
    if isinstance(eid, list):
        eid = " ".join(str(x) for x in eid)
    haystack = (cls_str + " " + str(eid)).strip()
    if not haystack:
        return zones

    # Семантические хинты (более узкие — выигрывают у noise_other)
    matched_semantic = False
    if _NAV_HINT_RE.search(haystack):
        zones.add(ZONE_NAV)
        matched_semantic = True
    if _HEADER_HINT_RE.search(haystack):
        zones.add(ZONE_HEADER)
        matched_semantic = True
    if _FOOTER_HINT_RE.search(haystack):
        zones.add(ZONE_FOOTER)
        matched_semantic = True
    if _ASIDE_HINT_RE.search(haystack):
        zones.add(ZONE_ASIDE)
        matched_semantic = True

    # noise_other — только если не попали ни в одну семантическую зону
    if not matched_semantic and NOISE_CLASS_ID_RE.search(haystack):
        zones.add(ZONE_NOISE)

    return zones


def _check_hidden(node: Tag) -> Tuple[bool, Optional[str]]:
    """§C: возвращает (is_hidden, hidden_reason) ТОЛЬКО по сигналам текущего
    узла. Наследование вниз обеспечивается walker'ом."""
    if not isinstance(node, Tag):
        return False, None
    attrs = node.attrs or {}

    # 1) hidden attribute (html5: bool-атрибут — присутствует или нет)
    if "hidden" in attrs:
        return True, "attr_hidden"

    # 2) aria-hidden="true"
    aria_hidden = attrs.get("aria-hidden")
    if aria_hidden is not None:
        if isinstance(aria_hidden, list):
            aria_hidden = " ".join(str(x) for x in aria_hidden)
        if str(aria_hidden).strip().lower() == "true":
            return True, "aria_hidden"

    # 3) classes
    classes = attrs.get("class") or []
    if isinstance(classes, str):
        classes = [classes]
    if classes:
        cls_str = " ".join(str(c) for c in classes)
        if _HIDDEN_CLASS_RE.search(" " + cls_str + " "):
            return True, "sr_only"

    # 4) inline CSS (style="…") — только текущего узла
    style = attrs.get("style")
    if style:
        if isinstance(style, list):
            style = " ".join(str(x) for x in style)
        style = str(style)
        if _RE_DISPLAY_NONE.search(style):
            return True, "css_display_none"
        if _RE_VISIBILITY_HIDDEN.search(style):
            return True, "css_visibility_hidden"
        if _RE_OPACITY_ZERO.search(style):
            return True, "css_opacity_zero"
        if _RE_POSITION_ABS.search(style) and _RE_OFFSCREEN_OFFSET.search(style):
            return True, "css_offscreen"

    return False, None


def _collect_boilerplate_containers(soup: BeautifulSoup) -> set:
    """§D: возвращает набор `id(node)` контейнеров (ul/ol/div/section), у
    которых доля символов внутри `<a>` выше RELEVANCE_LINK_DENSITY_NOISE_RATIO
    и общий объём текста ≥ 80 символов (тот же порог, что в legacy
    _strip_high_link_density — иначе любой осмысленный мини-список из 2 ссылок
    был бы помечен boilerplate'ом)."""
    boiler: set = set()
    for tag_name in ("ul", "ol", "div", "section"):
        for el in soup.find_all(tag_name):
            if not isinstance(el, Tag) or el.attrs is None:
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
                boiler.add(id(el))
    return boiler


def _nearest_block_ancestor(node, block_stack):
    """Возвращает текущий блочный контейнер (вершину стека), под которым
    группируются текстовые фрагменты. Никогда не None — внизу стека лежит
    корневой объект (soup), который тоже трактуем как 'блок'."""
    return block_stack[-1] if block_stack else None


def _full_dom_extract(html: str) -> Tuple[
    List[Dict],            # zoned_blocks
    Dict[str, int],        # zone_chars
    Dict[str, int],        # zone_word_count
    int,                   # hidden_chars
    Dict[str, int],        # hidden_reasons
]:
    """Главная точка входа Слоя 2. См. шапку модуля для контракта."""
    soup = _make_soup(html)

    # §C: <template> вырезаем полностью. <script>/<style> просто не входим
    # внутрь (их обработка в walker'е через _FULL_DOM_SKIP_TAGS).
    for tpl in list(soup.find_all("template")):
        try:
            tpl.decompose()
        except Exception:
            pass

    boiler_ids = _collect_boilerplate_containers(soup)

    # Накопитель «блок-предок → list[fragment]».
    # fragment = {"text", "is_anchor"}; зона/hidden/hidden_reason — общие
    # для блока (фрагменты из разных зон/состояний попадают в РАЗНЫЕ блоки).
    # Поэтому ключ группировки — кортеж (id(block_parent), zone, is_hidden,
    # hidden_reason). Это сохраняет порядок появления фрагментов и склеивает
    # инлайн-теги (span, a, b, strong) внутри одного блока (см. §B).
    grouped: Dict[Tuple, Dict] = {}
    group_order: List[Tuple] = []
    attr_blocks: List[Dict] = []  # отдельные объекты для alt/title/aria-label

    def _emit_attr(node: Tag, value: str, parent_zone: str,
                   parent_hidden: bool, parent_reason: Optional[str],
                   in_anchor: bool) -> None:
        """§A: текст из alt/title/aria-label всегда идёт зоной 'attributes'
        (наивысший приоритет). hidden наследуется от предков (если родитель
        скрыт — атрибут тоже не показывается пользователю)."""
        clean = re.sub(r"\s+", " ", str(value)).strip()
        if not clean:
            return
        attr_blocks.append({
            "text": clean,
            "zone": ZONE_ATTRIBUTES,
            "tag": node.name,
            "is_hidden": bool(parent_hidden),
            "hidden_reason": parent_reason if parent_hidden else None,
            "is_anchor": bool(in_anchor),
        })

    def _add_fragment(block_parent, zone: str, is_hidden: bool,
                      hidden_reason: Optional[str], is_anchor: bool,
                      text: str) -> None:
        clean = re.sub(r"\s+", " ", text).strip()
        if not clean:
            return
        # is_anchor дробит группу: фрагменты внутри `<a>` и фрагменты вне `<a>`
        # внутри одного блока становятся разными zoned_blocks-объектами,
        # чтобы потребитель мог отдельно посчитать анкорный текст. Слова не
        # рвутся внутри фрагмента (мы уже схлопнули пробелы).
        block_id = id(block_parent) if block_parent is not None else 0
        block_tag = block_parent.name if isinstance(block_parent, Tag) else "body"
        key = (block_id, zone, bool(is_hidden), hidden_reason, bool(is_anchor))
        if key not in grouped:
            grouped[key] = {
                "text_parts": [],
                "zone": zone,
                "tag": block_tag,
                "is_hidden": bool(is_hidden),
                "hidden_reason": hidden_reason,
                "is_anchor": bool(is_anchor),
            }
            group_order.append(key)
        grouped[key]["text_parts"].append(clean)

    def _walk(node, parent_zone: str, parent_hidden: bool,
              parent_reason: Optional[str], in_anchor: bool,
              block_stack: List) -> None:
        # NavigableString (текстовый узел)
        if isinstance(node, NavigableString):
            # bs4.Comment / CData / ProcessingInstruction — это подклассы
            # NavigableString. Их в текст не пускаем.
            if isinstance(node, _Bs4Comment):
                return
            raw = str(node)
            if not raw or not raw.strip():
                return
            block_parent = _nearest_block_ancestor(node, block_stack)
            _add_fragment(
                block_parent, parent_zone, parent_hidden, parent_reason,
                in_anchor, raw,
            )
            return

        if not isinstance(node, Tag):
            return

        name = (node.name or "").lower()

        # Полный пропуск служебных тегов
        if name in _FULL_DOM_SKIP_TAGS:
            return

        # §C: <noscript> — спускаемся, но всё внутри ЖЁСТКО помечаем
        # is_hidden=true с причиной "noscript" (даже если родитель уже был
        # скрыт по другой причине — спецификация требует именно эту метку
        # для содержимого noscript, чтобы оператор отличал «реально
        # invisible no-JS fallback» от «скрыто CSS-ом»).
        force_noscript = (name == "noscript")

        # Собственные сигналы зоны
        own_zones = _classify_node_zones(node)
        # boilerplate_links — отдельный сигнал по link-density
        if id(node) in boiler_ids:
            own_zones = set(own_zones) | {ZONE_BOILERPLATE}

        eff_zone = _resolve_zone(parent_zone, own_zones)

        # is_hidden наследуется + проверяем сигналы текущего узла
        cur_hidden = parent_hidden
        cur_reason = parent_reason
        if not cur_hidden:
            h, r = _check_hidden(node)
            if h:
                cur_hidden = True
                cur_reason = r
        # noscript-маркер ставится ПОСЛЕ обычных проверок — он перекрывает
        # любую другую причину для всего поддерева noscript.
        if force_noscript:
            cur_hidden = True
            cur_reason = "noscript"

        cur_in_anchor = in_anchor or (name == "a")

        # §A: эмитим attributes-объекты для alt/title/aria-label
        # (для самого узла, ДО спуска — порядок в выдаче сохранится логичный).
        if node.attrs:
            for attr_name in ("alt", "title", "aria-label"):
                v = node.attrs.get(attr_name)
                if v is None:
                    continue
                if isinstance(v, list):
                    v = " ".join(str(x) for x in v)
                if not str(v).strip():
                    continue
                _emit_attr(node, v, eff_zone, cur_hidden, cur_reason, cur_in_anchor)

        # Открываем блочную рамку, если это блочный тег
        new_block_opened = False
        if name in _BLOCK_LEVEL_TAGS:
            block_stack.append(node)
            new_block_opened = True

        try:
            for child in list(node.children):
                _walk(child, eff_zone, cur_hidden, cur_reason,
                      cur_in_anchor, block_stack)
        finally:
            if new_block_opened:
                block_stack.pop()

    # Стартуем с soup; на верхнем уровне зона = unknown, hidden = False.
    # soup сам по себе как «корневой блок-предок» — фрагменты не имеющие
    # явного блочного предка (например, текст прямо внутри <body>) попадут
    # под него. На самом верхнем уровне soup.children может содержать
    # «осиротевшие» NavigableString'и (артефакты разбора doctype lxml'ом
    # — например, текст 'html' рядом с тегом <html>). Их пропускаем.
    initial_block_stack: List = [soup]
    for top in list(soup.children):
        if not isinstance(top, Tag):
            continue
        _walk(top, ZONE_UNKNOWN, False, None, False, initial_block_stack)

    # Сборка zoned_blocks: сначала структурные блоки (по порядку появления
    # их block_parent'а в DOM), потом attributes-объекты — так атрибуты
    # не «разрывают» соседние текстовые блоки.
    zoned_blocks: List[Dict] = []
    for key in group_order:
        g = grouped[key]
        text = " ".join(g["text_parts"]).strip()
        text = re.sub(r"\s+", " ", text)
        if not text:
            continue
        zoned_blocks.append({
            "text": text,
            "zone": g["zone"],
            "tag": g["tag"],
            "is_hidden": g["is_hidden"],
            "hidden_reason": g["hidden_reason"],
            "is_anchor": g["is_anchor"],
        })
    zoned_blocks.extend(attr_blocks)

    # Агрегаты для диагностики
    zone_chars: Dict[str, int] = {z: 0 for z in ZONE_LABELS}
    zone_word_count: Dict[str, int] = {z: 0 for z in ZONE_LABELS}
    hidden_chars = 0
    hidden_reasons: Dict[str, int] = {}
    for zb in zoned_blocks:
        n = len(zb["text"])
        wc = len(_WORD_COUNT_RE.findall(zb["text"]))
        z = zb["zone"]
        zone_chars[z] = zone_chars.get(z, 0) + n
        zone_word_count[z] = zone_word_count.get(z, 0) + wc
        if zb["is_hidden"]:
            hidden_chars += n
            r = zb["hidden_reason"] or "unknown"
            hidden_reasons[r] = hidden_reasons.get(r, 0) + n
    # Чистим нули, чтобы JSON был компактным
    zone_chars = {k: v for k, v in zone_chars.items() if v}
    zone_word_count = {k: v for k, v in zone_word_count.items() if v}

    return zoned_blocks, zone_chars, zone_word_count, hidden_chars, hidden_reasons
