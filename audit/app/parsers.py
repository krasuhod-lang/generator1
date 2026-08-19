import asyncio
import logging
import json
import hashlib
import os
import re
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urljoin, urlparse
import dspy
from bs4 import BeautifulSoup
import aiohttp

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

# Сколько подстраниц качаем параллельно (asyncio.gather с ограничением).
SUBPAGE_CONCURRENCY = int(os.getenv("PARSER_SUBPAGE_CONCURRENCY") or 4)

# TTL кэша результатов парсинга (по умолчанию 3 дня).
CACHE_TTL_SECONDS = int(os.getenv("PARSER_CACHE_TTL_SECONDS") or 259200)

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


def _base_result(url: str, title: str = "") -> Dict[str, Any]:
    return {
        "url": url,
        "title": title,
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


def _client_evidence_for_segments(
    segments: List[str],
    works_with: str,
    audience_evidence: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    if not segments or not audience_evidence:
        return []
    out: List[Dict[str, Any]] = []
    for idx, _segment in enumerate(segments):
        ev = dict(audience_evidence[idx % len(audience_evidence)])
        ev["field"] = "client_segments"
        out.append(ev)
    if works_with:
        ev = dict(audience_evidence[0])
        ev["field"] = "works_with"
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

    if segments and evidence:
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
    if segments and not evidence:
        _append_warning(result, "Категории клиентов отброшены: не найдено проверяемых цитат-доказательств")


def _finalize_site_status(result: Dict[str, Any]) -> None:
    statuses = list((result.get("field_status") or {}).values())
    if not statuses:
        result["status"] = "ok"
        return
    if all(s == "fetch_error" for s in statuses):
        result["status"] = "fetch_error"
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
    """DSPy 2.5 may fail while parsing a valid-but-string response.
    Recover fields from raw LM history so the parser task is not marked failed."""
    normalized = normalize_lm_history(lm)
    if normalized.get("parse_status") != "invalid":
        return normalized.get("fields") or {}

    for entry in reversed(getattr(lm, "history", []) or []):
        outputs = list(_iter_lm_history_outputs(entry))
        for output in reversed(outputs):
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


async def parse_url_dspy(url: str, extract_contacts: bool, extract_about: bool, extract_services: bool, deepseek_api_key: str, extract_clients: bool = False) -> dict:
    key_str = f"{url}_{extract_contacts}_{extract_about}_{extract_services}_{extract_clients}"
    url_hash = hashlib.md5(key_str.encode()).hexdigest()
    cache_key = f"parser:result:v2:{url_hash}"

    if _redis is not None:
        try:
            cached = await _redis.get(cache_key)
            if cached:
                return json.loads(cached)
        except Exception as e:
            logger.debug(f"redis get failed: {e}")

    htmls = []
    page_htmls: List[Tuple[str, str]] = []
    base_host = base_hostname(url)

    async with aiohttp.ClientSession() as session:
        try:
            res = await fetch_page(session, url)
            html = res.html if res and res.html else ""
            htmls.append(html)
            page_htmls.append((url, html))

            seen_urls = {url}
            queue: List[Tuple[str, int, int]] = []
            for link, score in _extract_internal_links(html, url, base_host):
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
            result = _base_result(url)
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
    
    result = _base_result(url, title_text)
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
        if _redis is not None:
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
                recovered_normalized = normalize_lm_history(locals().get("lm"))
                recovered = recovered_normalized.get("fields") if recovered_normalized.get("parse_status") != "invalid" else {}
                if recovered:
                    _apply_ai_fields(
                        result,
                        recovered,
                        extract_contacts=extract_contacts,
                        extract_about=extract_about,
                        extract_services=extract_services,
                        extract_clients=extract_clients,
                    )
                    for warning in recovered_normalized.get("warnings") or []:
                        _append_warning(result, warning)
                else:
                    logger.exception(f"DSPy extraction failed for {url}")
                    result["status"] = "llm_error"
                    result["error_code"] = "dspy_extraction_failed"
                    result["error"] = f"Ошибка ИИ: {str(e)[:500]}"
                    _append_warning(result, "DSPy не вернул валидный структурированный JSON-ответ")
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
    if _redis is not None and result["status"] in {"ok", "partial", "not_found"} and (not llm_requested or produced_any):
        try:
            await _redis.set(cache_key, json.dumps(result, ensure_ascii=False), ex=CACHE_TTL_SECONDS)
        except Exception as e:
            logger.debug(f"redis set failed: {e}")

    return result
