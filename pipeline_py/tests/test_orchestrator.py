"""Тесты оркестрации (Слои 2→7) с заглушкой fetcher'а."""

import os

from app.fetcher import FetchResult
from app.models import TaskStatus
from app.orchestrator import Orchestrator, PipelineError
from app.queue import UrlQueue

HTML_OK = (
    "<html><head><title>T</title></head><body><article>"
    "<p>Достаточно длинный полезный текст для анализа страницы.</p>"
    "</article></body></html>"
)


class FakeFetcher:
    """Заглушка Слоя 2: отдаёт заранее заданные ответы по URL."""

    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def fetch(self, url, proxy=None):
        self.calls.append(url)
        return self.responses[url]


def _queue(tmp_path, **kw):
    return UrlQueue(os.path.join(str(tmp_path), "q.sqlite3"), **kw)


def test_success_flow_stores_clean_text(tmp_path):
    q = _queue(tmp_path)
    q.ingest_iterable(["https://ok.example"])
    fetcher = FakeFetcher(
        {
            "https://ok.example": FetchResult(
                success=True, url="https://ok.example", status_code=200, html=HTML_OK
            )
        }
    )
    orch = Orchestrator(queue=q, fetcher=fetcher)
    counts = orch.run()
    assert counts.get("success") == 1
    task = q.all_tasks()[0]
    assert task.status == TaskStatus.SUCCESS
    assert "полезный текст" in task.result


def test_blocked_is_terminal(tmp_path):
    q = _queue(tmp_path)
    q.ingest_iterable(["https://blocked.example"])
    fetcher = FakeFetcher(
        {
            "https://blocked.example": FetchResult(
                success=False,
                url="https://blocked.example",
                status_code=403,
                html="",
                error_msg="captcha",
                blocked=True,
            )
        }
    )
    orch = Orchestrator(queue=q, fetcher=fetcher)
    orch.run()
    assert q.all_tasks()[0].status == TaskStatus.BLOCKED
    # Блокировка терминальна — повторов нет.
    assert len(fetcher.calls) == 1


def test_fetch_failure_retries_until_failed(tmp_path):
    q = _queue(tmp_path, max_retries=3)
    q.ingest_iterable(["https://bad.example"])
    fetcher = FakeFetcher(
        {
            "https://bad.example": FetchResult(
                success=False,
                url="https://bad.example",
                status_code=500,
                html="",
                error_msg="server error",
            )
        }
    )
    orch = Orchestrator(queue=q, fetcher=fetcher)
    orch.run()
    task = q.all_tasks()[0]
    assert task.status == TaskStatus.FAILED
    assert task.retry_count == 3
    assert len(fetcher.calls) == 3  # 1 + 2 retry


def test_analyzer_and_validator_are_used(tmp_path):
    q = _queue(tmp_path)
    q.ingest_iterable(["https://ok.example"])
    fetcher = FakeFetcher(
        {
            "https://ok.example": FetchResult(
                success=True, url="https://ok.example", status_code=200, html=HTML_OK
            )
        }
    )

    class Analyzer:
        def analyze(self, url, clean):
            return {"url": url, "len": len(clean.text)}

    stored = []

    class Validator:
        def validate(self, data):
            if "url" not in data:
                raise PipelineError("missing url")
            return data

    class Sink:
        def store(self, task, data):
            stored.append((task.task_id, data))

    orch = Orchestrator(
        queue=q,
        fetcher=fetcher,
        analyzer=Analyzer(),
        validator=Validator(),
        sink=Sink(),
    )
    orch.run()
    assert q.all_tasks()[0].status == TaskStatus.SUCCESS
    assert len(stored) == 1
    assert stored[0][1]["url"] == "https://ok.example"
