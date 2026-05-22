"""Vector DB Garbage Collector (Phase 14.3).

Проблема:
    Конвейер 24/7 записывает в Qdrant эмбеддинги абзацев со скрапера
    (эфемерные коллекции `evidence_*`, `serp_*`, `relevance_*`). Через
    3–6 месяцев HNSW-индекс раздувается, recall просаживается, RAM растёт.

Решение:
    Два режима очистки:
      * `sweep_ttl(...)` — ежедневный крон, удаляет точки с
        payload.created_at старше N дней в эфемерных коллекциях
        (по префиксам из featureFlags.vectorGc.ephemeralCollectionPrefixes).
        Если коллекция полностью опустела — дропает коллекцию.
      * `cleanup_run(run_id)` — точечный per-run cleanup после
        aegis_runs.status='success' (вызывается из orchestrator'а).

Графейс-деградирует: если qdrant-client не установлен / URL не задан —
эндпоинты возвращают 503; здесь функции возвращают
{"status": "disabled", "reason": ...}.

ВАЖНО: чтобы GC мог работать, `vectordb.index()` должен записывать в
payload точек поля `created_at` (ISO-8601) и опц. `run_id`. См.
обновлённую функцию index() в vectordb.py.
"""

import datetime
import os
from typing import Any, Dict, Iterable, List, Optional, Tuple

# Зависимость от vectordb-модуля переиспользуем (он уже корректно
# подключает Qdrant-клиент и делает graceful-fallback).
from . import vectordb as _vdb

_REASON = None
try:  # pragma: no cover
    from qdrant_client.http.models import (  # type: ignore
        FieldCondition, Filter, FilterSelector, MatchValue, Range,
    )
    _QDRANT_FILTERS_OK = True
except Exception as e:  # pragma: no cover
    _QDRANT_FILTERS_OK = False
    _REASON = f"qdrant_filters_missing: {e.__class__.__name__}"


# Минимально-«страховочный» возраст: даже если кто-то поставит ttl_days=0,
# мы не удалим точки моложе этого числа часов.
_MIN_AGE_SAFETY_HOURS_DEFAULT = 24


def is_available() -> bool:
    return _vdb.is_available() and _QDRANT_FILTERS_OK


def unavailable_reason() -> Optional[str]:
    if not _vdb.is_available():
        return _vdb.unavailable_reason()
    if not _QDRANT_FILTERS_OK:
        return _REASON
    return None


# ── Внутренние утилиты ──────────────────────────────────────────────
def _now_iso() -> str:
    return datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _cutoff_iso(*, days: int, min_safety_hours: int) -> str:
    """Возвращает ISO-8601 cutoff: «удалить точки created_at < этой даты».

    Гарантирует, что cutoff не моложе `min_safety_hours` назад (защита
    от ttl_days=0).
    """
    now = datetime.datetime.utcnow()
    by_days = now - datetime.timedelta(days=max(0, int(days)))
    by_safety = now - datetime.timedelta(hours=max(0, int(min_safety_hours)))
    cutoff = min(by_days, by_safety)  # «более ранний» = более старый
    return cutoff.replace(microsecond=0).isoformat() + "Z"


def _list_collections() -> List[str]:
    if not _vdb.is_available():
        return []
    try:
        cli = _vdb._client()
        info = cli.get_collections()
        # Qdrant возвращает .collections — список с .name.
        return [c.name for c in (info.collections or [])]
    except Exception:
        return []


def _is_ephemeral(name: str, prefixes: Iterable[str]) -> bool:
    n = (name or "").lower()
    for p in prefixes or []:
        p2 = (p or "").lower()
        if p2 and n.startswith(p2):
            return True
    return False


def _delete_by_filter(collection: str, flt: Any) -> int:
    """Удаляет точки по filter, возвращает best-effort count удалённых.

    Qdrant API не возвращает «сколько удалили» напрямую: мы сначала
    делаем count() с тем же фильтром (приближение), потом delete().
    """
    cli = _vdb._client()
    deleted = 0
    try:
        cnt = cli.count(collection_name=collection, count_filter=flt, exact=True)
        deleted = int(getattr(cnt, "count", 0) or 0)
    except Exception:
        deleted = 0
    try:
        cli.delete(
            collection_name=collection,
            points_selector=FilterSelector(filter=flt),  # type: ignore[arg-type]
        )
    except Exception as e:
        return -1  # сигнал об ошибке вверх по стеку
    return deleted


# ── Public: TTL sweep ───────────────────────────────────────────────
def sweep_ttl(
    *,
    ttl_days: int,
    ephemeral_prefixes: List[str],
    min_age_safety_hours: int = _MIN_AGE_SAFETY_HOURS_DEFAULT,
    drop_empty: bool = True,
) -> Dict[str, Any]:
    """Удаляет в эфемерных коллекциях точки с created_at < cutoff.

    Returns:
        {
          "status": "ok"|"disabled"|"error",
          "cutoff": "<iso>",
          "collections": [{"name": "...", "deleted": N, "dropped": bool, "error": "..."}],
          "points_deleted_total": N,
          "collections_seen": M,
        }
    """
    if not is_available():
        return {"status": "disabled", "reason": unavailable_reason(),
                "collections": [], "points_deleted_total": 0,
                "collections_seen": 0}

    cutoff = _cutoff_iso(days=ttl_days, min_safety_hours=min_age_safety_hours)
    all_cols = _list_collections()
    target_cols = [c for c in all_cols if _is_ephemeral(c, ephemeral_prefixes)]

    flt = Filter(  # type: ignore[call-arg]
        must=[
            FieldCondition(  # type: ignore[call-arg]
                key="created_at",
                range=Range(lt=cutoff),  # type: ignore[call-arg]
            )
        ]
    )
    per_collection: List[Dict[str, Any]] = []
    total_deleted = 0
    cli = _vdb._client()
    for col in target_cols:
        deleted = _delete_by_filter(col, flt)
        entry: Dict[str, Any] = {"name": col, "deleted": max(0, deleted),
                                 "dropped": False}
        if deleted < 0:
            entry["error"] = "qdrant_delete_failed"
        else:
            total_deleted += deleted
            # Если коллекция полностью пуста — дропаем её.
            if drop_empty:
                try:
                    cnt_all = cli.count(collection_name=col, exact=True)
                    if int(getattr(cnt_all, "count", 0) or 0) == 0:
                        cli.delete_collection(collection_name=col)
                        entry["dropped"] = True
                except Exception:
                    entry["error"] = "qdrant_drop_failed"
        per_collection.append(entry)

    return {
        "status": "ok",
        "cutoff": cutoff,
        "collections": per_collection,
        "points_deleted_total": total_deleted,
        "collections_seen": len(target_cols),
        "all_collections_count": len(all_cols),
    }


# ── Public: per-run cleanup ─────────────────────────────────────────
def cleanup_run(
    *,
    run_id: str,
    collections: Optional[List[str]] = None,
    ephemeral_prefixes: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Удаляет точки с payload.run_id == run_id.

    Если `collections` не задан, проходит по всем эфемерным коллекциям
    (по `ephemeral_prefixes`).
    """
    if not is_available():
        return {"status": "disabled", "reason": unavailable_reason(),
                "run_id": run_id, "collections": [],
                "points_deleted_total": 0}
    if not run_id or not isinstance(run_id, str):
        return {"status": "error", "reason": "run_id_required",
                "run_id": run_id, "collections": [],
                "points_deleted_total": 0}

    targets = collections
    if not targets:
        all_cols = _list_collections()
        targets = [c for c in all_cols if _is_ephemeral(c, ephemeral_prefixes or [])]

    flt = Filter(  # type: ignore[call-arg]
        must=[
            FieldCondition(  # type: ignore[call-arg]
                key="run_id",
                match=MatchValue(value=run_id),  # type: ignore[call-arg]
            )
        ]
    )
    per: List[Dict[str, Any]] = []
    total = 0
    for col in targets:
        deleted = _delete_by_filter(col, flt)
        per.append({"name": col, "deleted": max(0, deleted),
                    "error": "qdrant_delete_failed" if deleted < 0 else None})
        if deleted > 0:
            total += deleted

    return {
        "status": "ok",
        "run_id": run_id,
        "collections": per,
        "collections_seen": len(targets),
        "points_deleted_total": total,
    }
