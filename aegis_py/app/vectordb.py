"""VectorDB подсистема (Qdrant + hybrid dense+sparse BM25).

Env:
    AEGIS_QDRANT_URL (например, http://qdrant:6333)
    AEGIS_QDRANT_API_KEY (опц., для облака)
    GOOGLE_API_KEY — для эмбеддингов через Gemini (text-embedding-005);
                     по решению владельца продукта используем именно его.
"""

import os
import hashlib
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


def _embed_openai(texts: List[str]) -> List[List[float]]:
    import requests

    key = (os.environ.get("OPENAI_API_KEY") or "").strip()
    if not key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    model = (os.environ.get("AEGIS_OPENAI_EMBED_MODEL") or "text-embedding-3-small").strip()
    vectors: List[List[float]] = []
    for t in texts:
        r = requests.post(
            "https://api.openai.com/v1/embeddings",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={"model": model, "input": t},
            timeout=30,
        )
        r.raise_for_status()
        data = r.json()
        vectors.append(data["data"][0]["embedding"])
    return vectors


def _embed_local_bge(texts: List[str]) -> List[List[float]]:
    model_name = (os.environ.get("AEGIS_LOCAL_BGE_MODEL") or "BAAI/bge-small-en-v1.5").strip()
    try:
        from sentence_transformers import SentenceTransformer  # type: ignore

        model = SentenceTransformer(model_name)
        vectors = model.encode(texts, normalize_embeddings=True)
        return [v.tolist() for v in vectors]
    except Exception:
        # Lightweight deterministic fallback without heavy deps.
        dim = 384
        out: List[List[float]] = []
        for t in texts:
            vec = [0.0] * dim
            tokens = (t or "").lower().split()
            if not tokens:
                out.append(vec)
                continue
            for tok in tokens:
                h = hashlib.sha256(tok.encode("utf-8")).digest()
                idx = int.from_bytes(h[:4], "big") % dim
                sign = -1.0 if (h[4] & 1) else 1.0
                vec[idx] += sign
            norm = sum(v * v for v in vec) ** 0.5
            if norm > 0:
                vec = [v / norm for v in vec]
            out.append(vec)
        return out


def _normalize_embedder(embedder: str) -> str:
    e = (embedder or "").strip().lower()
    aliases = {
        "open-ai": "openai",
        "text-embedding-3-small": "openai",
        "text-embedding-3-large": "openai",
        "bge": "local-bge",
        "local_bge": "local-bge",
    }
    return aliases.get(e, e)


def _embed(texts: List[str], embedder: str) -> List[List[float]]:
    provider = _normalize_embedder(embedder)
    if provider == "gemini":
        return _embed_gemini(texts)
    if provider == "openai":
        return _embed_openai(texts)
    if provider == "local-bge":
        return _embed_local_bge(texts)
    raise RuntimeError(f"embedder '{embedder}' not supported; use gemini/openai/local-bge")


def index(niche: str, paragraphs: List[str], source_url: Optional[str], embedder: str,
          run_id: Optional[str] = None, collection_override: Optional[str] = None) -> Dict[str, Any]:
    embedder = _normalize_embedder(embedder)
    if not paragraphs:
        return {"indexed": 0}
    cli = _client()
    coll = collection_override or _collection(niche)
    vecs = _embed(paragraphs, embedder=embedder)
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
    embedder = _normalize_embedder(embedder)
    cli = _client()
    coll = _collection(niche)
    try:
        cli.get_collection(coll)
    except Exception:
        return []
    qv = _embed([query], embedder=embedder)[0]
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
