"""Competitor SEO signals extractor (Wave 1 of the «утечки Google/Yandex» plan).

Извлекает из СЫРОГО HTML конкурента сигналы, которые засветились в утечках
Google Content Warehouse (май 2024) и Яндекса (январь 2023, 1922 фактора), и
которые реально измеримы по одной странице (без crawl, без ML, без внешних API):

  • Title / H1 / meta description: длина, точные вхождения запроса, позиция,
    совпадение title↔H1, модификаторы (год / число / «лучшие/как/гайд/обзор»);
  • Schema.org: типы, найденные в JSON-LD / microdata / RDFa;
  • Freshness: datePublished / dateModified из JSON-LD / <meta property="article:*"> /
    microdata; возраст в днях относительно «сегодня»;
  • URL/slug: глубина (slashes), длина, кириллица/транслит, наличие даты/числа,
    наличие точного ключа в slug;
  • Trust-link density: внешние ссылки на «авторитетные» домены
    (.gov / .edu / Wikipedia / ГОСТ / НИИ / крупные СМИ);
  • Anchor bank: внутренние анкоры основной зоны + контекст ±10 слов,
    распределение brand / exact / partial / generic;
  • UX-профиль: ToC, above-the-fold (символы до первого H2), средняя длина
    параграфа, частота H2/H3 на 1000 слов, FAQ/TL;DR/итог в начале,
    ALT-структура первого изображения;
  • Exact-form occurrences (Yandex FI_BCLM_*): точная словоформа запроса в
    первых 100/200/300 словах, в первом / последнем абзаце, в H2/H3, в alt;
  • Host-hygiene (Yandex hostrank-прокси): canonical, hreflang, OG, Twitter
    Cards, Я.Метрика, GA, sitemap-link, JSON-LD автора.

Все функции — pure / deterministic. Никаких сетевых вызовов. По возможности
переиспользуем уже работающие хелперы parser.py (`_make_soup`, `_strip_noise`,
`extract_headings`).

Контракт: см. `extract_competitor_signals(html, url, query) -> dict`. Шумовые/
несработавшие поля заполняются `None` или `0`, чтобы агрегатор мог считать
медиану по всему топу.

ВАЖНО (юридически): мы НЕ воспроизводим служебный код или документы Google /
Yandex; мы используем публично-обсуждаемые СВОДКИ утечек как источник гипотез
о том, что измерять. Конкретные веса должны калиброваться по собственным
данным (поэтому в ответ всегда кладём serp_position рядом с сигналами).
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import re
from collections import Counter
from statistics import median
from typing import Any, Dict, List, Optional, Sequence, Tuple
from urllib.parse import urlparse

from bs4 import BeautifulSoup, Tag

from .parser import _make_soup, _strip_noise, extract_headings


# ── Configuration / heuristics ────────────────────────────────────────────────

# «Авторитетные» домены: trust-link density считается по вхождениям этих
# подстрок/суффиксов в hostname внешних ссылок. Список намеренно консервативен —
# false-positive здесь дороже false-negative (плохой совет писателю «вставь
# ссылку на сомнительный домен, потому что он в trust-list» может уронить трафик).
_TRUST_HOST_PATTERNS: Tuple[str, ...] = (
    # Государственные / научные / международные
    ".gov", ".gov.ru", ".gov.kz", ".gov.by", ".gov.ua",
    ".edu", ".ac.ru", ".ac.uk",
    "who.int", "un.org", "europa.eu", "oecd.org",
    # Энциклопедии и справочники
    "wikipedia.org", "wiktionary.org", "britannica.com",
    # Стандарты
    "gost.ru", "gostinfo.ru", "iso.org", "iec.ch",
    # Российские министерства / агентства / фонды
    "minzdrav.gov.ru", "minfin.gov.ru", "mintrud.gov.ru",
    "rosminzdrav.ru", "rospotrebnadzor.ru", "rosstat.gov.ru",
    "consultant.ru", "garant.ru", "pravo.gov.ru",
    "fss.ru", "pfr.gov.ru", "nalog.gov.ru", "nalog.ru",
    # Крупные СМИ / справочники РФ
    "tass.ru", "ria.ru", "rbc.ru", "kommersant.ru", "vedomosti.ru",
    "interfax.ru", "rg.ru", "gazeta.ru",
    # Профессиональные / медицинские / правовые
    "pubmed.ncbi.nlm.nih.gov", "ncbi.nlm.nih.gov", "nih.gov",
    "cochrane.org", "medscape.com", "mayoclinic.org",
)

# Title/H1-модификаторы, которые статистически усиливают CTR (выявлены в
# многочисленных публичных исследованиях SERP-сниппетов). Используем как
# рекомендацию писателю, не как блокирующее правило.
_YEAR_RE = re.compile(r"\b(?:19|20)\d{2}\b")
_NUMBER_RE = re.compile(r"\b\d+\b")
_PARENS_RE = re.compile(r"[\(\[\{].+?[\)\]\}]")
# Расширяем «русско-английские» CTR-сигналы.
_CTR_MODIFIER_RE = re.compile(
    r"\b("
    r"лучш(?:ие|их|ая|ий)|топ\b|"
    r"как\b|почему\b|зачем\b|что такое|"
    r"гайд|инструкция|пошагов|руководство|обзор|сравнение|"
    r"полн(?:ый|ое|ая)|подробн(?:ый|ое|ая)|"
    r"бесплатн(?:о|ый|ая|ое)|дешев|"
    r"best|top|guide|how to|review|complete|ultimate"
    r")\b",
    re.IGNORECASE,
)

# FAQ / TL;DR / TOC / итог-маркеры в первом экране — для UX-профиля.
_FAQ_HEAD_RE = re.compile(
    r"(часто\s+задава|вопрос(?:ы|\s+ответ)|faq\b|q\s*&\s*a)",
    re.IGNORECASE,
)
_TLDR_HEAD_RE = re.compile(
    r"(tl[;:]?\s*dr|кратко\b|вкратце|резюме|главное|итог)",
    re.IGNORECASE,
)
_TOC_HEAD_RE = re.compile(
    r"(содержание|оглавление|table\s+of\s+contents|toc)",
    re.IGNORECASE,
)

# «Шаблон» для класса/id Я.Метрики и GA в head/body.
_YANDEX_METRIKA_RE = re.compile(r"(mc\.yandex\.ru/metrika|ym\(\s*\d+|yaCounter\d+)", re.IGNORECASE)
_GA_RE = re.compile(
    r"(google[-_]?analytics|gtag\(|googletagmanager\.com|ga\(\s*['\"]create['\"])",
    re.IGNORECASE,
)

# Регулярка для подсчёта слов (та же, что в parser.py — для согласованности).
_WORD_RE = re.compile(r"[A-Za-zА-Яа-яЁё0-9]+(?:-[A-Za-zА-Яа-яЁё0-9]+)*")

# Транслит/кирилл-эвристика slug.
_CYRIL_CHAR_RE = re.compile(r"[А-Яа-яЁё]")
_LATIN_CHAR_RE = re.compile(r"[A-Za-z]")

# Cap for per-URL collections, чтобы payload не разрастался.
_MAX_ANCHORS_PER_DOC = 100
_MAX_SCHEMA_TYPES_PER_DOC = 30
_MAX_TRUST_LINKS_PER_DOC = 50

# Cap for aggregate.
_MAX_AGG_ANCHORS = 200
_MAX_AGG_SCHEMA_TYPES = 30

# ── Глобальный feature-flag ────────────────────────────────────────────────────
# По умолчанию ВКЛЮЧЁН — анализ сигналов состоит из чистого HTML-парсинга,
# легковесен и не добавляет сетевых вызовов. Можно явно выключить через
# RELEVANCE_COMPETITOR_SIGNALS=false (например, если в проде нужно временно
# уменьшить размер JSON-ответа).
def signals_enabled() -> bool:
    val = os.environ.get("RELEVANCE_COMPETITOR_SIGNALS", "").strip().lower()
    if val in ("0", "false", "no", "off"):
        return False
    return True


# ── Public API ────────────────────────────────────────────────────────────────

def extract_competitor_signals(
    html: str,
    url: str = "",
    query: str = "",
) -> Dict[str, Any]:
    """Возвращает плоский dict сигналов по одному URL.

    Все вычисления безопасны для невалидного HTML / пустых строк — в этом
    случае возвращаем skeleton со статусом empty_reason="no_html".
    """
    skeleton = _empty_signals(url)
    if not html or not html.strip():
        skeleton["empty_reason"] = "no_html"
        return skeleton
    try:
        soup = _make_soup(html)
    except Exception as e:  # pragma: no cover — невалидный HTML не должен ронять сервис
        skeleton["empty_reason"] = f"soup_failed: {str(e)[:80]}"
        return skeleton

    # Сохраним «сырое» soup ДО _strip_noise — для metadata (head/script/json-ld
    # часто живут внутри тегов, которые _strip_noise сносит).
    raw_soup = soup
    try:
        clean_soup = _make_soup(html)
        _strip_noise(clean_soup)
    except Exception:
        clean_soup = raw_soup

    out: Dict[str, Any] = {
        "url": url,
        "empty_reason": None,
        "title_meta":         _signal_title_meta(raw_soup, query),
        "schema_types":       _signal_schema_types(raw_soup),
        "freshness":          _signal_freshness(raw_soup),
        "url_factors":        _signal_url_factors(url, query),
        "trust_links":        _signal_trust_links(clean_soup),
        "anchor_bank":        _signal_anchor_bank(clean_soup, url, query),
        "ux_profile":         _signal_ux_profile(clean_soup),
        "exact_occurrences":  _signal_exact_occurrences(clean_soup, query),
        "host_hygiene":       _signal_host_hygiene(raw_soup),
    }
    # Композитный score «усилия» (effort proxy) — плоский число для сортировки.
    out["effort_score"] = _compute_effort_score(out)
    return out


def compute_top_signals_aggregate(
    per_url: Sequence[Dict[str, Any]],
    query: str = "",
) -> Dict[str, Any]:
    """Сворачивает per-URL сигналы топа в агрегат + готовит требования
    для writer-стадий (`top_aggregate` + `algorithm_signals`).

    Возвращаемая структура соответствует контракту из плана:
        { top_aggregate: {...}, algorithm_signals: { google: {...}, yandex: {...} } }
    """
    docs = [d for d in (per_url or []) if d and not d.get("empty_reason")]
    n = len(docs)
    if n == 0:
        return {
            "top_aggregate": {},
            "algorithm_signals": {"google": {}, "yandex": {}},
            "doc_count": 0,
        }

    title_template = _agg_title_template(docs)
    schema_profile = _agg_schema_profile(docs, n)
    freshness_profile = _agg_freshness(docs)
    ux_profile = _agg_ux_profile(docs)
    slug_pattern = _agg_slug_pattern(docs)
    trust_quota = _agg_trust_quota(docs)
    anchor_bank = _agg_anchor_bank(docs)
    exact_targets = _agg_exact_targets(docs)
    host_hygiene = _agg_host_hygiene(docs, n)
    effort = _agg_effort(docs)

    top_aggregate = {
        "title_template":              title_template,
        "schema_profile":              schema_profile,
        "mandatory_schemas":           schema_profile["mandatory"],
        "freshness_profile":           freshness_profile,
        "ux_profile":                  ux_profile,
        "slug_pattern":                slug_pattern,
        "trust_link_quota":            trust_quota,
        "anchor_bank":                 anchor_bank,
        "exact_query_position_targets": exact_targets,
        "host_hygiene_checklist":      host_hygiene,
        "effort_target":               effort,
    }

    algorithm_signals = {
        "google": {
            "title_match_quality": title_template["title_h1_match_share_pct"],
            "effort_target":       effort,
            "freshness_pressure":  freshness_profile["freshness_pressure"],
            "schema_pressure":     schema_profile["pressure"],
            "ux_quality_target":   ux_profile["score_target"],
        },
        "yandex": {
            "exact_form_density":   exact_targets["density_target"],
            "trust_density":        trust_quota["per_1000_words_target"],
            "host_hygiene_score":   host_hygiene["score_target"],
            "slug_recommendation":  slug_pattern["recommendation"],
            "commercial_factors_score": None,  # волна 2: SERP-intent классификатор
        },
    }
    return {
        "top_aggregate":     top_aggregate,
        "algorithm_signals": algorithm_signals,
        "doc_count":         n,
    }


# ── Per-URL signal extractors ─────────────────────────────────────────────────

def _empty_signals(url: str) -> Dict[str, Any]:
    return {
        "url": url, "empty_reason": "no_html",
        "title_meta": {}, "schema_types": [], "freshness": {},
        "url_factors": {}, "trust_links": {}, "anchor_bank": {},
        "ux_profile": {}, "exact_occurrences": {}, "host_hygiene": {},
        "effort_score": 0.0,
    }


def _query_tokens(query: str) -> List[str]:
    if not query:
        return []
    return [m.group(0).lower() for m in _WORD_RE.finditer(query)]


def _exact_phrase_count(text: str, phrase: str) -> int:
    """Сколько раз ТОЧНАЯ словоформа `phrase` (как подстрока с границами) встречается."""
    if not text or not phrase:
        return 0
    pat = re.compile(r"(?<![A-Za-zА-Яа-яЁё0-9])" + re.escape(phrase) + r"(?![A-Za-zА-Яа-яЁё0-9])",
                     re.IGNORECASE)
    return sum(1 for _ in pat.finditer(text))


def _signal_title_meta(soup: BeautifulSoup, query: str) -> Dict[str, Any]:
    title_tag = soup.find("title")
    title = (title_tag.get_text(" ", strip=True) if title_tag else "") or ""
    title = re.sub(r"\s+", " ", title).strip()

    h1 = ""
    h1_tag = soup.find("h1")
    if h1_tag:
        h1 = re.sub(r"\s+", " ", h1_tag.get_text(" ", strip=True)).strip()

    meta_desc = ""
    meta_tag = soup.find("meta", attrs={"name": re.compile(r"^description$", re.I)})
    if meta_tag and meta_tag.get("content"):
        meta_desc = re.sub(r"\s+", " ", str(meta_tag["content"])).strip()

    q_lower = (query or "").lower().strip()
    q_tokens = _query_tokens(query)

    def _coverage(text: str) -> float:
        if not text or not q_tokens:
            return 0.0
        words = set(_query_tokens(text))
        hits = sum(1 for t in q_tokens if t in words)
        return round(100.0 * hits / max(len(q_tokens), 1), 1)

    def _exact_hits(text: str) -> int:
        return _exact_phrase_count(text or "", q_lower) if q_lower else 0

    def _exact_position(text: str) -> Optional[int]:
        if not text or not q_lower:
            return None
        idx = text.lower().find(q_lower)
        return idx if idx >= 0 else None

    title_match_h1 = bool(title and h1 and _norm(title) == _norm(h1))
    title_contains_h1 = bool(title and h1 and _norm(h1) in _norm(title))

    return {
        "title": title,
        "title_chars": len(title),
        "title_pixels_est": _approx_pixels(title),
        "title_query_exact_hits": _exact_hits(title),
        "title_query_exact_pos": _exact_position(title),
        "title_query_token_coverage_pct": _coverage(title),
        "title_has_year": bool(_YEAR_RE.search(title)),
        "title_has_number": bool(_NUMBER_RE.search(title)),
        "title_has_parens": bool(_PARENS_RE.search(title)),
        "title_modifiers": sorted({m.group(0).lower() for m in _CTR_MODIFIER_RE.finditer(title)}),

        "h1": h1,
        "h1_chars": len(h1),
        "h1_query_exact_hits": _exact_hits(h1),
        "h1_query_token_coverage_pct": _coverage(h1),

        "title_h1_exact_match": title_match_h1,
        "title_contains_h1":    title_contains_h1,

        "meta_description": meta_desc,
        "meta_description_chars": len(meta_desc),
        "meta_description_query_exact_hits": _exact_hits(meta_desc),
        "meta_description_query_token_coverage_pct": _coverage(meta_desc),
    }


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def _approx_pixels(s: str) -> int:
    """Очень грубая оценка ширины title в пикселях (Arial ~13px).
    Латиница ≈ 7px/символ, кириллица ≈ 8.5px/символ, пробел ≈ 4px."""
    if not s:
        return 0
    px = 0
    for ch in s:
        if ch == " ":
            px += 4
        elif _CYRIL_CHAR_RE.match(ch):
            px += 9
        elif _LATIN_CHAR_RE.match(ch):
            px += 7
        elif ch.isdigit():
            px += 7
        else:
            px += 5
    return px


def _signal_schema_types(soup: BeautifulSoup) -> List[Dict[str, Any]]:
    """Возвращает [{format, type}] для каждого встреченного объекта schema.org.

    Парсим:
      • JSON-LD (`<script type="application/ld+json">`),
      • microdata (`itemscope itemtype="https://schema.org/Article"`),
      • RDFa (`typeof="schema:Article"`).
    """
    out: List[Dict[str, Any]] = []

    # JSON-LD
    for sc in soup.find_all("script", attrs={"type": re.compile(r"ld\+json", re.I)}):
        raw = sc.string or sc.get_text() or ""
        if not raw or not raw.strip():
            continue
        # Часто кладут массивы / комментарии / trailing-коммы — мягко чистим.
        cleaned = re.sub(r"^\s*//.*$", "", raw, flags=re.MULTILINE)
        cleaned = re.sub(r",\s*([}\]])", r"\1", cleaned)
        try:
            data = json.loads(cleaned)
        except Exception:
            # пробуем извлечь хотя бы typeof через regex — лучше частичный
            # сигнал, чем потерять всю запись из-за syntax-error на чужом сайте.
            for m in re.finditer(r'"@type"\s*:\s*"([A-Za-z][\w:]+)"', raw):
                out.append({"format": "json-ld", "type": m.group(1)})
            continue
        for t in _walk_schema_types(data):
            out.append({"format": "json-ld", "type": t})
        if len(out) >= _MAX_SCHEMA_TYPES_PER_DOC:
            break

    # microdata
    for el in soup.find_all(attrs={"itemtype": True}):
        if len(out) >= _MAX_SCHEMA_TYPES_PER_DOC:
            break
        it = str(el.get("itemtype") or "").strip()
        m = re.search(r"schema\.org/([A-Za-z][\w]+)", it)
        if m:
            out.append({"format": "microdata", "type": m.group(1)})

    # RDFa
    for el in soup.find_all(attrs={"typeof": True}):
        if len(out) >= _MAX_SCHEMA_TYPES_PER_DOC:
            break
        tv = str(el.get("typeof") or "")
        for m in re.finditer(r"(?:schema:)?([A-Z][A-Za-z]+)", tv):
            out.append({"format": "rdfa", "type": m.group(1)})

    return out[:_MAX_SCHEMA_TYPES_PER_DOC]


def _walk_schema_types(data: Any) -> List[str]:
    """Рекурсивно собирает значения `@type` из JSON-LD."""
    found: List[str] = []
    if isinstance(data, dict):
        t = data.get("@type")
        if isinstance(t, str):
            found.append(t)
        elif isinstance(t, list):
            found.extend(str(x) for x in t if isinstance(x, str))
        for v in data.values():
            if isinstance(v, (dict, list)):
                found.extend(_walk_schema_types(v))
    elif isinstance(data, list):
        for it in data:
            found.extend(_walk_schema_types(it))
    return found


def _signal_freshness(soup: BeautifulSoup) -> Dict[str, Any]:
    """Извлекает datePublished / dateModified из любых доступных источников.

    Источники: JSON-LD, OpenGraph (`article:published_time` / `article:modified_time`),
    microdata (`itemprop="datePublished"`), визуально-видимые блоки «Обновлено …»
    мы пока не парсим (волна 2 — нужен NLP-парсер дат на русском).
    """
    published: Optional[str] = None
    modified: Optional[str] = None

    # 1) JSON-LD
    for sc in soup.find_all("script", attrs={"type": re.compile(r"ld\+json", re.I)}):
        raw = sc.string or sc.get_text() or ""
        if not raw:
            continue
        cleaned = re.sub(r",\s*([}\]])", r"\1", raw)
        try:
            data = json.loads(cleaned)
        except Exception:
            continue
        p, m = _walk_dates(data)
        published = published or p
        modified = modified or m

    # 2) <meta property="article:published_time">
    if not published:
        mp = soup.find("meta", attrs={"property": re.compile(r"article:published_time", re.I)})
        if mp and mp.get("content"):
            published = str(mp["content"]).strip()
    if not modified:
        mm = soup.find("meta", attrs={"property": re.compile(r"article:modified_time", re.I)})
        if mm and mm.get("content"):
            modified = str(mm["content"]).strip()

    # 3) microdata
    if not published:
        el = soup.find(attrs={"itemprop": re.compile(r"^datePublished$", re.I)})
        if el:
            published = (
                el.get("datetime") or el.get("content") or el.get_text(" ", strip=True)
            )
    if not modified:
        el = soup.find(attrs={"itemprop": re.compile(r"^dateModified$", re.I)})
        if el:
            modified = (
                el.get("datetime") or el.get("content") or el.get_text(" ", strip=True)
            )

    p_dt = _parse_date(published)
    m_dt = _parse_date(modified)
    today = _dt.date.today()
    age_published_days = (today - p_dt).days if p_dt else None
    age_modified_days = (today - m_dt).days if m_dt else None

    return {
        "date_published":     published,
        "date_modified":      modified,
        "age_published_days": age_published_days,
        "age_modified_days":  age_modified_days,
        "is_fresh_90":        bool(age_modified_days is not None and age_modified_days <= 90),
        "is_fresh_180":       bool(age_modified_days is not None and age_modified_days <= 180),
        "is_fresh_365":       bool(age_modified_days is not None and age_modified_days <= 365),
    }


def _walk_dates(data: Any) -> Tuple[Optional[str], Optional[str]]:
    """Возвращает (datePublished, dateModified) — первое попавшееся."""
    p, m = None, None
    if isinstance(data, dict):
        for k, v in data.items():
            kl = str(k).lower()
            if kl in ("datepublished", "publisheddate", "datecreated") and isinstance(v, str) and not p:
                p = v
            elif kl in ("datemodified", "modifieddate", "dateupdated") and isinstance(v, str) and not m:
                m = v
            elif isinstance(v, (dict, list)):
                pp, mm = _walk_dates(v)
                p = p or pp
                m = m or mm
    elif isinstance(data, list):
        for it in data:
            pp, mm = _walk_dates(it)
            p = p or pp
            m = m or mm
    return p, m


_DATE_FORMATS: Tuple[str, ...] = (
    "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%d.%m.%Y", "%d/%m/%Y", "%Y/%m/%d",
)


def _parse_date(s: Optional[str]) -> Optional[_dt.date]:
    if not s or not isinstance(s, str):
        return None
    s = s.strip()
    if not s:
        return None
    # Срезаем возможные миллисекунды и tz-suffix варианты.
    s2 = re.sub(r"\.\d+", "", s)
    s2 = re.sub(r"([+-]\d{2}):(\d{2})$", r"\1\2", s2)
    for fmt in _DATE_FORMATS:
        try:
            return _dt.datetime.strptime(s2, fmt).date()
        except Exception:
            pass
    # ISO-fallback
    try:
        return _dt.date.fromisoformat(s2[:10])
    except Exception:
        return None


def _signal_url_factors(url: str, query: str) -> Dict[str, Any]:
    if not url:
        return {}
    try:
        p = urlparse(url)
    except Exception:
        return {}
    path = p.path or ""
    slug = path.rstrip("/").rsplit("/", 1)[-1] if path.strip("/") else ""
    parts = [seg for seg in path.split("/") if seg]
    has_cyrillic = bool(_CYRIL_CHAR_RE.search(path))
    has_year = bool(_YEAR_RE.search(path))
    has_number = bool(_NUMBER_RE.search(path))
    q_tokens = _query_tokens(query)
    slug_tokens = re.split(r"[-_/]+", (slug or "").lower())
    slug_tokens = [t for t in slug_tokens if t]
    slug_query_tokens = sum(1 for t in q_tokens if t in slug_tokens)
    return {
        "scheme":          p.scheme or "",
        "host":            p.hostname or "",
        "path":            path,
        "slug":            slug,
        "depth_slashes":   len(parts),
        "url_chars":       len(url),
        "path_chars":      len(path),
        "slug_chars":      len(slug),
        "has_cyrillic":    has_cyrillic,
        "has_year":        has_year,
        "has_number":      has_number,
        "slug_query_token_hits": slug_query_tokens,
        "slug_kebab_case": bool(slug) and "_" not in slug and " " not in slug,
        "is_https":        p.scheme == "https",
    }


def _signal_trust_links(soup: BeautifulSoup) -> Dict[str, Any]:
    """Считает внешние ссылки и долю «trust»-доменов."""
    total = 0
    external = 0
    trust_external = 0
    samples: List[Dict[str, str]] = []
    page_host = ""
    for base in soup.find_all("base", href=True):
        try:
            page_host = urlparse(str(base["href"])).hostname or ""
        except Exception:
            page_host = ""
        break
    for a in soup.find_all("a", href=True):
        href = str(a["href"]).strip()
        if not href or href.startswith(("#", "mailto:", "tel:", "javascript:")):
            continue
        total += 1
        try:
            host = urlparse(href).hostname or ""
        except Exception:
            host = ""
        if not host:
            continue
        if page_host and host == page_host:
            continue
        external += 1
        host_l = host.lower()
        if any(pat in host_l for pat in _TRUST_HOST_PATTERNS):
            trust_external += 1
            if len(samples) < _MAX_TRUST_LINKS_PER_DOC:
                samples.append({
                    "host": host_l,
                    "anchor": a.get_text(" ", strip=True)[:120],
                })
    return {
        "total_links":      total,
        "external_links":   external,
        "trust_links":      trust_external,
        "trust_share_pct":  round(100.0 * trust_external / max(external, 1), 1) if external else 0.0,
        "samples":          samples,
    }


def _signal_anchor_bank(soup: BeautifulSoup, base_url: str, query: str) -> Dict[str, Any]:
    """Внутренние анкоры основной зоны: текст + контекст ±10 слов."""
    page_host = ""
    try:
        page_host = (urlparse(base_url).hostname or "").lower()
    except Exception:
        page_host = ""
    q_tokens = set(_query_tokens(query))
    anchors: List[Dict[str, Any]] = []
    classes = {"brand": 0, "exact": 0, "partial": 0, "generic": 0}
    GENERIC = {"тут", "здесь", "ссылка", "подробнее", "читать", "далее", "click", "here", "link"}
    for a in soup.find_all("a", href=True):
        href = str(a["href"]).strip()
        if not href or href.startswith(("#", "mailto:", "tel:", "javascript:")):
            continue
        try:
            host = (urlparse(href).hostname or "").lower()
        except Exception:
            host = ""
        is_internal = (not host) or (page_host and host == page_host)
        if not is_internal:
            continue
        text = a.get_text(" ", strip=True)
        if not text or len(text) > 200:
            continue
        text_l = text.lower()
        # Контекст: соседние 10 слов parent текста (приблизительно).
        ctx = ""
        try:
            parent = a.find_parent(["p", "li", "td", "div"])
            if parent:
                ctx = parent.get_text(" ", strip=True)
        except Exception:
            pass
        # Классификация
        if text_l in GENERIC or len(text) < 4:
            cls = "generic"
        elif page_host and page_host.split(".")[0] in text_l:
            cls = "brand"
        elif q_tokens and all(t in text_l for t in q_tokens):
            cls = "exact"
        elif q_tokens and any(t in text_l for t in q_tokens):
            cls = "partial"
        else:
            cls = "generic"
        classes[cls] += 1
        if len(anchors) < _MAX_ANCHORS_PER_DOC:
            anchors.append({
                "text": text[:200],
                "href": href[:300],
                "class": cls,
                "context_chars": len(ctx),
            })
    n = sum(classes.values()) or 1
    return {
        "count": sum(classes.values()),
        "classes": classes,
        "shares_pct": {k: round(100.0 * v / n, 1) for k, v in classes.items()},
        "samples": anchors,
        "diversity": _shannon_diversity(list(classes.values())),
    }


def _shannon_diversity(counts: Sequence[int]) -> float:
    """Нормированная Шенноновская энтропия [0..1] — мера разнообразия классов."""
    import math
    total = sum(counts)
    if total <= 0:
        return 0.0
    h = 0.0
    nonzero = 0
    for c in counts:
        if c <= 0:
            continue
        p = c / total
        h -= p * math.log(p)
        nonzero += 1
    if nonzero <= 1:
        return 0.0
    return round(h / math.log(nonzero), 3) if nonzero > 1 else 0.0


def _signal_ux_profile(soup: BeautifulSoup) -> Dict[str, Any]:
    """UX-прокси для NavBoost / dwell-time."""
    headings = extract_headings(_html_of(soup))
    h2_count = sum(1 for h in headings if h["level"] == "h2")
    h3_count = sum(1 for h in headings if h["level"] == "h3")
    paragraphs = soup.find_all("p")
    p_lens = [len(p.get_text(" ", strip=True)) for p in paragraphs if p.get_text(strip=True)]
    avg_p_len = round(sum(p_lens) / len(p_lens), 1) if p_lens else 0.0
    short_p_share = (
        round(100.0 * sum(1 for x in p_lens if x <= 360) / len(p_lens), 1) if p_lens else 0.0
    )
    # Above-the-fold: символы до первого h2.
    full_text = soup.get_text(" ", strip=True)
    full_text = re.sub(r"\s+", " ", full_text or "")
    word_count = sum(1 for _ in _WORD_RE.finditer(full_text))
    above_fold_chars = 0
    h2_first = soup.find("h2")
    if h2_first:
        # Все predecessors до h2 — heuristic: префикс полного текста до текста h2.
        h2_txt = h2_first.get_text(" ", strip=True)
        idx = full_text.find(h2_txt) if h2_txt else -1
        above_fold_chars = idx if idx > 0 else len(full_text)
    else:
        above_fold_chars = len(full_text)
    has_toc = bool(soup.find(attrs={"class": re.compile(r"toc|table[-_]of[-_]contents", re.I)})) \
        or bool(_TOC_HEAD_RE.search(full_text[:2000]))
    has_faq_early = bool(_FAQ_HEAD_RE.search(full_text[:above_fold_chars + 1500]))
    has_tldr = bool(_TLDR_HEAD_RE.search(full_text[:above_fold_chars + 1500]))
    # Первое изображение
    first_img = soup.find("img")
    first_img_alt = ""
    first_img_alt_chars = 0
    if first_img:
        first_img_alt = str(first_img.get("alt") or "").strip()
        first_img_alt_chars = len(first_img_alt)
    headings_per_1k = (
        round(1000.0 * (h2_count + h3_count) / max(word_count, 1), 2) if word_count else 0.0
    )
    media_count = {
        "img":    len(soup.find_all("img")),
        "video":  len(soup.find_all("video")),
        "table":  len(soup.find_all("table")),
        "figure": len(soup.find_all("figure")),
        "details": len(soup.find_all("details")),
        "iframe": len(soup.find_all("iframe")),
    }
    return {
        "h2_count":          h2_count,
        "h3_count":          h3_count,
        "headings_per_1k_words": headings_per_1k,
        "paragraph_count":   len(p_lens),
        "avg_paragraph_chars": avg_p_len,
        "short_paragraph_share_pct": short_p_share,
        "above_the_fold_chars":  above_fold_chars,
        "above_the_fold_words":  sum(1 for _ in _WORD_RE.finditer(full_text[:above_fold_chars])),
        "has_toc":           has_toc,
        "has_faq_early":     has_faq_early,
        "has_tldr_early":    has_tldr,
        "first_image_alt":   first_img_alt[:200],
        "first_image_alt_chars": first_img_alt_chars,
        "media_count":       media_count,
        "word_count":        word_count,
    }


def _html_of(soup: BeautifulSoup) -> str:
    """Безопасно сериализует soup обратно в HTML (для повторного парсинга
    extract_headings, который ждёт сырой HTML, а не Soup)."""
    try:
        return str(soup)
    except Exception:
        return ""


def _signal_exact_occurrences(soup: BeautifulSoup, query: str) -> Dict[str, Any]:
    """Точные вхождения query в позиционных зонах — Yandex FI_BCLM_*."""
    if not query:
        return {
            "first_100_words": 0, "first_200_words": 0, "first_300_words": 0,
            "first_paragraph": 0, "last_paragraph": 0,
            "in_h2": 0, "in_h3": 0, "in_alt": 0, "total": 0,
        }
    q = query.strip().lower()
    # full text
    full = re.sub(r"\s+", " ", soup.get_text(" ", strip=True) or "").lower()
    words = full.split(" ")
    f100 = " ".join(words[:100])
    f200 = " ".join(words[:200])
    f300 = " ".join(words[:300])
    paragraphs = [p.get_text(" ", strip=True) for p in soup.find_all("p")]
    paragraphs = [p for p in paragraphs if p]
    first_p = paragraphs[0].lower() if paragraphs else ""
    last_p = paragraphs[-1].lower() if paragraphs else ""
    h2_text = " ".join(h.get_text(" ", strip=True) for h in soup.find_all("h2")).lower()
    h3_text = " ".join(h.get_text(" ", strip=True) for h in soup.find_all("h3")).lower()
    alt_text = " ".join(str(im.get("alt") or "") for im in soup.find_all("img")).lower()
    return {
        "first_100_words": _exact_phrase_count(f100, q),
        "first_200_words": _exact_phrase_count(f200, q),
        "first_300_words": _exact_phrase_count(f300, q),
        "first_paragraph": _exact_phrase_count(first_p, q),
        "last_paragraph":  _exact_phrase_count(last_p, q),
        "in_h2":           _exact_phrase_count(h2_text, q),
        "in_h3":           _exact_phrase_count(h3_text, q),
        "in_alt":          _exact_phrase_count(alt_text, q),
        "total":           _exact_phrase_count(full, q),
    }


def _signal_host_hygiene(soup: BeautifulSoup) -> Dict[str, Any]:
    """SEO-гигиена страницы — лёгкие булевы метрики, прокси для hostrank."""
    head_html = ""
    head = soup.find("head")
    try:
        head_html = str(head) if head else str(soup)[:50000]
    except Exception:
        head_html = ""
    raw_html = ""
    try:
        raw_html = str(soup)
    except Exception:
        raw_html = ""
    has_canonical = bool(soup.find("link", attrs={"rel": re.compile(r"^canonical$", re.I)}))
    has_hreflang = bool(soup.find("link", attrs={"rel": re.compile(r"^alternate$", re.I), "hreflang": True}))
    has_og = any(
        soup.find("meta", attrs={"property": re.compile(rf"^og:{k}$", re.I)})
        for k in ("title", "description", "image", "url", "type")
    )
    has_twitter = any(
        soup.find("meta", attrs={"name": re.compile(rf"^twitter:{k}$", re.I)})
        for k in ("card", "title", "description", "image")
    )
    has_sitemap_link = bool(re.search(r'href="[^"]*sitemap[^"]*"', head_html, re.IGNORECASE))
    has_yandex_metrika = bool(_YANDEX_METRIKA_RE.search(raw_html))
    has_ga = bool(_GA_RE.search(raw_html))
    # Автор: либо JSON-LD Person, либо <meta name="author">, либо rel=author.
    has_author = bool(soup.find("meta", attrs={"name": re.compile(r"^author$", re.I)})) \
        or bool(soup.find("a", attrs={"rel": re.compile(r"author", re.I)})) \
        or bool(re.search(r'"@type"\s*:\s*"Person"', raw_html))
    return {
        "has_canonical":     has_canonical,
        "has_hreflang":      has_hreflang,
        "has_open_graph":    has_og,
        "has_twitter_cards": has_twitter,
        "has_sitemap_link":  has_sitemap_link,
        "has_yandex_metrika": has_yandex_metrika,
        "has_google_analytics": has_ga,
        "has_author_signal": has_author,
    }


def _compute_effort_score(sig: Dict[str, Any]) -> float:
    """Композитный 0..100 «эффорт-скор»: чем выше, тем больше «усилий»
    вложено в страницу (прокси для contentEffort из утечки Google).

    Формула эвристическая, цель — сравнимость в рамках одного отчёта.
    """
    ux = sig.get("ux_profile") or {}
    schema = sig.get("schema_types") or []
    trust = sig.get("trust_links") or {}
    media = ux.get("media_count") or {}
    score = 0.0
    score += min(20.0, 0.4 * (ux.get("h2_count") or 0))                    # структура
    score += min(15.0, 1.5 * (ux.get("h3_count") or 0))                    # подразделы
    score += min(10.0, 0.05 * (ux.get("word_count") or 0))                 # объём
    score += min(10.0, 1.0 * (media.get("img") or 0))                      # картинки
    score += min(10.0, 5.0 * (media.get("video") or 0))                    # видео
    score += min(10.0, 3.0 * (media.get("table") or 0))                    # таблицы
    score += min(10.0, 2.0 * (media.get("figure") or 0))                   # фигуры
    score += min(5.0,  2.0 * (media.get("details") or 0))                  # FAQ-аккордеон
    score += min(5.0,  1.0 * len(schema))                                  # schema-разметка
    score += min(5.0,  1.0 * (trust.get("trust_links") or 0))              # trust-ссылки
    return round(min(100.0, score), 1)


# ── Aggregators ───────────────────────────────────────────────────────────────

def _med(xs: Sequence[float]) -> Optional[float]:
    xs = [x for x in xs if x is not None]
    return round(float(median(xs)), 1) if xs else None


def _med_int(xs: Sequence[Optional[int]]) -> Optional[int]:
    xs = [int(x) for x in xs if x is not None]
    return int(median(xs)) if xs else None


def _agg_title_template(docs: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    titles = [d["title_meta"].get("title", "") for d in docs]
    chars = [d["title_meta"].get("title_chars", 0) for d in docs]
    pixels = [d["title_meta"].get("title_pixels_est", 0) for d in docs]
    has_year = sum(1 for d in docs if d["title_meta"].get("title_has_year"))
    has_num = sum(1 for d in docs if d["title_meta"].get("title_has_number"))
    has_paren = sum(1 for d in docs if d["title_meta"].get("title_has_parens"))
    title_h1_match = sum(1 for d in docs if d["title_meta"].get("title_h1_exact_match"))
    n = len(docs)
    # Топ модификаторов
    mod_counter: Counter = Counter()
    for d in docs:
        for m in d["title_meta"].get("title_modifiers", []) or []:
            mod_counter[m] += 1
    # Шаблон H1 (медиана length)
    h1_chars = [d["title_meta"].get("h1_chars", 0) for d in docs]
    return {
        "titles_sample":              titles[:10],
        "title_chars_median":         _med(chars) or 0.0,
        "title_chars_min":            min(chars) if chars else 0,
        "title_chars_max":            max(chars) if chars else 0,
        "title_pixels_median_est":    _med(pixels) or 0.0,
        "title_has_year_share_pct":   round(100.0 * has_year / n, 1),
        "title_has_number_share_pct": round(100.0 * has_num / n, 1),
        "title_has_parens_share_pct": round(100.0 * has_paren / n, 1),
        "title_h1_match_share_pct":   round(100.0 * title_h1_match / n, 1),
        "h1_chars_median":            _med(h1_chars) or 0.0,
        "modifiers_top": [
            {"modifier": m, "share_pct": round(100.0 * c / n, 1)}
            for m, c in mod_counter.most_common(15)
        ],
        "exact_query_in_title_share_pct": round(
            100.0 * sum(1 for d in docs if d["title_meta"].get("title_query_exact_hits", 0) > 0) / n,
            1,
        ),
    }


def _agg_schema_profile(docs: Sequence[Dict[str, Any]], n: int) -> Dict[str, Any]:
    type_counter: Counter = Counter()
    for d in docs:
        seen = {t["type"] for t in (d.get("schema_types") or []) if t.get("type")}
        for t in seen:
            type_counter[t] += 1
    rows = [
        {"type": t, "df": c, "share_pct": round(100.0 * c / n, 1)}
        for t, c in type_counter.most_common(_MAX_AGG_SCHEMA_TYPES)
    ]
    # Mandatory: типы, встретившиеся ≥ 50% топа.
    mandatory = [r["type"] for r in rows if r["share_pct"] >= 50.0]
    pressure = round(100.0 * (len(mandatory) > 0) + 0.0, 1) if mandatory else round(
        100.0 * sum(r["share_pct"] for r in rows[:5]) / max(len(rows[:5]), 1) / 100.0 * 50.0, 1
    )
    return {
        "types":     rows,
        "mandatory": mandatory,
        "pressure":  pressure,  # «насколько сильно schema-разметка нужна» 0..100
    }


def _agg_freshness(docs: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    pub_ages = [d["freshness"].get("age_published_days") for d in docs]
    mod_ages = [d["freshness"].get("age_modified_days") for d in docs]
    fresh_90 = sum(1 for d in docs if d["freshness"].get("is_fresh_90"))
    fresh_180 = sum(1 for d in docs if d["freshness"].get("is_fresh_180"))
    fresh_365 = sum(1 for d in docs if d["freshness"].get("is_fresh_365"))
    n = len(docs)
    # Fresh-pressure: какова доля «свежих» в топе.
    pressure = round(100.0 * fresh_180 / n, 1)
    return {
        "median_age_published_days": _med_int(pub_ages),
        "median_age_modified_days":  _med_int(mod_ages),
        "share_fresh_90_pct":        round(100.0 * fresh_90 / n, 1),
        "share_fresh_180_pct":       round(100.0 * fresh_180 / n, 1),
        "share_fresh_365_pct":       round(100.0 * fresh_365 / n, 1),
        "freshness_pressure":        pressure,
        "current_year":              _dt.date.today().year,
    }


def _agg_ux_profile(docs: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    h2 = [d["ux_profile"].get("h2_count", 0) for d in docs]
    h3 = [d["ux_profile"].get("h3_count", 0) for d in docs]
    abovefold = [d["ux_profile"].get("above_the_fold_chars", 0) for d in docs]
    avg_p = [d["ux_profile"].get("avg_paragraph_chars", 0) for d in docs]
    headings_density = [d["ux_profile"].get("headings_per_1k_words", 0) for d in docs]
    has_toc = sum(1 for d in docs if d["ux_profile"].get("has_toc"))
    has_faq = sum(1 for d in docs if d["ux_profile"].get("has_faq_early"))
    has_tldr = sum(1 for d in docs if d["ux_profile"].get("has_tldr_early"))
    has_alt = sum(1 for d in docs if d["ux_profile"].get("first_image_alt_chars", 0) > 0)
    n = len(docs)
    score_target = round(
        100.0 * (has_toc + has_faq + has_tldr + has_alt) / (4 * n), 1
    )
    return {
        "h2_count_median":              _med(h2),
        "h3_count_median":              _med(h3),
        "above_the_fold_chars_median":  _med(abovefold),
        "avg_paragraph_chars_median":   _med(avg_p),
        "headings_per_1k_words_median": _med(headings_density),
        "share_with_toc_pct":           round(100.0 * has_toc / n, 1),
        "share_with_faq_early_pct":     round(100.0 * has_faq / n, 1),
        "share_with_tldr_early_pct":    round(100.0 * has_tldr / n, 1),
        "share_with_first_img_alt_pct": round(100.0 * has_alt / n, 1),
        "score_target":                 score_target,
    }


def _agg_slug_pattern(docs: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    slugs = [d["url_factors"].get("slug_chars", 0) for d in docs if d.get("url_factors")]
    depths = [d["url_factors"].get("depth_slashes", 0) for d in docs if d.get("url_factors")]
    cyril = sum(1 for d in docs if d.get("url_factors", {}).get("has_cyrillic"))
    has_year = sum(1 for d in docs if d.get("url_factors", {}).get("has_year"))
    has_query = sum(1 for d in docs if (d.get("url_factors", {}).get("slug_query_token_hits") or 0) > 0)
    n = len(docs)
    rec = []
    if slugs:
        rec.append(f"длина slug ~{_med(slugs)} симв.")
    if depths:
        rec.append(f"глубина URL ~{_med(depths)}")
    if 100.0 * has_query / n >= 50.0:
        rec.append("включить ключевые слова в slug")
    if 100.0 * cyril / n >= 60.0:
        rec.append("использовать кириллицу в slug")
    elif 100.0 * cyril / n <= 20.0:
        rec.append("использовать транслит/латиницу в slug")
    return {
        "slug_chars_median":          _med(slugs),
        "depth_slashes_median":       _med(depths),
        "share_cyrillic_url_pct":     round(100.0 * cyril / n, 1),
        "share_year_in_url_pct":      round(100.0 * has_year / n, 1),
        "share_slug_has_query_pct":   round(100.0 * has_query / n, 1),
        "recommendation":             "; ".join(rec) if rec else "",
    }


def _agg_trust_quota(docs: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    trust = [d["trust_links"].get("trust_links", 0) for d in docs]
    external = [d["trust_links"].get("external_links", 0) for d in docs]
    word_counts = [d["ux_profile"].get("word_count", 0) for d in docs]
    per_1k_values: List[float] = []
    for t, w in zip(trust, word_counts):
        if w > 0:
            per_1k_values.append(1000.0 * t / w)
    return {
        "trust_links_median":    _med([float(x) for x in trust]),
        "external_links_median": _med([float(x) for x in external]),
        "per_1000_words_target": _med(per_1k_values) or 0.0,
        "share_with_any_trust_pct": round(
            100.0 * sum(1 for t in trust if t > 0) / max(len(trust), 1), 1,
        ),
    }


def _agg_anchor_bank(docs: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    bag: Counter = Counter()
    cls_totals = Counter()
    for d in docs:
        ab = d.get("anchor_bank") or {}
        for s in (ab.get("samples") or []):
            text = (s.get("text") or "").strip().lower()
            if text and len(text) >= 4:
                bag[text] += 1
        for k, v in (ab.get("classes") or {}).items():
            cls_totals[k] += int(v or 0)
    top = bag.most_common(_MAX_AGG_ANCHORS)
    n_cls = sum(cls_totals.values()) or 1
    return {
        "top_anchors": [{"text": t, "df": c} for t, c in top],
        "class_shares_pct": {
            k: round(100.0 * v / n_cls, 1) for k, v in cls_totals.items()
        },
    }


def _agg_exact_targets(docs: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    keys = ("first_100_words", "first_200_words", "first_300_words",
            "first_paragraph", "last_paragraph", "in_h2", "in_h3", "in_alt", "total")
    out: Dict[str, Any] = {}
    for k in keys:
        vals = [d["exact_occurrences"].get(k, 0) for d in docs]
        out[k + "_median"] = _med([float(x) for x in vals])
    word_counts = [d["ux_profile"].get("word_count", 0) for d in docs]
    totals = [d["exact_occurrences"].get("total", 0) for d in docs]
    densities = [
        1000.0 * t / w for t, w in zip(totals, word_counts) if w > 0
    ]
    out["density_target"] = _med(densities) or 0.0  # вхождений на 1000 слов
    return out


def _agg_host_hygiene(docs: Sequence[Dict[str, Any]], n: int) -> Dict[str, Any]:
    keys = ("has_canonical", "has_hreflang", "has_open_graph", "has_twitter_cards",
            "has_sitemap_link", "has_yandex_metrika", "has_google_analytics",
            "has_author_signal")
    shares: Dict[str, float] = {}
    for k in keys:
        c = sum(1 for d in docs if d["host_hygiene"].get(k))
        shares[k] = round(100.0 * c / n, 1)
    score_target = round(sum(shares.values()) / len(shares), 1) if shares else 0.0
    # Чеклист «обязательно» = >= 50% топа имеет.
    must_have = [k for k, v in shares.items() if v >= 50.0]
    return {
        "shares_pct":   shares,
        "must_have":    must_have,
        "score_target": score_target,
    }


def _agg_effort(docs: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    scores = [float(d.get("effort_score") or 0.0) for d in docs]
    top3 = sorted(scores, reverse=True)[:3]
    return {
        "effort_score_median": _med(scores),
        "effort_score_top3_min": round(min(top3), 1) if top3 else 0.0,
        "effort_score_max":      round(max(scores), 1) if scores else 0.0,
    }
