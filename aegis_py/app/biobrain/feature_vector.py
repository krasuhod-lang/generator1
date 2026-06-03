"""Deterministic 8D feature extraction from text/html.

The Bio-Brain consumes a fixed 8-dimensional vector (see ``config_neat.ini``
``num_inputs = 8``). Historically all eight dimensions were derived purely from
the article HTML. ``extract_features`` now also accepts an optional ``signals``
dict carrying the *real* SEO-quality measurements AEGIS already computes
(SPQ subscores, readability, LSI coverage, intent / fact-check / plagiarism
verdicts, **and now E-E-A-T / structural / search-fit signals**). When a
signal is present it replaces the corresponding text-derived proxy, so the
network learns from what actually matters — not just surface text shape.
Keeping the dimensionality at 8 means existing genomes and the NEAT config
remain valid.

Supported ``signals`` keys (all optional, NaN-aware — missing/NaN means
«измерить нечем, используем text-proxy», а не ложный 0):
  • ``readability``      0..100 — Flesch-RU readability (→ dim 3)
  • ``fact_check``       0..1   — share of supported claims (→ dim 4)
  • ``plagiarism``       0..1   — cleanliness, 1 = original (→ dim 5)
  • ``lsi_coverage``     0..1   — measured LSI coverage vs SERP (→ dim 6)
  • ``intent_ok``        bool   — intent matches SERP (→ dim 7)

E-E-A-T / structural / SERP-fit signals (B2). Each, when present, is
*combined* (max/avg) with its base proxy to нарастить размерность без
изменения num_inputs:
  • ``eeat_citations``      0..1 — нормализованное число цитат/источников (→ dim 4 ⊕)
  • ``eeat_author_bio``     bool — есть ли блок «Об авторе» (→ dim 4 ⊕)
  • ``schema_article``      bool — присутствует Article/HowTo schema.org (→ dim 4 ⊕)
  • ``faq_schema``          bool — есть FAQPage schema.org (→ dim 2 ⊕ list_usage)
  • ``has_internal_links``  0..1 — внутренние ссылки (cocoon plan) (→ dim 6 ⊕)
  • ``intent_match_score``  0..1 — насколько формат страницы соответствует SERP intent (→ dim 7 ⊕)
  • ``serp_structural_fit`` 0..1 — featured-snippet/PAA pattern compliance (→ dim 7 ⊕)
"""

from __future__ import annotations

import math
import re
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional

_STOPWORDS = {
    "и", "в", "на", "с", "по", "для", "как", "что", "это", "the", "and", "for", "with",
}

_LSI_HINTS = {"lsi", "семантика", "кластер", "intent", "search", "ctr", "eeat", "faq"}


def _clamp01(x: float) -> float:
    try:
        x = float(x)
    except (TypeError, ValueError):
        return 0.0
    return 0.0 if x < 0 else (1.0 if x > 1 else x)


def _norm100(x: Any) -> Optional[float]:
    """Normalise a 0..100 score to 0..1; ``None`` when not a finite number."""
    if x is None:
        return None
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    if v != v:  # NaN
        return None
    return _clamp01(v / 100.0)


def _maybe01(x: Any) -> Optional[float]:
    """Coerce a 0..1 signal; None when missing/NaN. NaN-aware (B2)."""
    if x is None:
        return None
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    if math.isnan(v) or math.isinf(v):
        return None
    return _clamp01(v)


def _bool_flag(x: Any) -> Optional[float]:
    """Coerce a boolean-ish signal to 0/1; None when not a bool."""
    if x is None:
        return None
    if isinstance(x, bool):
        return 1.0 if x else 0.0
    # Allow numeric 0/1 too.
    try:
        v = float(x)
        if math.isnan(v):
            return None
        return 1.0 if v >= 0.5 else 0.0
    except (TypeError, ValueError):
        return None


def _blend(*values: Optional[float]) -> Optional[float]:
    """Mean of all non-None signals; None if all are None.

    Used to **combine** E-E-A-T add-on signals with the base text-proxy on
    the same dimension without changing input dimensionality. A measurement
    that is genuinely missing (None/NaN) is dropped — never treated as 0,
    so the network does not learn false negatives (B2).
    """
    present = [v for v in values if v is not None]
    if not present:
        return None
    return _clamp01(sum(present) / len(present))


class _PlainTextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self._parts: List[str] = []

    def handle_data(self, data: str) -> None:  # noqa: D401
        if data:
            self._parts.append(data)

    def text(self) -> str:
        return " ".join(self._parts)


def extract_features(
    text: str,
    *,
    has_cover_image: bool = False,
    signals: Optional[Dict[str, Any]] = None,
) -> List[float]:
    """Return a deterministic 8D feature vector in ``[0, 1]``.

    ``signals`` (optional) may carry any of the following real measurements;
    each present key overrides the text-derived proxy for one dimension:
      • ``readability``      0..100 — Flesch-RU readability (→ dim 3)
      • ``fact_check``       0..1   — share of supported claims (→ dim 4)
      • ``plagiarism``       0..1   — cleanliness, 1 = original (→ dim 5)
      • ``lsi_coverage``     0..1   — measured LSI coverage (→ dim 6)
      • ``intent_ok``        bool   — intent matches SERP (→ dim 7, OR cover)
    """
    sig = signals if isinstance(signals, dict) else {}

    s = str(text or "")
    parser = _PlainTextExtractor()
    parser.feed(s)
    plain = parser.text()
    plain = re.sub(r"\s+", " ", plain).strip()

    chars = len(plain)
    words = re.findall(r"[A-Za-zА-Яа-яЁё0-9]+", plain)
    wcount = len(words)

    h2 = len(re.findall(r"<h2\b", s, flags=re.IGNORECASE))
    h3 = len(re.findall(r"<h3\b", s, flags=re.IGNORECASE))
    lists = len(re.findall(r"<(ul|ol)\b", s, flags=re.IGNORECASE))
    sentences = [x for x in re.split(r"[.!?]+", plain) if x.strip()]

    avg_sent = (sum(len(re.findall(r"\w+", t)) for t in sentences) / len(sentences)) if sentences else 0.0
    digits = len(re.findall(r"\d", plain))
    stop = sum(1 for w in words if w.lower() in _STOPWORDS)
    lsi = sum(1 for w in words if w.lower() in _LSI_HINTS)

    # ── Dimension 3: readability — prefer the measured Flesch-RU score ──
    read_real = _norm100(sig.get("readability"))
    dim_read = read_real if read_real is not None else _clamp01(avg_sent / 30.0)

    # ── Dimension 4: factual grounding ⊕ E-E-A-T (B2) ───────────────────
    # Базовая прокси — fact-check ratio или digits/chars. Дополнительные
    # E-E-A-T сигналы (eeat_citations, eeat_author_bio, schema_article)
    # усредняются с базой через _blend, если они переданы. Иначе остаётся
    # чисто базовая прокси — без ложных нулей.
    fact_real = _maybe01(sig.get("fact_check"))
    fact_base = fact_real if fact_real is not None else _clamp01(digits / max(1.0, chars))
    eeat_blend = _blend(
        fact_base,
        _maybe01(sig.get("eeat_citations")),
        _bool_flag(sig.get("eeat_author_bio")),
        _bool_flag(sig.get("schema_article")),
    )
    dim_fact = eeat_blend if eeat_blend is not None else fact_base

    # ── Dimension 5: originality — prefer plagiarism cleanliness ────────
    plag_real = _maybe01(sig.get("plagiarism"))
    dim_clean = plag_real if plag_real is not None else _clamp01(stop / max(1.0, wcount))

    # ── Dimension 6: semantic/LSI ⊕ internal_links (B2) ────────────────
    # LSI-coverage может быть дополнен сигналом «внутренние ссылки построены
    # по cocoon-плану» — оба измерения говорят о семантической связности.
    lsi_real = _maybe01(sig.get("lsi_coverage"))
    lsi_base = lsi_real if lsi_real is not None else _clamp01(lsi / max(1.0, wcount))
    lsi_blend = _blend(lsi_base, _maybe01(sig.get("has_internal_links")))
    dim_lsi = lsi_blend if lsi_blend is not None else lsi_base

    # ── Dimension 7: intent ⊕ structural SERP-fit (B2) ─────────────────
    # Базово — intent_ok (bool) или наличие обложки. Сверху усредняются
    # intent_match_score (насколько формат страницы соответствует SERP)
    # и serp_structural_fit (featured-snippet/PAA pattern compliance).
    intent_base: Optional[float] = None
    if "intent_ok" in sig:
        intent_base = _bool_flag(sig.get("intent_ok"))
    if intent_base is None:
        intent_base = 1.0 if has_cover_image else 0.0
    intent_blend = _blend(
        intent_base,
        _maybe01(sig.get("intent_match_score")),
        _maybe01(sig.get("serp_structural_fit")),
    )
    dim_last = intent_blend if intent_blend is not None else intent_base

    # ── Dimension 2: list_usage ⊕ FAQPage schema (B2) ──────────────────
    # Базовая прокси — соотношение списков к заголовкам. FAQPage schema —
    # сильный сигнал о том, что контент структурирован под SERP-features.
    list_base = _clamp01(lists / max(1.0, h2 + h3 + 1.0))
    list_blend = _blend(list_base, _bool_flag(sig.get("faq_schema")))
    dim_list = list_blend if list_blend is not None else list_base

    return [
        _clamp01(chars / 12000.0),
        _clamp01((h2 + h3) / max(1.0, wcount / 120.0)),
        dim_list,
        dim_read,
        dim_fact,
        dim_clean,
        dim_lsi,
        dim_last,
    ]


# Human-readable labels for each feature dimension (used by the advice layer).
FEATURE_LABELS = (
    "length",
    "heading_structure",
    "list_usage",
    "readability",
    "factual_grounding",
    "originality",
    "lsi_coverage",
    "intent_or_cover",
)
