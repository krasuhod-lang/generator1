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

from bs4 import BeautifulSoup
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
        }


@dataclass
class ParseResult:
    """Сырой результат — текстовые блоки + diagnostics + анкор-текст."""

    blocks: List[str] = field(default_factory=list)
    diagnostics: ParseDiagnostics = field(default_factory=ParseDiagnostics)
    anchor_text: str = ""           # объединённый текст всех `<a>` в контенте

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

    return ParseResult(
        blocks=blocks,
        diagnostics=diag,
        anchor_text=anchor_text,
    )


def extract_text_blocks(html: str) -> List[str]:
    """Backward-compat: только список блоков без диагностики."""
    return extract_with_diagnostics(html).blocks


def extract_full_text(html: str) -> str:
    """Backward-compat: один большой текст для документа целиком."""
    return extract_with_diagnostics(html).text

