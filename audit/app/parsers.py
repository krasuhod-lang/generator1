import asyncio
import logging
import json
import hashlib
import os
import re
from html import unescape
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urljoin, urlparse
import dspy
from bs4 import BeautifulSoup
import aiohttp
from protego import Protego

from .page_parser import _clean_text, _same_domain, base_hostname
from .fetcher import fetch_page
from .store import _redis
from .ai_response_normalizer import normalize_llm_response, normalize_lm_history

logger = logging.getLogger("audit.parsers")

# Модель DeepSeek для парсера. По умолчанию — глубокая deepseek-v4-pro,
# как заявлено в UI. Переопределяется через окружение.
DEEPSEEK_PARSER_MODEL = os.getenv("DEEPSEEK_PARSER_MODEL") or os.getenv("DEEPSEEK_MODEL") or "deepseek-v4-pro"
DEEPSEEK_API_BASE = os.getenv("DEEPSEEK_BASE_URL") or "https://api.deepseek.com"
DEEPSEEK_API_KEY = (os.getenv("DEEPSEEK_API_KEY") or "").strip()

# Максимум внутренних подстраниц, докачиваемых сверх главной. Поднят, чтобы
# успевали попасть страницы клиентов/кейсов/портфолио без взрыва задержки.
MAX_SUBPAGES = int(os.getenv("PARSER_MAX_SUBPAGES") or 8)

# Глубина мини-краула внутри одного сайта. Парсер контента — не полный SEO-аудит,
# но должен вести себя как ограниченный паук, а не читать только главную.
PARSER_MAX_DEPTH = int(os.getenv("PARSER_MAX_DEPTH") or 2)

# Верхний предел очереди обнаруженных URL, чтобы случайный сайт с мегаменю не
# раздувал память и не превращал извлечение одного сайта в полноценный краул.
DISCOVERY_CANDIDATE_LIMIT = int(os.getenv("PARSER_DISCOVERY_CANDIDATE_LIMIT") or 80)
SITEMAP_DISCOVERY_LIMIT = int(os.getenv("PARSER_SITEMAP_DISCOVERY_LIMIT") or 40)

# Сколько подстраниц качаем параллельно (asyncio.gather с ограничением).
SUBPAGE_CONCURRENCY = int(os.getenv("PARSER_SUBPAGE_CONCURRENCY") or 4)

# Result cache is opt-in. Every parser task is fresh by default so a previous
# run cannot hide a current block/LLM failure. When enabled, only successful
# results are cached under a versioned/model-aware key.
PARSER_CACHE_ENABLED = (os.getenv("PARSER_CACHE_ENABLED") or "0").strip().lower() in {"1", "true", "yes", "on"}
CACHE_TTL_SECONDS = int(os.getenv("PARSER_CACHE_TTL_SECONDS") or 259200)
CACHE_SCHEMA_VERSION = "v3"

# Паттерны внутренних ссылок, по которым ищем подстраницы с доказательной базой
# (услуги/о компании/контакты + клиенты/кейсы/портфолио/проекты/партнёры/отзывы).
LINK_PATTERNS = [
    "/about", "/contact", "/service", "/услуги", "/контакты", "/о-компании",
    "/clients", "/клиенты", "/cases", "/кейсы", "/portfolio", "/портфолио",
    "/projects", "/проекты", "/partners", "/партнеры", "/reviews", "/otzyvy", "/отзывы",
]

AUDIENCE_LINK_HINTS = [
    "client", "customer", "case", "portfolio", "project", "partner", "review",
    "industry", "industries", "solution", "solutions", "segment", "audience",
    "for-", "/for/", "для-", "/для/", "клиент", "заказчик", "кейс", "проект",
    "портфолио", "партнер", "партнёр", "отзыв", "отрасл", "решени", "кому",
    "supplier", "vendor", "buyer", "procurement", "tender", "trade", "purchase",
    "поставщик", "подрядчик", "заказчик", "закуп", "тендер", "торг", "контракт",
]

NOISY_LINK_HINTS = [
    "/login", "/register", "/cart", "/basket", "/checkout", "/privacy",
    "/policy", "/terms", "/user", "/account", "/wp-admin", "/tag/", "/feed",
    "utm_", "print=", "sort=", "filter=", "add-to-cart",
]

# Ссылки, которые заведомо не являются навигацией по сайту.
_SKIP_HREF_PREFIXES = ("mailto:", "tel:", "javascript:", "#", "data:")

_NON_HTML_EXTENSIONS = (
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".zip",
    ".rar", ".7z", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg",
    ".css", ".js", ".mp4", ".mp3", ".avi", ".mov",
)

CLIENT_FALLBACKS = {
    "not_found": {
        "client_segments": "Не определено — на сайте нет явных данных о категориях клиентов",
        "works_with": "Не определено — на сайте нет явных указаний, с кем работает компания",
    },
    "fetch_error": {
        "client_segments": "Не определено — сайт недоступен или не удалось получить его содержимое",
        "works_with": "Не определено — анализ невозможен из-за ошибки доступа к сайту",
    },
    "blocked": {
        "client_segments": "Не определено — автоматический доступ к сайту заблокирован",
        "works_with": "Не определено — сайт запретил автоматический анализ",
    },
    "llm_error": {
        "client_segments": "Не удалось определить — ошибка анализа ИИ",
        "works_with": "Не удалось определить — ошибка анализа ИИ",
    },
}

AUDIENCE_SIGNAL_RE = re.compile(
    r"(работа(?:ем|ет|ют)\s+с|для\s+[а-яa-z]|наши\s+клиент|клиент(?:ы|ам|ов)|"
    r"заказчик|кейсы?|портфолио|проекты?|отрасл|решени[ея]\s+для|"
    r"\bB2B\b|\bB2C\b|\bB2G\b)",
    re.IGNORECASE,
)


async def _robots_allowed(session: aiohttp.ClientSession, url: str) -> Tuple[bool, Optional[str]]:
    """Respect robots.txt for this parser run; never use old cross-run decisions."""
    parsed = urlparse(url)
    if not parsed.scheme or not parsed.netloc:
        return False, "invalid_url"
    robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
    try:
        timeout = aiohttp.ClientTimeout(total=10, connect=5, sock_read=8)
        async with session.get(robots_url, timeout=timeout, allow_redirects=True) as response:
            if response.status >= 400:
                return True, None
            text = await response.text(errors="replace")
        if not text.strip():
            return True, None
        policy = Protego.parse(text)
        if not policy.can_fetch("*", url):
            return False, "robots_disallow"
    except Exception:
        # Unavailable robots.txt is not treated as a blanket denial; the actual
        # page request still produces its own explicit access status.
        return True, None
    return True, None


async def _discover_sitemap_links(
    session: aiohttp.ClientSession,
    base_url: str,
    base_host: str,
) -> List[Tuple[str, int]]:
    """Discover relevant same-domain pages from standard XML sitemaps.

    Many accessible sites render navigation through JavaScript or expose only a
    small mobile menu in HTML. Sitemap discovery keeps the parser useful without
    bypassing access controls and is bounded to a small number of candidates.
    """
    parsed = urlparse(base_url)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    sitemap_candidates = [
        f"{origin}/sitemap.xml",
        f"{origin}/sitemap_index.xml",
        f"{origin}/sitemap-index.xml",
    ]
    sitemap_queue = list(sitemap_candidates)
    seen_sitemaps = set()
    found: Dict[str, int] = {}
    timeout = aiohttp.ClientTimeout(total=12, connect=5, sock_read=10)

    while sitemap_queue and len(seen_sitemaps) < 4 and len(found) < SITEMAP_DISCOVERY_LIMIT:
        sitemap_url = sitemap_queue.pop(0)
        if sitemap_url in seen_sitemaps:
            continue
        seen_sitemaps.add(sitemap_url)
        try:
            allowed, _reason = await _robots_allowed(session, sitemap_url)
            if not allowed:
                continue
            async with session.get(sitemap_url, timeout=timeout, allow_redirects=True) as response:
                if response.status >= 400:
                    continue
                body = await response.text(errors="replace")
            locs = [unescape(value).strip() for value in re.findall(r"<loc[^>]*>(.*?)</loc>", body, re.IGNORECASE | re.DOTALL)]
            for raw_loc in locs:
                loc = _normalize_internal_link(base_url, raw_loc, base_host)
                if loc:
                    haystack = loc.casefold()
                    score = 90 if any(hint.casefold() in haystack for hint in AUDIENCE_LINK_HINTS) else 20
                    if score > 20 or len(found) < max(5, SITEMAP_DISCOVERY_LIMIT // 5):
                        found[loc] = max(found.get(loc, -1), score)
                elif raw_loc.lower().endswith((".xml", ".xml.gz")) and len(sitemap_queue) < 3:
                    sitemap_queue.append(raw_loc)
        except Exception as exc:
            logger.debug("sitemap discovery failed for %s: %s", sitemap_url, exc)

    return sorted(found.items(), key=lambda item: item[1], reverse=True)[:SITEMAP_DISCOVERY_LIMIT]


def _normalize_internal_link(base_url: str, raw_href: str, base_host: str) -> Optional[str]:
    href = (raw_href or "").strip()
    if not href or href.lower().startswith(_SKIP_HREF_PREFIXES):
        return None
    full_url = urljoin(base_url, href).split("#")[0].strip()
    if not full_url.startswith(("http://", "https://")):
        return None
    if urlparse(full_url).path.lower().endswith(_NON_HTML_EXTENSIONS):
        return None
    if not _same_domain(full_url, base_host):
        return None
    return full_url


def _base_result(url: str, title: str = "", task_id: Optional[str] = None, item_id: Optional[str] = None) -> Dict[str, Any]:
    return {
        "url": url,
        "title": title,
        "execution": {
            "run_id": task_id or "",
            "item_id": item_id or "",
            "result_source": "fresh",
        },
        "contacts": "",
        "about": "",
        "services": [],
        "focus": "",
        "client_segments": [],
        "works_with": "",
        "status": "ok",
        "field_status": {},
        "evidence": [],
        "warnings": [],
        "stats": {"pages_scanned": 0},
    }


def _requested_status_fields(
    *,
    extract_contacts: bool,
    extract_about: bool,
    extract_services: bool,
    extract_clients: bool,
) -> List[str]:
    fields: List[str] = []
    if extract_contacts:
        fields.append("contacts")
    if extract_about:
        fields.append("about")
    if extract_services:
        fields.extend(["services", "focus"])
    if extract_clients:
        fields.extend(["client_segments", "works_with"])
    return fields


def _mark_requested_statuses(result: Dict[str, Any], status: str, **flags: bool) -> None:
    for field in _requested_status_fields(**flags):
        result.setdefault("field_status", {})[field] = status


def _append_warning(result: Dict[str, Any], warning: str) -> None:
    warning = (warning or "").strip()
    if warning:
        result.setdefault("warnings", []).append(warning[:500])


def _apply_client_fallback(result: Dict[str, Any], status: str) -> None:
    fallback = CLIENT_FALLBACKS.get(status) or CLIENT_FALLBACKS["not_found"]
    result["client_segments"] = [fallback["client_segments"]]
    result["works_with"] = fallback["works_with"]
    result.setdefault("field_status", {})["client_segments"] = status
    result.setdefault("field_status", {})["works_with"] = status


def _access_failure_result(
    url: str,
    *,
    task_id: Optional[str],
    item_id: Optional[str],
    access_status: str,
    error_code: str,
    message: str,
    status_code: Optional[int] = None,
    method: Optional[str] = None,
    final_url: Optional[str] = None,
    diagnostics: Optional[Dict[str, Any]] = None,
    extract_contacts: bool,
    extract_about: bool,
    extract_services: bool,
    extract_clients: bool,
) -> Dict[str, Any]:
    result = _base_result(url, task_id=task_id, item_id=item_id)
    result["status"] = access_status
    result["error_code"] = error_code
    result["error"] = message[:1000]
    result["access"] = {
        "status": access_status,
        "status_code": status_code,
        "method": method,
        "final_url": final_url or url,
        "diagnostics": diagnostics or {},
    }
    _mark_requested_statuses(
        result,
        access_status,
        extract_contacts=extract_contacts,
        extract_about=extract_about,
        extract_services=extract_services,
        extract_clients=extract_clients,
    )
    if extract_clients:
        _apply_client_fallback(result, access_status)
    return result


def _mark_non_client_field_statuses(
    result: Dict[str, Any],
    *,
    extract_contacts: bool,
    extract_about: bool,
    extract_services: bool,
    missing_status: str = "not_found",
) -> None:
    field_status = result.setdefault("field_status", {})
    if extract_contacts:
        field_status["contacts"] = "found" if result.get("contacts") else missing_status
    if extract_about:
        field_status["about"] = "found" if result.get("about") else missing_status
    if extract_services:
        field_status["services"] = "found" if result.get("services") else missing_status
        field_status["focus"] = "found" if result.get("focus") else missing_status


def _short_quote(text: str, limit: int = 240) -> str:
    text = re.sub(r"\s+", " ", (text or "")).strip()
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(" ", 1)[0].strip() + "…"


def _signal_type(text: str) -> str:
    low = (text or "").lower()
    if "кейс" in low or "case" in low:
        return "case"
    if "портфолио" in low or "portfolio" in low or "проект" in low:
        return "case"
    if "услуг" in low or "service" in low or "решени" in low:
        return "service_page"
    if "заяв" in low or "остав" in low or "получ" in low:
        return "cta"
    if "о компании" in low or "about" in low:
        return "about"
    return "explicit_phrase"


def _sentences(text: str) -> List[str]:
    parts = re.split(r"(?<=[.!?。！？])\s+|\n+", text or "")
    return [p.strip() for p in parts if p and p.strip()]


def _extract_audience_evidence(page_texts: List[Dict[str, str]], limit: int = 20) -> List[Dict[str, Any]]:
    evidence: List[Dict[str, Any]] = []
    seen = set()
    for page in page_texts:
        page_url = page.get("url") or ""
        for sentence in _sentences(page.get("text") or ""):
            if not AUDIENCE_SIGNAL_RE.search(sentence):
                continue
            quote = _short_quote(sentence)
            if len(quote) < 20:
                continue
            key = (page_url, quote.casefold())
            if key in seen:
                continue
            seen.add(key)
            evidence.append({
                "field": "client_segments",
                "url": page_url,
                "quote": quote,
                "signal_type": _signal_type(quote),
                "confidence": 0.8,
            })
            if len(evidence) >= limit:
                return evidence
    return evidence


def _evidence_tokens(text: str) -> set[str]:
    tokens = set()
    for token in re.findall(r"[a-zа-яё0-9]{4,}", (text or "").casefold()):
        if token in {"клиенты", "компании", "бизнес", "заказчики", "услуги", "работаем"}:
            continue
        tokens.add(token)
        if len(token) >= 6:
            tokens.add(token[:6])
    return tokens


def _client_evidence_for_segments(
    segments: List[str],
    works_with: str,
    audience_evidence: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    if not audience_evidence:
        return []
    out: List[Dict[str, Any]] = []
    used = set()
    for segment in segments:
        segment_tokens = _evidence_tokens(segment)
        candidates = []
        for idx, evidence in enumerate(audience_evidence):
            if idx in used:
                continue
            quote_tokens = _evidence_tokens(evidence.get("quote") or "")
            overlap = len(segment_tokens & quote_tokens)
            if overlap:
                candidates.append((overlap, idx, evidence))
        if candidates:
            _overlap, idx, evidence = max(candidates, key=lambda row: row[0])
            ev = dict(evidence)
            ev["field"] = "client_segments"
            ev["confidence"] = min(0.95, 0.75 + 0.05 * _overlap)
            out.append(ev)
            used.add(idx)

    if works_with:
        works_tokens = _evidence_tokens(works_with)
        candidates = []
        for idx, evidence in enumerate(audience_evidence):
            quote_tokens = _evidence_tokens(evidence.get("quote") or "")
            overlap = len(works_tokens & quote_tokens)
            if overlap:
                candidates.append((overlap, idx, evidence))
        if candidates:
            _overlap, _idx, evidence = max(candidates, key=lambda row: row[0])
            ev = dict(evidence)
            ev["field"] = "works_with"
            ev["confidence"] = min(0.95, 0.75 + 0.05 * _overlap)
            out.append(ev)
    return out


def _finalize_client_fields(
    result: Dict[str, Any],
    *,
    extract_clients: bool,
    audience_evidence: List[Dict[str, Any]],
    llm_failed: bool = False,
) -> None:
    if not extract_clients:
        return

    if llm_failed:
        _apply_client_fallback(result, "llm_error")
        return

    segments = _coerce_to_list(result.get("client_segments"))
    works_with = _coerce_to_text(result.get("works_with"))
    evidence = _client_evidence_for_segments(segments, works_with, audience_evidence)
    segment_evidence = [ev for ev in evidence if ev.get("field") == "client_segments"]

    if segments and segment_evidence:
        result["client_segments"] = segments
        result["evidence"] = [*result.get("evidence", []), *evidence]
        result.setdefault("field_status", {})["client_segments"] = "found"
        if works_with:
            result["works_with"] = works_with
            result.setdefault("field_status", {})["works_with"] = "found"
        else:
            result["works_with"] = CLIENT_FALLBACKS["not_found"]["works_with"]
            result.setdefault("field_status", {})["works_with"] = "not_found"
            _append_warning(result, "На сайте не найдено явных указаний, с кем работает компания")
        return

    _apply_client_fallback(result, "not_found")
    if segments and not segment_evidence:
        _append_warning(result, "Категории клиентов отброшены: не найдено проверяемых цитат-доказательств")
    elif not segments and not works_with:
        _append_warning(result, "Не найдено проверяемых данных о категориях клиентов и профиле заказчиков")


def _finalize_site_status(result: Dict[str, Any]) -> None:
    statuses = list((result.get("field_status") or {}).values())
    if not statuses:
        result["status"] = "ok"
        return
    if all(s == "fetch_error" for s in statuses):
        result["status"] = "fetch_error"
    elif all(s == "blocked" for s in statuses):
        result["status"] = "blocked"
    elif "blocked" in statuses:
        result["status"] = "partial"
    elif "fetch_error" in statuses:
        result["status"] = "partial"
    elif all(s == "llm_error" for s in statuses):
        result["status"] = "llm_error"
    elif "llm_error" in statuses:
        result["status"] = "partial"
    elif "partial" in statuses or ("found" in statuses and "not_found" in statuses):
        result["status"] = "partial"
    elif all(s == "not_found" for s in statuses):
        result["status"] = "not_found"
    else:
        result["status"] = "ok"


def _link_score(url: str, anchor_text: str = "") -> int:
    haystack = f"{url} {anchor_text}".lower()
    if any(noise in haystack for noise in NOISY_LINK_HINTS):
        return -50
    score = 0
    if any(pattern in haystack for pattern in LINK_PATTERNS):
        score += 100
    if any(hint in haystack for hint in AUDIENCE_LINK_HINTS):
        score += 80
    if len(url) < 120:
        score += 5
    return score


def _extract_internal_links(html: str, page_url: str, base_host: str) -> List[Tuple[str, int]]:
    soup = BeautifulSoup(html or "", "lxml")
    found: Dict[str, int] = {}
    for a in soup.find_all("a", href=True):
        full_url = _normalize_internal_link(page_url, a.get("href") or "", base_host)
        if not full_url:
            continue
        score = _link_score(full_url, a.get_text(" ", strip=True))
        if score < 0:
            continue
        found[full_url] = max(score, found.get(full_url, -999))
    return sorted(found.items(), key=lambda item: item[1], reverse=True)


def _coerce_to_list(value) -> list:
    """DSPy OutputField возвращает строку, а не массив. Приводим ответ модели
    к списку строк: поддерживаем JSON-массив, а также перечисления через
    перевод строки / точку с запятой с маркерами списка."""
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if value is None:
        return []
    text = str(value).strip()
    if not text:
        return []
    # JSON-массив (модель часто возвращает именно его).
    if text.startswith("["):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return [str(v).strip() for v in parsed if str(v).strip()]
        except Exception:
            pass
    # Иначе разбиваем по строкам / «;», убирая маркеры списка.
    items = []
    for raw in re.split(r"[\n;]+", text):
        item = raw.strip().lstrip("-•*").strip()
        item = re.sub(r"^\d+[.)]\s*", "", item).strip()
        if item:
            items.append(item)
    return items or [text]


_AI_FIELD_ALIASES = {
    "contacts summary": "contacts_summary",
    "contacts": "contacts_summary",
    "контакты": "contacts_summary",
    "contacts_summary": "contacts_summary",
    "about summary": "about_summary",
    "about": "about_summary",
    "о компании": "about_summary",
    "about_summary": "about_summary",
    "services list": "services_list",
    "services": "services_list",
    "список услуг": "services_list",
    "услуги": "services_list",
    "services_list": "services_list",
    "main focus": "main_focus",
    "focus": "main_focus",
    "фокус": "main_focus",
    "ключевой упор": "main_focus",
    "main_focus": "main_focus",
    "client segments": "client_segments",
    "client_segments": "client_segments",
    "категории клиентов": "client_segments",
    "works with": "works_with",
    "works_with": "works_with",
    "с кем работает": "works_with",
}


def _canonical_ai_field(name: Any) -> str:
    key = re.sub(r"[*`]+", "", str(name or "")).strip().lower()
    key = re.sub(r"[_\s-]+", " ", key)
    return _AI_FIELD_ALIASES.get(key) or _AI_FIELD_ALIASES.get(key.replace(" ", "_"), "")


def _strip_json_fence(text: str) -> str:
    text = (text or "").strip()
    m = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, flags=re.IGNORECASE | re.DOTALL)
    return m.group(1).strip() if m else text


def _normalize_ai_fields(data: Dict[Any, Any]) -> Dict[str, Any]:
    if not isinstance(data, dict):
        return {}
    out: Dict[str, Any] = {}
    for k, v in (data or {}).items():
        canon = _canonical_ai_field(k)
        if canon:
            out[canon] = v
    return out


def _parse_json_ai_output(text: str) -> Dict[str, Any]:
    raw = _strip_json_fence(text)
    candidates = [raw]
    start, end = raw.find("{"), raw.rfind("}")
    if 0 <= start < end:
        candidates.append(raw[start:end + 1])

    for candidate in candidates:
        current = candidate
        for _ in range(2):
            try:
                parsed = json.loads(current)
            except Exception:
                break
            if isinstance(parsed, dict):
                return _normalize_ai_fields(parsed)
            if isinstance(parsed, str):
                current = _strip_json_fence(parsed)
                continue
            break
    return {}


def _parse_labeled_ai_output(text: str) -> Dict[str, Any]:
    fields: Dict[str, str] = {}
    current: Optional[str] = None
    buf: List[str] = []

    def flush():
        if current:
            value = "\n".join(buf).strip()
            if value:
                fields[current] = value

    for line in (text or "").splitlines():
        stripped = line.strip()
        marker = re.match(r"^\[\[\s*##\s*([\w_]+)\s*##\s*\]\]$", stripped)
        if marker:
            flush()
            current = _canonical_ai_field(marker.group(1))
            buf = []
            continue

        label_match = re.match(r"^[-*•\s]*([^:：]{2,60})[:：]\s*(.*)$", stripped)
        if label_match:
            canon = _canonical_ai_field(label_match.group(1))
            if canon:
                flush()
                current = canon
                buf = [label_match.group(2).strip()] if label_match.group(2).strip() else []
                continue

        if current:
            buf.append(line)

    flush()
    return fields


def _parse_ai_output(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return _normalize_ai_fields(value)
    if value is None:
        return {}
    text = str(value).strip()
    if not text:
        return {}
    return _parse_json_ai_output(text) or _parse_labeled_ai_output(text)


def _ai_field(pred: Any, name: str) -> Any:
    if isinstance(pred, dict):
        return pred.get(name, "")
    return getattr(pred, name, "")


def _prediction_fields(pred: Any) -> Dict[str, Any]:
    normalized = _normalized_prediction(pred)
    if normalized.get("parse_status") != "invalid":
        return normalized.get("fields") or {}

    return {}


def _normalized_prediction(pred: Any) -> Dict[str, Any]:
    normalized = normalize_llm_response(pred)
    if normalized.get("parse_status") != "invalid":
        return normalized

    parsed = _parse_ai_output(pred)
    if parsed:
        return {
            "fields": parsed,
            "raw_text": _coerce_to_text(pred),
            "source_type": "legacy_parser",
            "warnings": ["legacy parser fallback used"],
            "parse_status": "partial",
        }

    for method_name in ("toDict", "to_dict", "model_dump", "dict"):
        method = getattr(pred, method_name, None)
        if callable(method):
            try:
                parsed = _parse_ai_output(method())
                if parsed:
                    return {
                        "fields": parsed,
                        "raw_text": "",
                        "source_type": "legacy_prediction_method",
                        "warnings": [f"{method_name} legacy parser fallback used"],
                        "parse_status": "partial",
                    }
            except Exception:
                pass

    fields: Dict[str, Any] = {}
    for name in (
        "contacts_summary", "about_summary", "services_list", "main_focus",
        "client_segments", "works_with",
    ):
        value = getattr(pred, name, None)
        if value not in (None, "", [], {}):
            fields[name] = value
    return {
        "fields": fields,
        "raw_text": str(pred)[:8000],
        "source_type": "legacy_prediction_attrs",
        "warnings": [],
        "parse_status": "partial" if fields else "invalid",
    }


def _coerce_to_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return "\n".join(str(v).strip() for v in value if str(v).strip())
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    return str(value).strip()


def _iter_lm_history_outputs(value: Any):
    if value is None:
        return
    if isinstance(value, str):
        yield value
        return
    if isinstance(value, dict):
        for key in ("outputs", "output", "response", "content", "text", "message", "choices"):
            if key in value:
                yield from _iter_lm_history_outputs(value.get(key))
        return
    if isinstance(value, (list, tuple)):
        for item in value:
            yield from _iter_lm_history_outputs(item)
        return
    content = getattr(value, "content", None) or getattr(value, "text", None)
    if content:
        yield from _iter_lm_history_outputs(content)


def _latest_lm_fields(lm: Any) -> Dict[str, Any]:
    """Recover fields from the newest raw LM response after a DSPy adapter error.

    DSPy can raise before returning a Prediction even when the provider response
    contains usable JSON. Try the shared normalizer first, then the legacy parser
    for unusual history shapes. The function never treats an error string as data.
    """
    normalized = normalize_lm_history(lm)
    if normalized.get("parse_status") != "invalid":
        return normalized.get("fields") or {}

    for entry in reversed(getattr(lm, "history", []) or []):
        outputs = list(_iter_lm_history_outputs(entry))
        for output in reversed(outputs):
            normalized_output = normalize_llm_response(output)
            if normalized_output.get("parse_status") != "invalid":
                return normalized_output.get("fields") or {}
            fields = _parse_ai_output(output)
            if fields:
                return fields
    return {}


def _apply_ai_fields(
    result: Dict[str, Any],
    pred: Any,
    *,
    extract_contacts: bool,
    extract_about: bool,
    extract_services: bool,
    extract_clients: bool,
) -> Dict[str, Any]:
    normalized = _normalized_prediction(pred)
    if normalized.get("parse_status") == "invalid":
        raise ValueError(
            "DSPy returned an unrecognized response; expected structured_result JSON"
        )
    pred = normalized.get("fields") or {}
    for warning in normalized.get("warnings") or []:
        _append_warning(result, warning)
    if extract_contacts:
        result["contacts"] = _coerce_to_text(_ai_field(pred, "contacts_summary"))
    if extract_about:
        result["about"] = _coerce_to_text(_ai_field(pred, "about_summary"))
    if extract_services:
        result["services"] = _coerce_to_list(_ai_field(pred, "services_list"))
        result["focus"] = _coerce_to_text(_ai_field(pred, "main_focus"))
    if extract_clients:
        result["client_segments"] = _coerce_to_list(_ai_field(pred, "client_segments"))
        result["works_with"] = _coerce_to_text(_ai_field(pred, "works_with"))
    return normalized


class ExtractCompanyServicesFallback(dspy.Signature):
    """Fallback DSPy contract used only when the single JSON envelope cannot parse."""
    website_text = dspy.InputField(desc="Факты сайта с URL-источниками")
    contacts_summary = dspy.OutputField(desc="Контакты или пустая строка")
    about_summary = dspy.OutputField(desc="Краткое описание компании или пустая строка")
    services_list = dspy.OutputField(desc="JSON-массив конкретных услуг")
    main_focus = dspy.OutputField(desc="Основной фокус или пустая строка")
    client_segments = dspy.OutputField(desc="JSON-массив категорий клиентов с услугой")
    works_with = dspy.OutputField(desc="B2B/B2C/B2G и тип клиентов или пустая строка")


class ExtractCompanyServices(dspy.Signature):
    """
    Ты — строгий бизнес-аналитик. Проанализируй текст сайта и верни РОВНО ОДИН
    валидный JSON-объект без Markdown, пояснений, комментариев и ```-блоков.

    DSPy JSONAdapter требует внешний envelope с единственным ключом
    structured_result. Значение structured_result должно быть JSON-encoded
    строкой, а не вложенным Python-объектом. Схема ответа:
    {
      "structured_result": "{\\"contacts_summary\\":\\"строка\\",\\"about_summary\\":\\"2-3 конкретных предложения или пустая строка\\",\\"services_list\\":[\\"конкретная услуга\\"],\\"main_focus\\":\\"конкретная специализация или пустая строка\\",\\"client_segments\\":[\\"категория клиента — что компания делает для нее\\"],\\"works_with\\":\\"B2B/B2C/B2G: тип клиентов или пустая строка\\"}"
    }

    Правила качества:
    1. Используй только факты из переданного текста сайта. Не выдумывай.
    2. client_segments — категории/отрасли/типы заказчиков, а не названия брендов.
    3. Для каждого client_segments укажи конкретную услугу или задачу для этой категории.
    4. works_with заполняй только при явном сигнале «работаем с», «для», отраслевом
       решении, кейсе, портфолио, отзыве или ином доказательстве.
    5. Если доказательств нет, верни client_segments: [] и works_with: "".
    6. Не добавляй поля кроме шести полей схемы. Не оборачивай JSON в Markdown.
    """
    website_text = dspy.InputField(
        desc="Текст главной, услуг, о компании, клиентов, кейсов, портфолио и контактов с URL-источниками"
    )
    structured_result = dspy.OutputField(
        desc=(
            "Только внешний JSON с единственным ключом structured_result; его "
            "значение — JSON-encoded строка с шестью обязательными ключами. "
            "Массивы — JSON-массивы строк, неизвестные значения — [] или пустая строка."
        )
    )


def _run_raw_json_repair(lm: Any, website_text: str) -> Dict[str, Any]:
    """Ask the already configured LM for plain JSON without DSPy Prediction parsing."""
    if not callable(lm):
        raise TypeError("LM is not callable for raw JSON repair")
    prompt = f"""
Ты выполняешь восстановление структурированного результата анализа сайта.
Верни только один валидный JSON-объект без Markdown и пояснений. Обязательно
присутствуют все шесть ключей; если данных нет, используй пустую строку или []:
contacts_summary (строка), about_summary (строка), services_list (массив строк),
main_focus (строка), client_segments (массив строк), works_with (строка).
Используй только факты из текста. Для client_segments пиши «категория — услуга»,
не названия брендов. Не выдумывай данные.

ТЕКСТ САЙТА:
{website_text[:60000]}
""".strip()
    raw = lm(prompt=prompt, temperature=0.1, max_tokens=2200, cache=False)
    normalized = normalize_llm_response(raw)
    if normalized.get("parse_status") == "invalid":
        raise ValueError("raw JSON repair returned an unrecognized response")
    return normalized.get("fields") or {}


def _run_dspy_prediction(extractor: Any, lm: Any, website_text: str) -> Any:
    """Run DSPy with a request-local LM context when the installed version supports it.

    The previous implementation called ``dspy.settings.configure`` for every URL
    from concurrent executor threads. That global mutation can route one site's
    request through another site's LM configuration and makes failures intermittent.
    """
    adapter_cls = getattr(dspy, "JSONAdapter", None)
    context_kwargs = {"lm": lm}
    if callable(adapter_cls):
        context_kwargs["adapter"] = adapter_cls()

    context_factory = getattr(dspy, "context", None)
    if callable(context_factory):
        with context_factory(**context_kwargs):
            return extractor(website_text=website_text)

    settings = getattr(dspy, "settings", None)
    settings_context = getattr(settings, "context", None)
    if callable(settings_context):
        with settings_context(**context_kwargs):
            return extractor(website_text=website_text)

    # Compatibility fallback for older DSPy builds. This path is only used when
    # the request-local context API is absent.
    dspy.settings.configure(**context_kwargs)
    return extractor(website_text=website_text)


async def parse_url_dspy(
    url: str,
    extract_contacts: bool,
    extract_about: bool,
    extract_services: bool,
    deepseek_api_key: str,
    extract_clients: bool = False,
    *,
    task_id: str = "",
    item_id: str = "",
    use_result_cache: bool = False,
) -> dict:
    key_str = (
        f"{CACHE_SCHEMA_VERSION}|{url}|{extract_contacts}|{extract_about}|"
        f"{extract_services}|{extract_clients}|{DEEPSEEK_PARSER_MODEL}"
    )
    url_hash = hashlib.md5(key_str.encode()).hexdigest()
    cache_key = f"parser:result:{CACHE_SCHEMA_VERSION}:{url_hash}"

    cache_allowed = bool(PARSER_CACHE_ENABLED and use_result_cache)
    if cache_allowed and _redis is not None:
        try:
            cached = await _redis.get(cache_key)
            if cached:
                cached_result = json.loads(cached)
                if isinstance(cached_result, dict):
                    execution = cached_result.setdefault("execution", {})
                    execution["run_id"] = task_id
                    execution["item_id"] = item_id
                    execution["result_source"] = "validated_cache"
                    return cached_result
        except Exception as e:
            logger.debug(f"redis get failed: {e}")

    htmls = []
    page_htmls: List[Tuple[str, str]] = []
    base_host = base_hostname(url)

    async with aiohttp.ClientSession() as session:
        try:
            allowed, robots_reason = await _robots_allowed(session, url)
            if not allowed:
                return _access_failure_result(
                    url,
                    task_id=task_id,
                    item_id=item_id,
                    access_status="blocked",
                    error_code=robots_reason or "robots_disallow",
                    message="Автоматический анализ запрещен правилами robots.txt",
                    extract_contacts=extract_contacts,
                    extract_about=extract_about,
                    extract_services=extract_services,
                    extract_clients=extract_clients,
                )
            res = await fetch_page(session, url)
            if res and getattr(res, "fetch_status", "") == "blocked":
                return _access_failure_result(
                    url,
                    task_id=task_id,
                    item_id=item_id,
                    access_status="blocked",
                    error_code=getattr(res, "error", None) or "blocked_response",
                    message=f"Автоматический доступ к сайту заблокирован: {getattr(res, 'error', None) or 'blocked_response'}",
                    status_code=getattr(res, "status_code", None),
                    method=getattr(res, "method", None),
                    final_url=getattr(res, "final_url", None),
                    diagnostics=getattr(res, "block_fingerprint", None),
                    extract_contacts=extract_contacts,
                    extract_about=extract_about,
                    extract_services=extract_services,
                    extract_clients=extract_clients,
                )
            html = res.html if res and res.html else ""
            htmls.append(html)
            page_htmls.append((url, html))

            seen_urls = {url}
            queue: List[Tuple[str, int, int]] = []
            sitemap_links = await _discover_sitemap_links(session, url, base_host)
            discovered_links = [*sitemap_links, *_extract_internal_links(html, url, base_host)]
            for link, score in discovered_links:
                if link in seen_urls:
                    continue
                seen_urls.add(link)
                queue.append((link, 1, score))

            async def _fetch_sub(item: Tuple[str, int, int]):
                sub_url, depth, score = item
                try:
                    sub_res = await fetch_page(session, sub_url)
                    sub_html = sub_res.html if sub_res and sub_res.html else None
                    return sub_url, depth, score, sub_html
                except Exception:
                    return sub_url, depth, score, None

            while queue and len(htmls) < MAX_SUBPAGES + 1:
                queue.sort(key=lambda item: item[2], reverse=True)
                batch = queue[:SUBPAGE_CONCURRENCY]
                queue = queue[SUBPAGE_CONCURRENCY:]

                for sub_url, depth, _score, sub_html in await asyncio.gather(*[_fetch_sub(item) for item in batch]):
                    if not sub_html:
                        continue
                    htmls.append(sub_html)
                    page_htmls.append((sub_url, sub_html))
                    if len(htmls) >= MAX_SUBPAGES + 1 or depth >= PARSER_MAX_DEPTH:
                        continue
                    for link, score in _extract_internal_links(sub_html, sub_url, base_host):
                        if link in seen_urls:
                            continue
                        if len(seen_urls) >= DISCOVERY_CANDIDATE_LIMIT:
                            break
                        seen_urls.add(link)
                        queue.append((link, depth + 1, score))
        except Exception as e:
            logger.exception(f"Failed to fetch {url}")
            result = _base_result(url, task_id=task_id, item_id=item_id)
            result["status"] = "fetch_error"
            result["error"] = f"Ошибка доступа: {str(e)[:100]}"
            _mark_requested_statuses(
                result,
                "fetch_error",
                extract_contacts=extract_contacts,
                extract_about=extract_about,
                extract_services=extract_services,
                extract_clients=extract_clients,
            )
            if extract_clients:
                _apply_client_fallback(result, "fetch_error")
            return result

    combined_html = "\n\n".join(h for h in htmls if h)
    soup = BeautifulSoup(combined_html or "", "lxml")
    
    # Extract titles and metadata (заголовок берём с главной страницы)
    title_text = ""
    if soup.title and soup.title.string:
        title_text = soup.title.string.strip()
    
    # БАГФИКС: чистим КАЖДУЮ страницу отдельно (trafilatura/readability
    # работают по одному документу) и склеиваем, иначе до LLM доходила только
    # главная страница, а докачанные подстраницы клиентов/кейсов терялись.
    cleaned_parts = []
    page_texts: List[Dict[str, str]] = []
    for page_url, h in page_htmls:
        if not h:
            continue
        part = _clean_text(h, BeautifulSoup(h, "lxml")) or ""
        part = part.strip()
        if part:
            page_texts.append({"url": page_url, "text": part})
            cleaned_parts.append(f"Источник: {page_url}\n{part}")
    clean_text = "\n\n".join(cleaned_parts)
    # Trim to ~15000-20000 tokens (approx 60000 chars)
    clean_text = clean_text[:60000]
    
    result = _base_result(url, title_text, task_id=task_id, item_id=item_id)
    result["stats"]["pages_scanned"] = len(page_texts)
    audience_evidence = _extract_audience_evidence(page_texts)
    effective_api_key = (deepseek_api_key or DEEPSEEK_API_KEY or "").strip()

    if not clean_text.strip():
        result["status"] = "fetch_error"
        result["error"] = "Ошибка: пустой контент"
        _mark_requested_statuses(
            result,
            "fetch_error",
            extract_contacts=extract_contacts,
            extract_about=extract_about,
            extract_services=extract_services,
            extract_clients=extract_clients,
        )
        if extract_clients:
            _apply_client_fallback(result, "fetch_error")
        if cache_allowed and _redis is not None:
            try:
                await _redis.set(cache_key, json.dumps(result, ensure_ascii=False), ex=CACHE_TTL_SECONDS)
            except Exception as e:
                logger.debug(f"redis set failed: {e}")
        return result

    if extract_services or extract_about or extract_contacts or extract_clients:
        if not effective_api_key:
            result["status"] = "llm_error"
            result["error_code"] = "missing_deepseek_api_key"
            result["error"] = "Ошибка ИИ: не задан DEEPSEEK_API_KEY"
            _mark_requested_statuses(
                result,
                "llm_error",
                extract_contacts=extract_contacts,
                extract_about=extract_about,
                extract_services=extract_services,
                extract_clients=extract_clients,
            )
            if extract_clients:
                _apply_client_fallback(result, "llm_error")
        else:
            llm_failed = False
            result["stats"]["llm_attempts"] = 1
            try:
                # Set up DSPy with DeepSeek model
                # DeepSeek uses OpenAI compatible API
                lm = dspy.LM(
                    f"openai/{DEEPSEEK_PARSER_MODEL}",
                    api_key=effective_api_key,
                    api_base=DEEPSEEK_API_BASE,
                    max_tokens=2500,
                    temperature=0.3
                )
                # Use one structured JSON OutputField. The normalizer accepts
                # both DSPy Prediction attributes and string JSON from that field.
                extractor = dspy.Predict(ExtractCompanyServices)

                # DSPy is synchronous; run it outside the event loop and keep the
                # LM binding request-local where supported by the installed version.
                loop = asyncio.get_running_loop()
                pred = await loop.run_in_executor(
                    None,
                    lambda: _run_dspy_prediction(extractor, lm, clean_text),
                )
                _apply_ai_fields(
                    result,
                    pred,
                    extract_contacts=extract_contacts,
                    extract_about=extract_about,
                    extract_services=extract_services,
                    extract_clients=extract_clients,
                )
                     
            except Exception as e:
                lm_obj = locals().get("lm")
                try:
                    recovered = _latest_lm_fields(lm_obj)
                except Exception as history_error:
                    logger.warning("LM history recovery failed for %s: %s", url, history_error)
                    recovered = {}
                recovery_applied = False
                if recovered:
                    try:
                        _apply_ai_fields(
                            result,
                            recovered,
                            extract_contacts=extract_contacts,
                            extract_about=extract_about,
                            extract_services=extract_services,
                            extract_clients=extract_clients,
                        )
                        result["stats"]["llm_recovered_from_history"] = True
                        _append_warning(result, "DSPy adapter не разобрал ответ; поля восстановлены из raw LM history")
                        recovery_applied = True
                    except Exception as recovery_error:
                        _append_warning(result, f"Не удалось применить raw LM history: {str(recovery_error)[:200]}")

                if not recovery_applied:
                    # One bounded second attempt uses plain OutputFields instead of
                    # the single JSON envelope. This handles providers that return
                    # valid field values but violate the envelope serialization.
                    try:
                        result["stats"]["llm_attempts"] = 2
                        fallback_extractor = dspy.Predict(ExtractCompanyServicesFallback)
                        loop = asyncio.get_running_loop()
                        fallback_pred = await loop.run_in_executor(
                            None,
                            lambda: _run_dspy_prediction(fallback_extractor, lm_obj, clean_text),
                        )
                        _apply_ai_fields(
                            result,
                            fallback_pred,
                            extract_contacts=extract_contacts,
                            extract_about=extract_about,
                            extract_services=extract_services,
                            extract_clients=extract_clients,
                        )
                        _append_warning(result, "Результат получен после повторной DSPy-попытки с fallback-схемой")
                    except Exception as fallback_error:
                        try:
                            result["stats"]["llm_attempts"] = 3
                            repaired_fields = _run_raw_json_repair(lm_obj, clean_text)
                            _apply_ai_fields(
                                result,
                                repaired_fields,
                                extract_contacts=extract_contacts,
                                extract_about=extract_about,
                                extract_services=extract_services,
                                extract_clients=extract_clients,
                            )
                            _append_warning(result, "Результат восстановлен прямым JSON-запросом после ошибки DSPy-адаптера")
                        except Exception as repair_error:
                            logger.exception(f"DSPy extraction failed for {url}")
                            result["status"] = "llm_error"
                            result["error_code"] = "dspy_extraction_failed"
                            result["error"] = f"Ошибка ИИ: {str(repair_error)[:500]}"
                            _append_warning(result, "DSPy не вернул валидный структурированный JSON-ответ после 3 попыток")
                            llm_failed = True

            _mark_non_client_field_statuses(
                result,
                extract_contacts=extract_contacts,
                extract_about=extract_about,
                extract_services=extract_services,
                missing_status="llm_error" if llm_failed else "not_found",
            )
            _finalize_client_fields(
                result,
                extract_clients=extract_clients,
                audience_evidence=audience_evidence,
                llm_failed=llm_failed,
            )
            _finalize_site_status(result)
    else:
        _finalize_site_status(result)
            
    # Кэшируем только успешные результаты. Если ИИ-извлечение было запрошено, но
    # модель не вернула ни одного поля — вероятен молчаливый сбой, не кэшируем,
    # чтобы следующий запрос повторил попытку, а не читал «пустышку».
    llm_requested = extract_services or extract_about or extract_contacts or extract_clients
    produced_any = bool(
        result["contacts"] or result["about"] or result["services"]
        or result["focus"] or result["client_segments"] or result["works_with"]
    )
    if cache_allowed and _redis is not None and result["status"] in {"ok", "partial", "not_found"} and (not llm_requested or produced_any):
        try:
            await _redis.set(cache_key, json.dumps(result, ensure_ascii=False), ex=CACHE_TTL_SECONDS)
        except Exception as e:
            logger.debug(f"redis set failed: {e}")

    return result
