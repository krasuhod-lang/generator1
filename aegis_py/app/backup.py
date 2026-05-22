"""aegis_py.app.backup — Qdrant snapshot + Neo4j dump (+ optional S3 upload).

Graceful: каждая операция изолирована try/except. Если httpx/qdrant-client/
boto3 не установлены — возвращаем status='skipped' с причиной, остальное
выполняется.

Endpoints (вызываются из main.py):
  POST /backup/run    — снять снапшоты + (опц.) залить в S3
  GET  /backup/list   — список локальных снапшотов
  GET  /backup/health — что доступно

Qdrant: POST /collections/{name}/snapshots — создаёт файл .snapshot, который
скачивается через GET /collections/{name}/snapshots/{snapshot_name}.

Neo4j: используем APOC apoc.export.cypher.all(file, config); если APOC нет —
fallback на CALL db.schema.visualization() для метаданных (предупреждаем
о неполноте — рекомендуем поднять APOC).
"""
from __future__ import annotations

import datetime as _dt
import json
import logging
import os
import pathlib
from typing import Any, Dict, List, Optional

log = logging.getLogger("aegis_py.backup")

# ── Опциональные зависимости (graceful) ────────────────────────────
try:
    import httpx
    HAS_HTTPX = True
except ImportError:
    httpx = None
    HAS_HTTPX = False

try:
    import boto3
    HAS_BOTO3 = True
except ImportError:
    boto3 = None
    HAS_BOTO3 = False

try:
    from neo4j import GraphDatabase
    HAS_NEO4J = True
except ImportError:
    GraphDatabase = None
    HAS_NEO4J = False


def is_available() -> Dict[str, bool]:
    return {
        "httpx": HAS_HTTPX,
        "boto3": HAS_BOTO3,
        "neo4j": HAS_NEO4J,
    }


def _ts() -> str:
    return _dt.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")


# Допустимые корни для backup-директорий. Защита от path-injection:
# любой `local_dir`, пришедший извне (API), должен лежать ВНУТРИ одного из
# этих префиксов после полного резолва (без `..`, без симлинков и т.п.).
_SAFE_ROOTS = (
    "/var/lib/aegis",
    "/var/backups/aegis",
    "/tmp",
    "/data/aegis",
)


def _safe_dir(local_dir: str) -> pathlib.Path:
    """Резолвит путь и проверяет, что он лежит в одном из ``_SAFE_ROOTS``.

    Бросает ``ValueError`` при нарушении — вызывающий должен превратить это в
    HTTP 400. Делает резолв через ``resolve(strict=False)``: путь может ещё
    не существовать (будет создан позже), но всё, что есть, должно быть
    реальным (без коварных симлинков).
    """
    if not local_dir or not isinstance(local_dir, str):
        raise ValueError("local_dir must be non-empty string")
    if not pathlib.Path(local_dir).is_absolute():
        raise ValueError("local_dir must be absolute path")
    # Базовый sanity — никаких NUL / новых строк.
    if "\x00" in local_dir or "\n" in local_dir or "\r" in local_dir:
        raise ValueError("local_dir contains forbidden characters")
    candidate = pathlib.Path(local_dir).resolve(strict=False)
    cand_str = str(candidate)
    for root in _SAFE_ROOTS:
        root_resolved = str(pathlib.Path(root).resolve(strict=False))
        # Проверка: путь == root ИЛИ начинается с root + os.sep.
        if cand_str == root_resolved or cand_str.startswith(root_resolved + os.sep):
            return candidate
    raise ValueError(
        f"local_dir must be under one of {_SAFE_ROOTS}, got: {cand_str}"
    )


def _ensure_dir(p: str) -> pathlib.Path:
    path = _safe_dir(p)
    path.mkdir(parents=True, exist_ok=True)
    return path


# ── Qdrant snapshot ───────────────────────────────────────────────
def backup_qdrant(local_dir: str) -> Dict[str, Any]:
    qurl = os.environ.get("AEGIS_QDRANT_URL", "")
    if not qurl:
        return {"target": "qdrant", "status": "skipped", "reason": "AEGIS_QDRANT_URL not set"}
    if not HAS_HTTPX:
        return {"target": "qdrant", "status": "skipped", "reason": "httpx not installed"}
    try:
        safe_base = _safe_dir(local_dir)
    except ValueError as e:
        return {"target": "qdrant", "status": "error", "reason": f"unsafe_local_dir: {e}"}
    out_dir = safe_base / "qdrant" / _ts()
    out_dir.mkdir(parents=True, exist_ok=True)
    api_key = os.environ.get("AEGIS_QDRANT_API_KEY", "")
    headers = {"api-key": api_key} if api_key else {}
    try:
        with httpx.Client(timeout=300.0, headers=headers) as client:
            cols_resp = client.get(f"{qurl.rstrip('/')}/collections")
            cols_resp.raise_for_status()
            cols = [c["name"] for c in cols_resp.json().get("result", {}).get("collections", [])]
            files: List[Dict[str, Any]] = []
            for col in cols:
                snap_resp = client.post(f"{qurl.rstrip('/')}/collections/{col}/snapshots")
                snap_resp.raise_for_status()
                snap_name = snap_resp.json().get("result", {}).get("name")
                if not snap_name:
                    continue
                # download
                dl = client.get(f"{qurl.rstrip('/')}/collections/{col}/snapshots/{snap_name}")
                dl.raise_for_status()
                out_path = out_dir / f"{col}__{snap_name}"
                with open(out_path, "wb") as f:
                    f.write(dl.content)
                files.append({"collection": col, "file": str(out_path), "bytes": len(dl.content)})
        return {
            "target": "qdrant", "status": "ok",
            "out_dir": str(out_dir), "collections": cols, "files": files,
        }
    except Exception as e:  # noqa: BLE001
        log.warning("qdrant backup failed: %s", e)
        return {"target": "qdrant", "status": "error", "reason": str(e)}


# ── Neo4j dump (APOC cypher export) ────────────────────────────────
def backup_neo4j(local_dir: str) -> Dict[str, Any]:
    uri = os.environ.get("AEGIS_NEO4J_URI", "")
    user = os.environ.get("AEGIS_NEO4J_USER", "neo4j")
    password = os.environ.get("AEGIS_NEO4J_PASSWORD", "")
    if not uri:
        return {"target": "neo4j", "status": "skipped", "reason": "AEGIS_NEO4J_URI not set"}
    if not HAS_NEO4J:
        return {"target": "neo4j", "status": "skipped", "reason": "neo4j driver not installed"}
    try:
        safe_base = _safe_dir(local_dir)
    except ValueError as e:
        return {"target": "neo4j", "status": "error", "reason": f"unsafe_local_dir: {e}"}
    out_dir = safe_base / "neo4j" / _ts()
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / "graph.cypher"
    try:
        driver = GraphDatabase.driver(uri, auth=(user, password))
        with driver.session() as session:
            # APOC export → возвращает строку с CYPHER-скриптом.
            try:
                result = session.run(
                    "CALL apoc.export.cypher.all(null, "
                    "{format:'cypher-shell', useOptimizations:{type:'UNWIND_BATCH', unwindBatchSize:200}}) "
                    "YIELD file, cypherStatements RETURN cypherStatements AS dump"
                )
                rec = result.single()
                if rec and rec.get("dump"):
                    out_file.write_text(rec["dump"], encoding="utf-8")
                    driver.close()
                    return {
                        "target": "neo4j", "status": "ok",
                        "out_file": str(out_file), "bytes": out_file.stat().st_size,
                    }
            except Exception as apoc_err:  # noqa: BLE001
                log.warning("APOC not available, falling back to schema dump: %s", apoc_err)
            # Fallback: только schema (без data).
            schema = []
            for rec in session.run("CALL db.schema.visualization()"):
                schema.append({"nodes": [str(n) for n in rec["nodes"]], "rels": [str(r) for r in rec["relationships"]]})
            out_file.write_text(json.dumps(schema, ensure_ascii=False, indent=2), encoding="utf-8")
        driver.close()
        return {
            "target": "neo4j", "status": "partial",
            "reason": "APOC not installed — schema only",
            "out_file": str(out_file),
        }
    except Exception as e:  # noqa: BLE001
        log.warning("neo4j backup failed: %s", e)
        return {"target": "neo4j", "status": "error", "reason": str(e)}


# ── S3 upload ──────────────────────────────────────────────────────
def upload_to_s3(local_dir: str, bucket: str, prefix: str, region: str) -> Dict[str, Any]:
    if not bucket:
        return {"status": "skipped", "reason": "no bucket configured"}
    if not HAS_BOTO3:
        return {"status": "skipped", "reason": "boto3 not installed"}
    try:
        base = _safe_dir(local_dir)
    except ValueError as e:
        return {"status": "error", "reason": f"unsafe_local_dir: {e}"}
    try:
        client = boto3.client("s3", region_name=region)
        uploaded: List[Dict[str, Any]] = []
        for path in base.rglob("*"):
            if not path.is_file():
                continue
            rel = path.relative_to(base).as_posix()
            key = f"{prefix.strip('/')}/{rel}" if prefix else rel
            client.upload_file(str(path), bucket, key)
            uploaded.append({"key": key, "bytes": path.stat().st_size})
        return {"status": "ok", "bucket": bucket, "uploaded": len(uploaded), "files": uploaded[:50]}
    except Exception as e:  # noqa: BLE001
        log.warning("s3 upload failed: %s", e)
        return {"status": "error", "reason": str(e)}


# ── Retention (delete local backups older than N days) ─────────────
def cleanup_old(local_dir: str, retain_days: int) -> Dict[str, Any]:
    try:
        base = _safe_dir(local_dir)
    except ValueError as e:
        return {"deleted": 0, "reason": f"unsafe_local_dir: {e}"}
    if not base.exists():
        return {"deleted": 0, "reason": "dir_missing"}
    cutoff = _dt.datetime.utcnow() - _dt.timedelta(days=int(retain_days))
    deleted = 0
    for path in base.rglob("*"):
        try:
            if path.is_file():
                mtime = _dt.datetime.utcfromtimestamp(path.stat().st_mtime)
                if mtime < cutoff:
                    path.unlink()
                    deleted += 1
        except Exception:  # noqa: BLE001
            continue
    return {"deleted": deleted, "retain_days": retain_days}


def run_backup(
    targets: Optional[List[str]] = None,
    s3_bucket: str = "",
    s3_region: str = "",
    s3_prefix: str = "",
    local_dir: str = "/var/lib/aegis/backups",
    retain_days: int = 30,
) -> Dict[str, Any]:
    # Резолвим и валидируем local_dir один раз (бросит ValueError при
    # попытке path-injection — обработчик в main.py превратит в HTTP 400).
    safe = _safe_dir(local_dir)
    local_dir = str(safe)
    targets = targets or ["qdrant", "neo4j"]
    results: List[Dict[str, Any]] = []
    if "qdrant" in targets:
        results.append(backup_qdrant(local_dir))
    if "neo4j" in targets:
        results.append(backup_neo4j(local_dir))
    s3_result = upload_to_s3(local_dir, s3_bucket, s3_prefix, s3_region) if s3_bucket else None
    cleanup = cleanup_old(local_dir, retain_days)
    return {
        "ok": all(r.get("status") in ("ok", "partial", "skipped") for r in results),
        "results": results,
        "s3": s3_result,
        "cleanup": cleanup,
        "ts": _ts(),
    }


def list_backups(local_dir: str = "/var/lib/aegis/backups") -> Dict[str, Any]:
    try:
        base = _safe_dir(local_dir)
    except ValueError as e:
        return {"items": [], "local_dir": local_dir, "exists": False, "error": str(e)}
    if not base.exists():
        return {"items": [], "local_dir": local_dir, "exists": False}
    items: List[Dict[str, Any]] = []
    for path in sorted(base.rglob("*")):
        if path.is_file():
            st = path.stat()
            items.append({
                "path":  str(path.relative_to(base)),
                "bytes": st.st_size,
                "mtime": _dt.datetime.utcfromtimestamp(st.st_mtime).isoformat() + "Z",
            })
    return {"items": items[:1000], "local_dir": local_dir, "exists": True, "count": len(items)}
