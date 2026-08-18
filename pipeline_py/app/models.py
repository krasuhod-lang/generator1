"""Доменные модели пайплайна (Task, статусы)."""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Any, Optional


class TaskStatus(str, enum.Enum):
    """Статусы задачи из ТЗ (Слой 1)."""

    PENDING = "pending"          # ожидание
    IN_PROGRESS = "in_progress"  # in_progress
    SUCCESS = "success"          # успех
    FAILED = "failed"            # сбой
    BLOCKED = "blocked"          # блокировка (WAF / captcha / 403)


# Терминальные статусы — задача больше не берётся в работу.
TERMINAL_STATUSES = frozenset({TaskStatus.SUCCESS, TaskStatus.FAILED, TaskStatus.BLOCKED})


@dataclass
class Task:
    """Единица работы очереди URL."""

    task_id: int
    url: str
    status: TaskStatus = TaskStatus.PENDING
    retry_count: int = 0
    error: Optional[str] = None
    result: Any = field(default=None)
