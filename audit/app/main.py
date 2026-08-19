"""FastAPI entrypoint микросервиса аудита.

POST   /audit/start            { url, max_pages?, max_depth?, use_playwright?, check_images? }
GET    /audit/status/{task_id} → { status, progress, started_at }
GET    /audit/report/{task_id} → финальный JSON-отчёт
DELETE /audit/{task_id}
GET    /health                 → public healthcheck

auth: X-Internal-Token == env RELEVANCE_INTERNAL_TOKEN (общий внутренний токен;
если переменная не задана — auth выключен, docker-compose всегда прокидывает).

Краулинг выполняется как фоновая asyncio-задача (неблокирующий event loop,
Semaphore(50) внутри краулера). Состояние — store.py (память + Redis).
"""

from __future__ import annotations

import asyncio
import datetime
import logging
import os
import uuid
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel, Field

from . import crawler, store
from .parsers import parse_url_dspy

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("audit.main")

INTERNAL_TOKEN = (os.getenv("RELEVANCE_INTERNAL_TOKEN") or "").strip()

app = FastAPI(title="Site Audit Service", version="1.0", docs_url=None, redoc_url=None)

_running_tasks: dict = {}


@app.on_event("startup")
async def recover_runtime_tasks():
    """Reattach durable Redis snapshots to new asyncio tasks after restart."""
    try:
        active = await store.list_active_tasks(limit=200)
    except Exception as e:
        logger.warning("audit startup recovery scan failed: %s", e)
        return
    recovered = 0
    for state in active:
        task_id = state.get("task_id")
        url = state.get("url")
        if not task_id or not url or task_id in _running_tasks:
            continue
        try:
            config = dict(state.get("config") or {})
            config.setdefault("url", url)
            req = StartRequest.model_validate(config)
        except Exception as e:
            state["status"] = "failed"
            state["error"] = f"invalid_recovery_config: {str(e)[:300]}"
            await store.save_task(task_id, state)
            continue
        state["status"] = "running"
        state["recovered_at"] = _now()
        state["heartbeat_at"] = _now()
        await store.save_task(task_id, state)
        _running_tasks[task_id] = asyncio.create_task(_run(task_id, req))
        recovered += 1
    if recovered:
        logger.info("audit startup recovery: reattached %s task(s)", recovered)


@app.on_event("shutdown")
async def stop_runtime_tasks():
    """Persist resumable state before the process receives a container stop."""
    tasks = list(_running_tasks.items())
    for task_id, task in tasks:
        if task.done():
            continue
        state = await store.get_task(task_id) or {"task_id": task_id}
        state["status"] = "queued"
        state["error"] = "audit_service_shutdown"
        state["heartbeat_at"] = _now()
        await store.save_task(task_id, state)
        task.cancel()
    if tasks:
        await asyncio.gather(*(task for _, task in tasks), return_exceptions=True)


async def _auth(x_internal_token: Optional[str] = Header(default=None)):
    if INTERNAL_TOKEN and x_internal_token != INTERNAL_TOKEN:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid token")


class StartRequest(BaseModel):
    url: str = Field(..., min_length=8, max_length=2048)
    max_pages: int = Field(default=crawler.DEFAULT_MAX_PAGES, ge=1, le=5000)
    max_depth: int = Field(default=crawler.DEFAULT_MAX_DEPTH, ge=0, le=10)
    use_playwright: bool = False
    check_images: bool = True


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


async def _run(task_id: str, req: StartRequest):
    state = await store.get_task(task_id) or {}

    def on_progress(p: dict):
        state["progress"] = p
        state["heartbeat_at"] = _now()
        # fire-and-forget: не блокируем краулер записью в Redis
        asyncio.get_event_loop().create_task(store.save_task(task_id, state))

    try:
        report = await crawler.run_audit(
            req.url,
            max_pages=req.max_pages,
            max_depth=req.max_depth,
            use_playwright=req.use_playwright,
            check_images=req.check_images,
            progress_cb=on_progress,
        )
        state.update({
            "status": "done",
            "finished_at": _now(),
            "report": report,
            "progress": {
                "crawled": report["summary"]["total_pages"],
                "total_found": report["summary"]["total_pages"],
            },
        })
    except Exception as e:
        logger.exception("audit %s failed", task_id)
        state.update({"status": "failed", "error": str(e)[:500], "finished_at": _now()})
    finally:
        _running_tasks.pop(task_id, None)
        await store.save_task(task_id, state)


@app.post("/audit/start", dependencies=[Depends(_auth)])
async def start_audit(req: StartRequest):
    if not req.url.startswith(("http://", "https://")):
        raise HTTPException(status_code=422, detail="url must start with http(s)://")
    task_id = str(uuid.uuid4())
    state = {
        "task_id": task_id,
        "status": "running",
        "url": req.url,
        "config": req.model_dump(),
        "progress": {"crawled": 0, "total_found": 0},
        "started_at": _now(),
        "heartbeat_at": _now(),
    }
    await store.save_task(task_id, state)
    _running_tasks[task_id] = asyncio.create_task(_run(task_id, req))
    return {"task_id": task_id}


@app.get("/audit/status/{task_id}", dependencies=[Depends(_auth)])
async def audit_status(task_id: str):
    state = await store.get_task(task_id)
    if not state:
        raise HTTPException(status_code=404, detail="task not found")
    return {
        "status": state.get("status"),
        "progress": state.get("progress") or {},
        "started_at": state.get("started_at"),
        "finished_at": state.get("finished_at"),
        "error": state.get("error"),
    }


@app.get("/audit/report/{task_id}", dependencies=[Depends(_auth)])
async def audit_report(task_id: str):
    state = await store.get_task(task_id)
    if not state:
        raise HTTPException(status_code=404, detail="task not found")
    if state.get("status") != "done":
        raise HTTPException(status_code=409, detail=f"task status: {state.get('status')}")
    return state.get("report") or {}


@app.delete("/audit/{task_id}", dependencies=[Depends(_auth)])
async def audit_delete(task_id: str):
    t = _running_tasks.pop(task_id, None)
    if t:
        t.cancel()
    await store.delete_task(task_id)
    return {"ok": True}


class ParserExtractRequest(BaseModel):
    urls: list[str]
    extract_contacts: bool = False
    extract_about: bool = False
    extract_services: bool = False
    extract_clients: bool = False
    api_key: str = ""


def _parser_exception_result(url: str, req: ParserExtractRequest, exc: Exception) -> dict:
    """Keep the parser-bot contract stable even when DSPy raises unexpectedly."""
    message = str(exc or "unknown parser exception").strip()[:500]
    result = {
        "url": url,
        "title": "",
        "contacts": "",
        "about": "",
        "services": [],
        "focus": "",
        "client_segments": [],
        "works_with": "",
        "status": "llm_error",
        "error_code": "audit_parser_exception",
        "error": f"Ошибка ИИ: {message}",
        "field_status": {},
        "evidence": [],
        "warnings": ["Audit/DSPy exception was converted to a structured parser result"],
        "stats": {"pages_scanned": 0},
    }
    if req.extract_contacts:
        result["field_status"]["contacts"] = "llm_error"
    if req.extract_about:
        result["field_status"]["about"] = "llm_error"
    if req.extract_services:
        result["field_status"]["services"] = "llm_error"
        result["field_status"]["focus"] = "llm_error"
    if req.extract_clients:
        result["client_segments"] = ["Не удалось определить — ошибка анализа ИИ"]
        result["works_with"] = "Не удалось определить — ошибка анализа ИИ"
        result["field_status"]["client_segments"] = "llm_error"
        result["field_status"]["works_with"] = "llm_error"
    return result


@app.post("/audit/parsers/extract", dependencies=[Depends(_auth)])
async def extract_parsers(req: ParserExtractRequest):
    if not req.urls:
        raise HTTPException(status_code=422, detail="No urls provided")
    
    # Process them concurrently
    tasks = [parse_url_dspy(url, req.extract_contacts, req.extract_about, req.extract_services, req.api_key, req.extract_clients) for url in req.urls]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    
    final_results = []
    for url, res in zip(req.urls, results):
        if isinstance(res, Exception):
            final_results.append(_parser_exception_result(url, req, res))
        elif not isinstance(res, dict):
            final_results.append(_parser_exception_result(
                url,
                req,
                TypeError(f"audit returned {type(res).__name__}, expected object"),
            ))
        else:
            final_results.append(res)
            
    return {"results": final_results}

@app.get("/health")
async def health():
    return {"status": "ok", "running_tasks": len(_running_tasks)}
