"""Deterministic 8D feature extraction from text/html."""

from __future__ import annotations

import re
from typing import List

_STOPWORDS = {
    "и", "в", "на", "с", "по", "для", "как", "что", "это", "the", "and", "for", "with",
}

_LSI_HINTS = {"lsi", "семантика", "кластер", "intent", "search", "ctr", "eeat", "faq"}


def _clamp01(x: float) -> float:
    return 0.0 if x < 0 else (1.0 if x > 1 else x)


def extract_features(text: str, *, has_cover_image: bool = False) -> List[float]:
    s = str(text or "")
    plain = re.sub(r"<[^>]+>", " ", s)
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

    return [
        _clamp01(chars / 12000.0),
        _clamp01((h2 + h3) / max(1.0, wcount / 120.0)),
        _clamp01(lists / max(1.0, h2 + h3 + 1.0)),
        _clamp01(avg_sent / 30.0),
        _clamp01(digits / max(1.0, chars)),
        _clamp01(stop / max(1.0, wcount)),
        _clamp01(lsi / max(1.0, wcount)),
        1.0 if has_cover_image else 0.0,
    ]
