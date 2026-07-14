"""Embeddings и дедупликация claims (M2, порог cosine > 0.85).

Приоритет провайдеров:
1. sentence-transformers (`multilingual-e5-large`) — если установлен;
2. OpenAI-совместимый API (`text-embedding-3-small`) — если задан ключ;
3. Лексический фолбэк: TF-вектора по словам/char-3-граммам — детерминирован,
   работает в тестах и CI без тяжёлых зависимостей.
"""

from __future__ import annotations

import math
import os
import re
from collections import Counter
from typing import Dict, List

import requests

from .config import CONFIG

try:  # pragma: no cover - тяжёлая опциональная зависимость
    from sentence_transformers import SentenceTransformer  # type: ignore

    _ST_AVAILABLE = True
except Exception:
    SentenceTransformer = None  # type: ignore
    _ST_AVAILABLE = False

_st_model = None


def _tokenize(text: str) -> List[str]:
    words = re.findall(r"[а-яёa-z0-9]+", (text or "").lower())
    grams: List[str] = list(words)
    for w in words:
        grams.extend(w[i : i + 3] for i in range(max(len(w) - 2, 1)))
    return grams


def _lexical_vector(text: str) -> Dict[str, float]:
    return dict(Counter(_tokenize(text)))


def _cosine_dict(a: Dict[str, float], b: Dict[str, float]) -> float:
    if not a or not b:
        return 0.0
    dot = sum(v * b.get(k, 0.0) for k, v in a.items())
    na = math.sqrt(sum(v * v for v in a.values()))
    nb = math.sqrt(sum(v * v for v in b.values()))
    return dot / (na * nb) if na and nb else 0.0


def _cosine_list(a: List[float], b: List[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def _embed_api(texts: List[str]) -> List[List[float]]:
    base = os.environ.get("GIST_EMBED_API_BASE", "")
    key = os.environ.get("GIST_EMBED_API_KEY", "")
    model = os.environ.get("GIST_EMBED_MODEL", "text-embedding-3-small")
    resp = requests.post(
        base.rstrip("/") + "/embeddings",
        headers={"Authorization": "Bearer " + key},
        json={"model": model, "input": texts},
        timeout=120,
    )
    resp.raise_for_status()
    return [row["embedding"] for row in resp.json()["data"]]


def cosine_similarity(text_a: str, text_b: str) -> float:
    """Похожесть двух строк (используется и в GIST Score, и в дедупе)."""
    global _st_model
    if _ST_AVAILABLE:  # pragma: no cover
        if _st_model is None:
            _st_model = SentenceTransformer(
                os.environ.get("GIST_ST_MODEL", "intfloat/multilingual-e5-large")
            )
        va, vb = _st_model.encode([text_a, text_b], normalize_embeddings=True)
        return float(sum(x * y for x, y in zip(va, vb)))
    if os.environ.get("GIST_EMBED_API_BASE") and os.environ.get("GIST_EMBED_API_KEY"):
        va, vb = _embed_api([text_a, text_b])
        return _cosine_list(va, vb)
    return _cosine_dict(_lexical_vector(text_a), _lexical_vector(text_b))


def dedup_claims(claims: List[str], threshold: float | None = None) -> List[str]:
    """Дедупликация claims: cosine similarity > порога (по ТЗ 0.85)."""
    thr = CONFIG["dedup_cosine_threshold"] if threshold is None else threshold
    kept: List[str] = []
    kept_vecs: List[Dict[str, float]] = []
    use_lexical = not _ST_AVAILABLE and not (
        os.environ.get("GIST_EMBED_API_BASE") and os.environ.get("GIST_EMBED_API_KEY")
    )
    for claim in claims:
        claim = (claim or "").strip()
        if not claim:
            continue
        if use_lexical:
            vec = _lexical_vector(claim)
            if any(_cosine_dict(vec, kv) > thr for kv in kept_vecs):
                continue
            kept_vecs.append(vec)
        else:  # pragma: no cover - требует внешнего провайдера
            if any(cosine_similarity(claim, k) > thr for k in kept):
                continue
        kept.append(claim)
    return kept
