"""Точка входа pipeline_py: HTTP API (FastAPI) + возможность запуска воркера.

API минимальный — управление очередью и запуск обработки. Тяжёлые слои
(LLM-анализатор, валидатор, приёмник) подключаются через :mod:`app.orchestrator`.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI
from pydantic import BaseModel

from .config import CONFIG
from .fetcher import Fetcher
from .orchestrator import Orchestrator
from .queue import UrlQueue

logging.basicConfig(level=getattr(logging, CONFIG["log_level"], logging.INFO))

app = FastAPI(title="pipeline_py", version="0.1.0")


def _queue() -> UrlQueue:
    return UrlQueue(
        CONFIG["queue_db_path"],
        max_retries=CONFIG["max_retries"],
        ingest_dir=CONFIG["ingest_dir"] or None,
    )


def _fetcher() -> Fetcher:
    return Fetcher(
        base_url=CONFIG["fetcher_url"],
        timeout_ms=CONFIG["fetch_timeout_ms"],
        use_js_render=CONFIG["fetch_use_js_render"],
        auto_escalate=CONFIG["fetch_auto_escalate"],
        internal_token=CONFIG["fetcher_internal_token"],
    )


class IngestRequest(BaseModel):
    urls: list[str] = []
    csv_path: str | None = None
    excel_path: str | None = None
    google_sheet_url: str | None = None


class RunRequest(BaseModel):
    max_tasks: int | None = None


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "queue_db": CONFIG["queue_db_path"]}


@app.post("/ingest")
def ingest(req: IngestRequest) -> dict:
    col = CONFIG["url_column"]
    added = 0
    with _queue() as q:
        if req.urls:
            added += q.ingest_iterable(req.urls)
        if req.csv_path:
            added += q.ingest_csv(req.csv_path, col)
        if req.excel_path:
            added += q.ingest_excel(req.excel_path, col)
        if req.google_sheet_url:
            added += q.ingest_google_sheet(req.google_sheet_url, col)
        return {"added": added, "counts": q.counts()}


@app.get("/status")
def status() -> dict:
    with _queue() as q:
        return {"counts": q.counts(), "pending": q.pending_count()}


@app.post("/run")
def run(req: RunRequest) -> dict:
    with _queue() as q:
        orch = Orchestrator(queue=q, fetcher=_fetcher())
        counts = orch.run(max_tasks=req.max_tasks)
        return {"counts": counts}
