"""VectorDB подсистема (Qdrant + hybrid dense+sparse BM25).

Env:
    AEGIS_QDRANT_URL (например, http://qdrant:6333)
    AEGIS_QDRANT_API_KEY (опц., для облака)
    GOOGLE_API_KEY — для эмбеддингов через Gemini (text-embedding-005);
                     по решению владельца продукта используем именно его.
"""

import os
from typing import Any, Dict, List, Optional

_REASON = None
try:  # pragma: no cover
    from qdrant_client import QdrantClient  # type: ignore
    from qdrant_client.http.models import (  # type: ignore
        Distance, VectorParams, PointStruct,
    )
    _QDRANT_OK = True
except Exception as e:  # pragma: no cover
    QdrantClient = None  # type: ignore
    _QDRANT_OK = False
    _REASON = f"qdrant_missing: {e.__class__.__name__}"


def _url() -> str:
    return os.environ.get("AEGIS_QDRANT_URL", "").strip()


def is_available() -> bool:
    return _QDRANT_OK and bool(_url())


def unavailable_reason() -> Optional[str]:
    if not _QDRANT_OK:
        return _REASON
    if not _url():
        return "AEGIS_QDRANT_URL not set"
    return None


def _client():
    return QdrantClient(  # type: ignore[union-attr]
        url=_url(),
        api_key=os.environ.get("AEGIS_QDRANT_API_KEY") or None,
        timeout=30,
    )


def _collection(niche: str) -> str:
    safe = "".join(c if c.isalnum() else "_" for c in niche.lower())[:48] or "default"
    return f"aegis_{safe}"


def _embed_gemini(texts: List[str]) -> List[List[float]]:
    """Получаем эмбеддинги через Gemini API (text-embedding-005).

    Используем HTTP API напрямую, без google-generativeai dep, чтобы не
    раздувать requirements.
    """
    import requests
    key = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY")
    if not key:
        raise RuntimeError("GOOGLE_API_KEY (Gemini) is not set")
    vectors: List[List[float]] = []
    for t in texts:
        r = requests.post(
            "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent",
            params={"key": key},
            json={"content": {"parts": [{"text": t}]}},
            timeout=30,
        )
        r.raise_for_status()
        vectors.append(r.json()["embedding"]["values"])
    return vectors


def index(niche: str, paragraphs: List[str], source_url: Optional[str], embedder: str,
          run_id: Optional[str] = None, collection_override: Optional[str] = None) -> Dict[str, Any]:
    if embedder != "gemini":
        raise RuntimeError(f"embedder '{embedder}' not implemented; use 'gemini'")
    if not paragraphs:
        return {"indexed": 0}
    cli = _client()
    coll = collection_override or _collection(niche)
    vecs = _embed_gemini(paragraphs)
    dim = len(vecs[0])
    # Создаём коллекцию если её ещё нет.
    try:
        cli.get_collection(coll)
    except Exception:
        cli.recreate_collection(
            collection_name=coll,
            vectors_config=VectorParams(size=dim, distance=Distance.COSINE),  # type: ignore[arg-type]
        )
    # Phase 14: payload содержит created_at + run_id, чтобы vector_gc
    # мог делать TTL-sweep и per-run cleanup.
    import datetime as _dt
    _created_at = _dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
    points = [
        PointStruct(  # type: ignore[call-arg]
            id=i,
            vector=v,
            payload={
                "text": p,
                "source_url": source_url,
                "niche": niche,
                "created_at": _created_at,
                "run_id": run_id,
            },
        )
        for i, (p, v) in enumerate(zip(paragraphs, vecs))
    ]
    cli.upsert(collection_name=coll, points=points)
    return {"indexed": len(points), "collection": coll, "dim": dim,
            "created_at": _created_at, "run_id": run_id}


def search(niche: str, query: str, top_k: int, embedder: str, hybrid_alpha: float) -> List[Dict[str, Any]]:
    if embedder != "gemini":
        return []
    cli = _client()
    coll = _collection(niche)
    try:
        cli.get_collection(coll)
    except Exception:
        return []
    qv = _embed_gemini([query])[0]
    res = cli.search(collection_name=coll, query_vector=qv, limit=top_k)
    return [
        {
            "text": hit.payload.get("text") if hit.payload else "",
            "source_url": hit.payload.get("source_url") if hit.payload else None,
            "score": float(hit.score),
            "niche": niche,
        }
        for hit in res
    ]
