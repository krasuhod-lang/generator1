"""FastAPI entrypoint микросервиса gist_py (GIST + LinguaForensic pipeline).

POST /relevance/scan   — M0: классификация запросов (список или GSC CSV)
POST /pipeline/run     — полный пайплайн M0–M10 для одного запроса
GET  /health           — public healthcheck

Аутентификация: заголовок X-Internal-Token (совпадает с GIST_INTERNAL_TOKEN),
как у остальных внутренних Python-сервисов.
"""

from __future__ import annotations

import logging
import os
from typing import Dict, List, Optional

from fastapi import FastAPI, File, Header, HTTPException, UploadFile, status
from pydantic import BaseModel, Field

from .config import CONFIG
from .llm import LLMClient
from .modules import m0_relevance
from .pipeline import GistPipeline

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("gist_py")

APP_VERSION = "1.0.0"

app = FastAPI(
    title="GIST + LinguaForensic Pipeline",
    version=APP_VERSION,
    description="SEO-контент по логике GIST: съём релевантности + генерация "
    "с антидетекцией LinguaForensic v3.6 (DSPy-модули M0–M10)",
)


def _check_token(token: Optional[str]) -> None:
    expected = CONFIG["internal_token"]
    if expected and token != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="bad internal token"
        )


@app.get("/health")
def health() -> Dict:
    return {"status": "ok", "version": APP_VERSION}


class ScanRequest(BaseModel):
    queries: List[str] = Field(default_factory=list)


@app.post("/relevance/scan")
def relevance_scan(
    body: ScanRequest,
    x_internal_token: Optional[str] = Header(default=None),
) -> Dict:
    """M0 Relevance Scanner для массива ключей из кластера."""
    _check_token(x_internal_token)
    if not body.queries:
        raise HTTPException(status_code=422, detail="queries is empty")
    return {"results": m0_relevance.scan(body.queries, LLMClient())}


@app.post("/relevance/scan-csv")
async def relevance_scan_csv(
    file: UploadFile = File(...),
    x_internal_token: Optional[str] = Header(default=None),
) -> Dict:
    """M0 Relevance Scanner для CSV из GSC (query, clicks, impressions, …)."""
    _check_token(x_internal_token)
    content = (await file.read()).decode("utf-8", errors="replace")
    rows = m0_relevance.parse_gsc_csv(content)
    if not rows:
        raise HTTPException(status_code=422, detail="CSV не содержит запросов")
    results = m0_relevance.scan([r["query"] for r in rows], LLMClient())
    for res, row in zip(results, rows):
        res["gsc"] = {k: v for k, v in row.items() if k != "query"}
    return {"results": results}


class PipelineRequest(BaseModel):
    query: str
    target_audience: str = ""
    domain: str = "SEO-статья"
    task_id: Optional[str] = None


@app.post("/pipeline/run")
def pipeline_run(
    body: PipelineRequest,
    x_internal_token: Optional[str] = Header(default=None),
) -> Dict:
    """Полный пайплайн M0–M10: контент + мета + schema + все метрики."""
    _check_token(x_internal_token)
    pipeline = GistPipeline(task_id=body.task_id)
    try:
        return pipeline.run(
            body.query,
            target_audience=body.target_audience,
            domain=body.domain,
        )
    except Exception as exc:
        logger.exception("Pipeline failed for %s", body.query)
        raise HTTPException(status_code=500, detail=str(exc)) from exc
