"""Optional embeddings module — Wave 3 #13 (topical_distance, page_radius).

⚠️ Этот модуль НЕ обязателен. Он импортируется только при включении
   `RELEVANCE_EMBEDDINGS=true` и при наличии установленного пакета
   `sentence-transformers`. Если пакета нет — `signals.embeddings_enabled()`
   вернёт False и `compute_topical_signals` отдаст `{enabled: false, reason: ...}`,
   не падая. Это позволяет держать прод без 100–400 МБ модели и
   разворачивать их только на отдельной машине / в отдельном Docker-image.

Стандартная модель — `paraphrase-multilingual-MiniLM-L12-v2` (~120 МБ),
переопределяется через `RELEVANCE_EMBEDDINGS_MODEL`.

Контракт:
    compute_topical_signals(per_url, docs_text_by_url, our_text=None) -> dict

Возвращает:
    {
      "enabled": True,
      "model":   "paraphrase-multilingual-MiniLM-L12-v2",
      "topical_distance": {  # сколько «топик-юнитов» между нашим документом
        "our_to_top_centroid": 0.34,    # cosine distance (0 = идентично)
        "top_pairwise_median": 0.18,    # медиана попарных расстояний топа
      },
      "page_radius": [               # «радиус» каждой страницы — стандарт.
        {"url": "...",                 # отклонение блочных эмбеддингов от
         "radius": 0.21,               # центроида той же страницы. Ниже =
         "blocks_used": 12},           # тематически плотнее.
        ...
      ],
    }

ВАЖНО: модуль импортируется лениво. Импорт `sentence_transformers`
происходит только в `_load_model()`, чтобы сам факт `import embeddings`
не падал в тестах при отсутствии зависимости.
"""

from __future__ import annotations

import os
import re
from statistics import median
from typing import Any, Dict, List, Optional, Sequence

# Ленивая ссылка на загруженную модель — кэш в пределах процесса.
_MODEL = None
_MODEL_NAME: Optional[str] = None

# Регулярка токенизации блоков — не нужна сейчас; оставлена для будущего
# block-level page_radius (когда будем эмбеддить отдельные параграфы).
_PARA_SPLIT_RE = re.compile(r"\n{2,}|(?<=[\.\!\?])\s+(?=[А-ЯA-ZЁ])")


def _load_model():
    """Лениво грузит sentence-transformers модель. Кешируется в _MODEL."""
    global _MODEL, _MODEL_NAME
    if _MODEL is not None:
        return _MODEL
    name = os.environ.get(
        "RELEVANCE_EMBEDDINGS_MODEL",
        "paraphrase-multilingual-MiniLM-L12-v2",
    ).strip() or "paraphrase-multilingual-MiniLM-L12-v2"
    # Импорт sentence_transformers намеренно внутри функции, чтобы сам факт
    # `from . import embeddings` не вызывал ImportError, когда пакет не стоит.
    from sentence_transformers import SentenceTransformer  # type: ignore
    _MODEL = SentenceTransformer(name)
    _MODEL_NAME = name
    return _MODEL


def _cosine_distance(a, b) -> float:
    """Cosine distance ∈ [0..2]. Реализуем без numpy-зависимости от вызывающего
    кода — модель возвращает numpy-массивы, на их основе считаем явно."""
    import numpy as np  # numpy уже идёт зависимостью sentence-transformers
    sim = float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12))
    return round(1.0 - sim, 4)


# Порог косинусной близости для склейки лемм в один семантический кластер.
# Переопределяется через RELEVANCE_SYNONYM_THRESHOLD (0..1). 0.78 —
# консервативно: ловит явные синонимы («автомобиль»/«машина»), но не сливает
# просто тематически близкие слова.
def _synonym_threshold() -> float:
    try:
        return float(os.environ.get("RELEVANCE_SYNONYM_THRESHOLD", "0.78"))
    except (TypeError, ValueError):
        return 0.78


def cluster_terms(
    terms: Sequence[str],
    *,
    threshold: Optional[float] = None,
    max_terms: int = 400,
) -> Dict[str, str]:
    """Кластеризует список лемм по семантической близости эмбеддингов.

    Возвращает mapping `lemma -> canonical` (каноничная лемма кластера —
    первая в порядке входа, т.е. при отсортированном по BM25 входе это самая
    «весомая» лемма кластера). Синонимы («автомобиль», «машина») получают один
    canonical, что позволяет comparison.py группировать их per_term_gap.

    Все ошибки — мягкие: при недоступной модели возвращаем singleton-mapping
    (каждая лемма сама себе canonical), т.е. поведение как без кластеризации.
    """
    uniq = [t for t in dict.fromkeys(terms) if t][:max_terms]
    if len(uniq) < 2:
        return {t: t for t in uniq}

    try:
        model = _load_model()
        import numpy as np
    except Exception:
        return {t: t for t in uniq}

    thr = threshold if threshold is not None else _synonym_threshold()
    embs = model.encode(uniq, normalize_embeddings=True)

    # Union-find по парам с косинусной близостью ≥ threshold.
    parent = list(range(len(uniq)))

    def _find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def _union(a: int, b: int) -> None:
        ra, rb = _find(a), _find(b)
        if ra != rb:
            # меньший индекс (более весомая лемма) остаётся корнем
            parent[max(ra, rb)] = min(ra, rb)

    sim = np.asarray(embs) @ np.asarray(embs).T
    n = len(uniq)
    for i in range(n):
        for j in range(i + 1, n):
            if float(sim[i][j]) >= thr:
                _union(i, j)

    root_canon: Dict[int, str] = {}
    mapping: Dict[str, str] = {}
    for idx, term in enumerate(uniq):
        r = _find(idx)
        if r not in root_canon:
            root_canon[r] = uniq[r]
        mapping[term] = root_canon[r]
    return mapping


def _split_blocks(text: str, max_blocks: int = 30) -> List[str]:
    """Делит текст на укрупнённые блоки для page_radius. Cap чтобы не
    эмбеддить тысячи коротких предложений."""
    if not text:
        return []
    parts = [p.strip() for p in _PARA_SPLIT_RE.split(text) if p and p.strip()]
    # Пропускаем слишком короткие (мусор / меню) и слишком длинные.
    parts = [p[:1000] for p in parts if 80 <= len(p) <= 4000]
    return parts[:max_blocks]


def compute_topical_signals(
    per_url: Sequence[Dict[str, Any]],
    docs_text_by_url: Dict[str, str],
    our_text: Optional[str] = None,
) -> Dict[str, Any]:
    """См. docstring модуля.

    Все ошибки — мягкие: возвращаем enabled=False c полем reason.
    """
    try:
        model = _load_model()
    except Exception as e:
        return {"enabled": False, "reason": f"model_load_failed: {str(e)[:120]}"}

    import numpy as np

    # 1. Document-level эмбеддинги конкурентов.
    urls_ordered: List[str] = []
    doc_texts:    List[str] = []
    for sig in per_url:
        url = sig.get("url") or ""
        text = (docs_text_by_url.get(url) or "").strip()
        if not text:
            continue
        urls_ordered.append(url)
        doc_texts.append(text[:8000])

    if not doc_texts:
        return {"enabled": True, "model": _MODEL_NAME, "reason": "no_doc_texts",
                "topical_distance": None, "page_radius": []}

    doc_embs = model.encode(doc_texts, normalize_embeddings=False)
    centroid = np.mean(doc_embs, axis=0)

    pairwise: List[float] = []
    for i in range(len(doc_embs)):
        for j in range(i + 1, len(doc_embs)):
            pairwise.append(_cosine_distance(doc_embs[i], doc_embs[j]))
    pairwise_median = round(float(median(pairwise)), 4) if pairwise else 0.0

    our_to_top: Optional[float] = None
    if our_text and our_text.strip():
        our_emb = model.encode([our_text[:8000]], normalize_embeddings=False)[0]
        our_to_top = _cosine_distance(our_emb, centroid)

    # 2. Per-URL page_radius — отклонение блочных эмбеддингов от центроида
    #    своей страницы (lower = более сфокусированная страница).
    page_radius: List[Dict[str, Any]] = []
    for url, text in zip(urls_ordered, doc_texts):
        blocks = _split_blocks(text)
        if len(blocks) < 3:
            page_radius.append({"url": url, "radius": None, "blocks_used": len(blocks)})
            continue
        block_embs = model.encode(blocks, normalize_embeddings=False)
        page_centroid = np.mean(block_embs, axis=0)
        dists = [_cosine_distance(b, page_centroid) for b in block_embs]
        page_radius.append({
            "url":         url,
            "radius":      round(float(median(dists)), 4),
            "blocks_used": len(blocks),
        })

    return {
        "enabled": True,
        "model":   _MODEL_NAME,
        "topical_distance": {
            "our_to_top_centroid": our_to_top,
            "top_pairwise_median": pairwise_median,
        },
        "page_radius": page_radius,
    }
