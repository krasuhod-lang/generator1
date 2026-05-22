"""Shannon entropy — детерминированный расчёт H в битах/символ.

Соответствует backend/src/services/aegis/shannonEntropy.js (тот же
алгоритм, чтобы Node и Python давали одинаковые значения).
"""

import math
import re
from typing import Iterable

# Совпадает с JS regex /[^\p{L}\p{N}\s]/gu — оставляем буквы/цифры/пробел.
_KEEP_RE = re.compile(r"[^\w\s]", re.UNICODE)


def _normalize(text: str) -> str:
    if not isinstance(text, str):
        return ""
    return _KEEP_RE.sub("", text.lower())


def shannon_entropy(text: str) -> float:
    """H = -Σ p(c)·log2 p(c). Возвращает 0 для пустой строки."""
    s = _normalize(text)
    if not s:
        return 0.0
    freq: dict = {}
    for ch in s:
        freq[ch] = freq.get(ch, 0) + 1
    total = len(s)
    H = 0.0
    for c in freq.values():
        p = c / total
        H -= p * math.log2(p)
    return H


def is_low_entropy(text: str, min_h: float = 3.5, min_len: int = 80) -> bool:
    if not isinstance(text, str) or len(text) < min_len:
        return False
    return shannon_entropy(text) < min_h


def filter_low_entropy_blocks(
    blocks: Iterable[dict], *, text_key: str = "text", min_h: float = 3.5, min_len: int = 80
) -> dict:
    kept, dropped, ent = [], [], []
    for b in blocks:
        if not isinstance(b, dict):
            continue
        H = shannon_entropy(str(b.get(text_key, "")))
        if is_low_entropy(str(b.get(text_key, "")), min_h=min_h, min_len=min_len):
            dropped.append({**b, "_shannon_h": round(H, 3)})
        else:
            kept.append(b)
            ent.append(H)
    return {
        "kept": kept,
        "dropped": dropped,
        "stats": {
            "kept_count": len(kept),
            "dropped_count": len(dropped),
            "min_h": min(ent) if ent else None,
            "max_h": max(ent) if ent else None,
            "avg_h_kept": sum(ent) / len(ent) if ent else None,
        },
    }
