"""Deterministic 8D feature extraction from text/html.

The Bio-Brain consumes a fixed 8-dimensional vector (see ``config_neat.ini``
``num_inputs = 8``). Historically all eight dimensions were derived purely from
the article HTML. ``extract_features`` now also accepts an optional ``signals``
dict carrying the *real* SEO-quality measurements AEGIS already computes
(SPQ subscores, readability, LSI coverage, intent / fact-check / plagiarism
verdicts). When a signal is present it replaces the corresponding text-derived
proxy, so the network learns from what actually matters — not just surface
text shape. Keeping the dimensionality at 8 means existing genomes and the
NEAT config remain valid.
"""

from __future__ import annotations

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

    # ── Dimension 4: factual grounding — prefer fact-check ratio ────────
    fact_real = sig.get("fact_check")
    dim_fact = _clamp01(fact_real) if fact_real is not None else _clamp01(digits / max(1.0, chars))

    # ── Dimension 5: originality — prefer plagiarism cleanliness ────────
    plag_real = sig.get("plagiarism")
    dim_clean = _clamp01(plag_real) if plag_real is not None else _clamp01(stop / max(1.0, wcount))

    # ── Dimension 6: semantic/LSI — prefer measured coverage ───────────
    lsi_real = sig.get("lsi_coverage")
    dim_lsi = _clamp01(lsi_real) if lsi_real is not None else _clamp01(lsi / max(1.0, wcount))

    # ── Dimension 7: intent match OR presence of a cover image ─────────
    if "intent_ok" in sig:
        dim_last = 1.0 if sig.get("intent_ok") else 0.0
    else:
        dim_last = 1.0 if has_cover_image else 0.0

    return [
        _clamp01(chars / 12000.0),
        _clamp01((h2 + h3) / max(1.0, wcount / 120.0)),
        _clamp01(lists / max(1.0, h2 + h3 + 1.0)),
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
