"""Хранилище задач аудита: in-memory + опциональный Redis (кеш, TTL).

Node-бэкенд персистит финальный отчёт в PostgreSQL; здесь — только рабочее
состояние (status/progress) и кеш отчёта, переживающий рестарт при наличии
REDIS_URL (redis://redis:6379).
"""

from __future__ import annotations

import json
import logging
import os
from typing import Optional

logger = logging.getLogger("audit.store")

REDIS_URL = (os.getenv("REDIS_URL") or "").strip()
TTL_S = int(os.getenv("AUDIT_REPORT_TTL_S", str(24 * 3600)))
_PREFIX = "audit:task:"

_mem: dict = {}
_redis = None

if REDIS_URL:
    try:
        import redis.asyncio as _redis_lib
        _redis = _redis_lib.from_url(REDIS_URL, decode_responses=True)
    except Exception as e:  # pragma: no cover
        logger.warning("Redis unavailable, using in-memory store: %s", e)
        _redis = None


async def save_task(task_id: str, data: dict):
    _mem[task_id] = data
    if _redis is not None:
        try:
            await _redis.set(_PREFIX + task_id, json.dumps(data, ensure_ascii=False), ex=TTL_S)
        except Exception as e:
            logger.debug("redis set failed: %s", e)


async def get_task(task_id: str) -> Optional[dict]:
    if task_id in _mem:
        return _mem[task_id]
    if _redis is not None:
        try:
            raw = await _redis.get(_PREFIX + task_id)
            if raw:
                data = json.loads(raw)
                _mem[task_id] = data
                return data
        except Exception as e:
            logger.debug("redis get failed: %s", e)
    return None


async def delete_task(task_id: str):
    _mem.pop(task_id, None)
    if _redis is not None:
        try:
            await _redis.delete(_PREFIX + task_id)
        except Exception as e:
            logger.debug("redis del failed: %s", e)
