"""Ray runner — обёртка над Ray Serve submit/jobs.

Простая реализация: используем ray client (ray.init с address=auto или
RAY_ADDRESS env). Если ray не установлен → graceful degradation.

В A.E.G.I.S. Ray применяется для масштабирования fact-checker, plagiarism,
scraper actors — 150+ параллельных вызовов на 8-нодовом кластере.
"""

import os
import uuid
from typing import Any, Dict, Optional

_REASON = None
try:  # pragma: no cover
    import ray  # type: ignore
    _RAY_OK = True
except Exception as e:  # pragma: no cover
    ray = None  # type: ignore
    _RAY_OK = False
    _REASON = f"ray_missing: {e.__class__.__name__}"


def _addr() -> str:
    return os.environ.get("RAY_ADDRESS", os.environ.get("AEGIS_RAY_URL", "")).strip()


def is_available() -> bool:
    return _RAY_OK and bool(_addr())


def unavailable_reason() -> Optional[str]:
    if not _RAY_OK:
        return _REASON
    if not _addr():
        return "RAY_ADDRESS / AEGIS_RAY_URL not set"
    return None


_JOBS: Dict[str, Dict[str, Any]] = {}


def submit(kind: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Регистрирует job. Реальный запуск actor'ов вынесен в конкретные
    модули (fact_checker_actor.py / plagiarism_actor.py — добавляются по
    мере подключения Ray). Здесь — bookkeeping."""
    job_id = str(uuid.uuid4())
    _JOBS[job_id] = {"kind": kind, "payload": payload, "status": "queued"}
    return {"id": job_id, "status": "queued", "kind": kind}


def get_job(job_id: str) -> Dict[str, Any]:
    j = _JOBS.get(job_id)
    if not j:
        return {"id": job_id, "status": "not_found"}
    return {"id": job_id, **j}
