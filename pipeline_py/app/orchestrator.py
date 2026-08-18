"""Оркестратор — связывает слои пайплайна.

Проводит каждую задачу из очереди (Слой 1) через:

    Fetcher (Слой 2) -> Cleaner (Слой 3) -> Analyzer (Слой 4)
    -> Validator (Слой 5) -> Sink/хранилище (Слой 7)

и управляет статусами / повторами (Слой 6) с журналированием (Слой 8).

Слои 4/5/7 намеренно оставлены подключаемыми (protocol-интерфейсы), чтобы их
можно было реализовать/подменить (LLM-провайдер DeepSeek V3 Pro, схема
JSON-валидации, приёмник Excel/БД) без изменения оркестрации.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Callable, Optional, Protocol

from .cleaner import CleanResult, clean_html
from .config import CONFIG
from .fetcher import Fetcher, FetchResult
from .models import Task, TaskStatus
from .queue import UrlQueue

logger = logging.getLogger("pipeline")


class PipelineError(Exception):
    """Базовая ошибка пайплайна."""


class BlockedError(PipelineError):
    """Страница заблокирована (WAF / captcha / 403) — терминально для задачи."""


class Analyzer(Protocol):
    """Слой 4 — LLM-анализатор. Возвращает структуру (обычно dict)."""

    def analyze(self, url: str, clean: CleanResult) -> Any: ...


class Validator(Protocol):
    """Слой 5 — JSON-валидатор. Бросает исключение при невалидных данных."""

    def validate(self, data: Any) -> Any: ...


class Sink(Protocol):
    """Слой 7 — Хранилище (Excel/БД)."""

    def store(self, task: Task, data: Any) -> None: ...


class Orchestrator:
    def __init__(
        self,
        queue: UrlQueue,
        fetcher: Fetcher,
        analyzer: Optional[Analyzer] = None,
        validator: Optional[Validator] = None,
        sink: Optional[Sink] = None,
        cleaner: Callable[[str], CleanResult] = clean_html,
        clean_min_text_len: int = CONFIG["clean_min_text_len"],
    ) -> None:
        self.queue = queue
        self.fetcher = fetcher
        self.analyzer = analyzer
        self.validator = validator
        self.sink = sink
        self.cleaner = cleaner
        self.clean_min_text_len = clean_min_text_len

    def process_one(self, task: Task) -> TaskStatus:
        """Обработать одну задачу; вернуть её итоговый статус.

        Каждый слой изолирует свой класс ошибок: блокировки помечаются как
        ``blocked`` (терминально), прочие сбои уходят на retry (Слой 6).
        """
        try:
            fetched = self._fetch(task)
            clean = self._clean(fetched)
            data = self._analyze(task, clean)
            data = self._validate(data)
            self._store(task, data)
        except BlockedError as exc:
            logger.warning("task %s blocked: %s", task.task_id, exc)
            self.queue.mark_blocked(task.task_id, error=str(exc))
            return TaskStatus.BLOCKED
        except PipelineError as exc:
            status = self.queue.mark_failure(task.task_id, error=str(exc))
            logger.warning(
                "task %s failed (%s), retry_count now, new status=%s",
                task.task_id,
                exc,
                status.value,
            )
            return status
        except Exception as exc:  # неожиданные ошибки тоже идут на retry
            status = self.queue.mark_failure(task.task_id, error=repr(exc))
            logger.exception("task %s unexpected error", task.task_id)
            return status

        result_repr = _safe_json(data)
        self.queue.mark_success(task.task_id, result=result_repr)
        logger.info("task %s success", task.task_id)
        return TaskStatus.SUCCESS

    def run(self, max_tasks: Optional[int] = None) -> dict:
        """Обработать очередь до опустошения (или ``max_tasks`` задач).

        Перед запуском восстанавливает «зависшие» in_progress задачи.
        """
        recovered = self.queue.recover_stale()
        if recovered:
            logger.info("recovered %s stale tasks", recovered)

        processed = 0
        for task in self.queue.iter_pending():
            self.process_one(task)
            processed += 1
            if max_tasks is not None and processed >= max_tasks:
                break
        return self.queue.counts()

    # -- слои -----------------------------------------------------------------
    def _fetch(self, task: Task) -> FetchResult:
        result = self.fetcher.fetch(task.url)
        if result.blocked:
            raise BlockedError(result.error_msg or f"blocked ({result.status_code})")
        if not result.success or not result.html:
            raise PipelineError(result.error_msg or "fetch failed")
        return result

    def _clean(self, fetched: FetchResult) -> CleanResult:
        clean = self.cleaner(fetched.html)
        if len(clean.text) < self.clean_min_text_len:
            raise PipelineError(
                f"cleaned text too short ({len(clean.text)} chars)"
            )
        return clean

    def _analyze(self, task: Task, clean: CleanResult) -> Any:
        if self.analyzer is None:
            # Без анализатора пайплайн отдаёт очищенный контент как результат.
            return {"url": task.url, "title": clean.title, "text": clean.text}
        return self.analyzer.analyze(task.url, clean)

    def _validate(self, data: Any) -> Any:
        if self.validator is None:
            return data
        return self.validator.validate(data)

    def _store(self, task: Task, data: Any) -> None:
        if self.sink is not None:
            self.sink.store(task, data)


def _safe_json(data: Any) -> str:
    try:
        return json.dumps(data, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(data)


__all__ = [
    "Analyzer",
    "BlockedError",
    "Orchestrator",
    "PipelineError",
    "Sink",
    "Validator",
]
