"""Defensive normalizer for LLM/DSPy parser responses.

The parser must never depend on a single adapter shape: DSPy/OpenAI-compatible
models may return dicts, strings with JSON, fenced JSON, double-serialized JSON,
Prediction-like objects or raw entries in ``lm.history``.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, Iterable, List, Optional, Tuple


FIELD_NAMES = (
    "contacts_summary",
    "about_summary",
    "services_list",
    "main_focus",
    "client_segments",
    "works_with",
)

LIST_FIELDS = {"services_list", "client_segments"}

FIELD_ALIASES = {
    "contacts summary": "contacts_summary",
    "contacts": "contacts_summary",
    "contact": "contacts_summary",
    "контакты": "contacts_summary",
    "contacts_summary": "contacts_summary",
    "about summary": "about_summary",
    "about": "about_summary",
    "о компании": "about_summary",
    "описание компании": "about_summary",
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
    "основной фокус": "main_focus",
    "main_focus": "main_focus",
    "client segments": "client_segments",
    "client segment": "client_segments",
    "client_segments": "client_segments",
    "категории клиентов": "client_segments",
    "сегменты клиентов": "client_segments",
    "целевая аудитория": "client_segments",
    "works with": "works_with",
    "works_with": "works_with",
    "с кем работает": "works_with",
    "формат работы": "works_with",
}

_GENERIC_CLIENT_SEGMENTS = {
    "клиенты",
    "люди",
    "бизнес",
    "компании",
    "заказчики",
    "покупатели",
    "customers",
    "clients",
    "business",
}


def _result(
    *,
    fields: Optional[Dict[str, Any]] = None,
    raw_text: str = "",
    source_type: str = "unknown",
    warnings: Optional[List[str]] = None,
    parse_status: str = "invalid",
) -> Dict[str, Any]:
    return {
        "fields": fields or {},
        "raw_text": raw_text or "",
        "source_type": source_type,
        "warnings": warnings or [],
        "parse_status": parse_status,
    }


def _canonical_field(name: Any) -> str:
    key = re.sub(r"[*`]+", "", str(name or "")).strip().lower()
    key = re.sub(r"[_\s-]+", " ", key)
    return FIELD_ALIASES.get(key) or FIELD_ALIASES.get(key.replace(" ", "_"), "")


def _strip_json_fence(text: str) -> str:
    text = (text or "").strip()
    match = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, flags=re.IGNORECASE | re.DOTALL)
    return match.group(1).strip() if match else text


def _safe_json_dumps(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False)
    except Exception:
        return str(value)


def _clean_scalar(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        text = value
    elif isinstance(value, (list, tuple, set)):
        text = "\n".join(_clean_scalar(v) for v in value if _clean_scalar(v))
    elif isinstance(value, dict):
        text = _safe_json_dumps(value)
    else:
        text = str(value)
    text = _strip_json_fence(text)
    text = text.strip().strip("`").strip()
    text = re.sub(r"^\s*[-*•]\s+", "", text)
    text = re.sub(r"^\s*\d+[.)]\s+", "", text)
    return text.strip()


def _split_list_text(text: str) -> List[Any]:
    raw = _strip_json_fence(text or "").strip()
    if not raw:
        return []

    if raw.startswith("["):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                return parsed
        except Exception:
            pass

    return [part for part in re.split(r"[\n;]+", raw) if part.strip()]


def _looks_like_brand_only(text: str) -> bool:
    stripped = text.strip()
    if not stripped:
        return False
    if " " in stripped or "—" in stripped or "-" in stripped or ":" in stripped:
        return False
    if len(stripped) > 40:
        return False
    # Single all-caps / CamelCase brand-like token is not a client category.
    has_alpha = bool(re.search(r"[A-Za-zА-Яа-яЁё]", stripped))
    has_upper = bool(re.search(r"[A-ZА-ЯЁ]", stripped))
    return has_alpha and has_upper


def _coerce_list(value: Any, field: str, warnings: List[str]) -> List[str]:
    if value is None:
        return []
    if isinstance(value, str):
        values = _split_list_text(value)
    elif isinstance(value, (list, tuple, set)):
        values = list(value)
    elif isinstance(value, dict):
        warnings.append(f"{field}: dict converted to string item")
        values = [value]
    else:
        warnings.append(f"{field}: unexpected {type(value).__name__} converted to string item")
        values = [value]

    out: List[str] = []
    seen = set()
    for item in values:
        if isinstance(item, dict):
            if field == "client_segments":
                segment = _clean_scalar(
                    item.get("segment")
                    or item.get("category")
                    or item.get("client")
                    or item.get("audience")
                    or item.get("industry")
                )
                service = _clean_scalar(
                    item.get("service")
                    or item.get("solution")
                    or item.get("offer")
                    or item.get("need")
                )
                if segment:
                    text = f"{segment} — {service}" if service else segment
                else:
                    warnings.append(f"{field}: dict has no segment/category value")
                    text = _safe_json_dumps(item)
            else:
                warnings.append(f"{field}: dict item converted to JSON string")
                text = _safe_json_dumps(item)
        elif isinstance(item, (list, tuple, set)):
            text = " ".join(_clean_scalar(x) for x in item)
        else:
            text = _clean_scalar(item)
        if not text:
            continue
        text = re.sub(r"\s+", " ", text).strip()
        if field == "client_segments":
            normalized = re.sub(r"[^\wа-яё]+", " ", text.lower(), flags=re.IGNORECASE).strip()
            if normalized in _GENERIC_CLIENT_SEGMENTS or _looks_like_brand_only(text):
                warnings.append(f"{field}: dropped non-category value '{text[:80]}'")
                continue
        key = text.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(text)
    return out


def _coerce_text(value: Any, field: str, warnings: List[str]) -> str:
    if value is None:
        return ""
    if isinstance(value, dict):
        warnings.append(f"{field}: dict converted to JSON string")
    elif isinstance(value, (list, tuple, set)):
        warnings.append(f"{field}: list converted to text")
    return _clean_scalar(value)


def _validate_fields(raw_fields: Dict[Any, Any], warnings: List[str]) -> Tuple[Dict[str, Any], int]:
    fields: Dict[str, Any] = {}
    recognized = 0
    if not isinstance(raw_fields, dict):
        warnings.append(f"fields: expected dict, got {type(raw_fields).__name__}")
        return fields, recognized

    for key, value in raw_fields.items():
        canon = _canonical_field(key)
        if not canon:
            continue
        recognized += 1
        if canon in LIST_FIELDS:
            fields[canon] = _coerce_list(value, canon, warnings)
        else:
            fields[canon] = _coerce_text(value, canon, warnings)

    return fields, recognized


def _status_for(fields: Dict[str, Any], recognized: int) -> str:
    if not recognized:
        return "invalid"
    populated = 0
    for value in fields.values():
        if isinstance(value, list):
            populated += 1 if value else 0
        elif value:
            populated += 1
    if populated == len(FIELD_NAMES):
        return "ok"
    return "partial"


def _extract_openai_content(value: Dict[str, Any]) -> Optional[Any]:
    if not isinstance(value, dict):
        return None
    choices = value.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    for choice in reversed(choices):
        if not isinstance(choice, dict):
            continue
        message = choice.get("message")
        if isinstance(message, dict) and message.get("content") is not None:
            return message.get("content")
        if choice.get("text") is not None:
            return choice.get("text")
    return None


_STRUCTURED_WRAPPER_KEYS = (
    "result_json",
    "structured_result",
    "json_result",
    "parser_result",
    "answer_json",
)


def _normalize_dict(value: Dict[Any, Any], warnings: List[str], source_type: str) -> Dict[str, Any]:
    fields_obj = value.get("fields") if isinstance(value.get("fields"), dict) else value
    fields, recognized = _validate_fields(fields_obj, warnings)

    # DSPy can return one strongly-instructed JSON string inside a named
    # OutputField. Do not call .items() on that string: recursively normalize
    # the wrapper value instead.
    if not recognized:
        for wrapper_key in _STRUCTURED_WRAPPER_KEYS:
            if wrapper_key not in value:
                continue
            nested = normalize_llm_response(value.get(wrapper_key))
            if nested.get("parse_status") != "invalid":
                nested["source_type"] = source_type
                nested["raw_text"] = _safe_json_dumps(value)[:8000]
                nested["warnings"] = [*warnings, *nested.get("warnings", [])]
                return nested

    return _result(
        fields=fields,
        raw_text=_safe_json_dumps(value)[:8000],
        source_type=source_type,
        warnings=warnings,
        parse_status=_status_for(fields, recognized),
    )


def _json_candidates(text: str) -> Iterable[str]:
    raw = _strip_json_fence(text)
    yield raw
    start, end = raw.find("{"), raw.rfind("}")
    if 0 <= start < end:
        yield raw[start:end + 1]
    start, end = raw.find("["), raw.rfind("]")
    if 0 <= start < end:
        yield raw[start:end + 1]


def _parse_json_text(text: str, warnings: List[str]) -> Optional[Dict[str, Any]]:
    for candidate in _json_candidates(text):
        current: Any = candidate
        for _ in range(3):
            if not isinstance(current, str):
                break
            try:
                parsed = json.loads(_strip_json_fence(current))
            except Exception:
                break
            if isinstance(parsed, dict):
                openai_content = _extract_openai_content(parsed)
                if openai_content is not None:
                    nested = normalize_llm_response(openai_content)
                    nested["source_type"] = "openai_response"
                    return nested
                return _normalize_dict(parsed, warnings, "json")
            if isinstance(parsed, str):
                current = parsed
                continue
            warnings.append(f"json: parsed {type(parsed).__name__}, expected object")
            break
    return None


def _parse_labeled_text(text: str, warnings: List[str]) -> Dict[str, Any]:
    raw_fields: Dict[str, str] = {}
    current: Optional[str] = None
    buf: List[str] = []

    def flush() -> None:
        nonlocal buf
        if current:
            value = "\n".join(buf).strip()
            if value:
                raw_fields[current] = value
        buf = []

    for line in (text or "").splitlines():
        stripped = line.strip()
        marker = re.match(r"^\[\[\s*##\s*([\w_]+)\s*##\s*\]\]$", stripped)
        if marker:
            flush()
            current = _canonical_field(marker.group(1))
            continue

        label_match = re.match(r"^[-*•\s]*([^:：]{2,80})[:：]\s*(.*)$", stripped)
        if label_match:
            canon = _canonical_field(label_match.group(1))
            if canon:
                flush()
                current = canon
                if label_match.group(2).strip():
                    buf.append(label_match.group(2).strip())
                continue

        if current:
            buf.append(line)

    flush()
    fields, recognized = _validate_fields(raw_fields, warnings)
    return _result(
        fields=fields,
        raw_text=(text or "")[:8000],
        source_type="labeled_text",
        warnings=warnings,
        parse_status=_status_for(fields, recognized),
    )


def _prediction_mapping(value: Any, warnings: List[str]) -> Optional[Dict[Any, Any]]:
    for method_name in ("toDict", "to_dict", "model_dump", "dict"):
        method = getattr(value, method_name, None)
        if not callable(method):
            continue
        try:
            mapped = method()
        except Exception as exc:
            warnings.append(f"{method_name} failed: {str(exc)[:120]}")
            continue
        if isinstance(mapped, dict):
            return mapped
        warnings.append(f"{method_name} returned {type(mapped).__name__}, expected dict")
    return None


def _prediction_attrs(value: Any) -> Dict[str, Any]:
    fields: Dict[str, Any] = {}
    for name in FIELD_NAMES:
        attr = getattr(value, name, None)
        if attr not in (None, "", [], {}):
            fields[name] = attr
    return fields


def normalize_llm_response(value: Any) -> Dict[str, Any]:
    """Return a stable parser contract for any supported LLM response shape."""
    warnings: List[str] = []

    if value is None:
        return _result(warnings=["response is None"], parse_status="invalid")

    if isinstance(value, dict):
        openai_content = _extract_openai_content(value)
        if openai_content is not None:
            nested = normalize_llm_response(openai_content)
            nested["source_type"] = "openai_response"
            return nested
        return _normalize_dict(value, warnings, "json")

    if isinstance(value, str):
        text = value.strip()
        if not text:
            return _result(raw_text="", warnings=["response is empty string"], parse_status="invalid")
        parsed = _parse_json_text(text, warnings)
        if parsed is not None and parsed.get("parse_status") != "invalid":
            return parsed
        labeled = _parse_labeled_text(text, warnings)
        if labeled.get("parse_status") != "invalid":
            return labeled
        return _result(raw_text=text[:8000], warnings=warnings or ["text response is not recognized"], parse_status="invalid")

    if isinstance(value, (int, float, bool)):
        return _result(raw_text=str(value), warnings=[f"unsupported scalar {type(value).__name__}"], parse_status="invalid")

    if isinstance(value, (list, tuple)):
        for item in reversed(value):
            nested = normalize_llm_response(item)
            if nested.get("parse_status") != "invalid":
                return nested
        return _result(raw_text=_safe_json_dumps(value)[:8000], warnings=["list response has no recognizable item"], parse_status="invalid")

    mapped = _prediction_mapping(value, warnings)
    if mapped is not None:
        normalized = _normalize_dict(mapped, warnings, "dspy_prediction")
        if normalized.get("parse_status") != "invalid":
            return normalized

    # Some DSPy versions expose OutputField values as attributes but do not
    # include them in toDict()/to_dict(). Handle the structured JSON field
    # explicitly before looking for legacy individual attributes.
    for wrapper_key in _STRUCTURED_WRAPPER_KEYS:
        raw_wrapper = getattr(value, wrapper_key, None)
        if raw_wrapper not in (None, ""):
            nested = normalize_llm_response(raw_wrapper)
            if nested.get("parse_status") != "invalid":
                nested["source_type"] = "dspy_prediction"
                nested["warnings"] = [*warnings, *nested.get("warnings", [])]
                return nested

    attrs = _prediction_attrs(value)
    if attrs:
        fields, recognized = _validate_fields(attrs, warnings)
        return _result(
            fields=fields,
            raw_text=str(value)[:8000],
            source_type="dspy_prediction",
            warnings=warnings,
            parse_status=_status_for(fields, recognized),
        )

    content = getattr(value, "content", None) or getattr(value, "text", None)
    if content is not None:
        nested = normalize_llm_response(content)
        if nested.get("parse_status") != "invalid":
            return nested

    return _result(
        raw_text=str(value)[:8000],
        warnings=warnings or [f"unsupported response type {type(value).__name__}"],
        parse_status="invalid",
    )


def _iter_history_payloads(value: Any):
    if value is None:
        return
    if isinstance(value, str):
        yield value
        return
    if isinstance(value, dict):
        for key in ("outputs", "output", "response", "content", "text", "message", "choices"):
            if key in value:
                yield from _iter_history_payloads(value.get(key))
        return
    if isinstance(value, (list, tuple)):
        for item in value:
            yield from _iter_history_payloads(item)
        return
    content = getattr(value, "content", None) or getattr(value, "text", None)
    if content:
        yield from _iter_history_payloads(content)


def normalize_lm_history(lm_or_history: Any) -> Dict[str, Any]:
    """Search DSPy/OpenAI history from newest to oldest and normalize a response."""
    history = getattr(lm_or_history, "history", lm_or_history)
    for entry in reversed(history or []):
        outputs = list(_iter_history_payloads(entry))
        for output in reversed(outputs):
            normalized = normalize_llm_response(output)
            if normalized.get("parse_status") != "invalid":
                normalized["source_type"] = "history"
                return normalized
    return _result(source_type="history", warnings=["no recognizable response in history"], parse_status="invalid")

