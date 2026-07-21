"""FastAPI entrypoint микросервиса gist_py (GIST + LinguaForensic pipeline).

POST /relevance/scan   — M0: классификация запросов (список или GSC CSV)
POST /topic/discover   — M-1: InfoGapRadar оценка темы
POST /pipeline/run     — полный пайплайн M0–M10 для одного запроса
GET  /health           — public healthcheck

Аутентификация: заголовок X-Internal-Token (совпадает с GIST_INTERNAL_TOKEN),
как у остальных внутренних Python-сервисов.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, File, Header, HTTPException, UploadFile, status
from pydantic import BaseModel, Field

from . import config
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
    expected = config.internal_token()
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
    query: str = ""
    keyword: str = ""  # alias для Node gistClient (Задача A ТЗ)
    target_audience: str = ""
    domain: str = "SEO-статья"
    page_type: str = ""
    competitors_text: Optional[List[str]] = None
    modules: Optional[List[str]] = None  # напр. ["M2","M3"] → режим Gap Finder
    task_id: Optional[str] = None
    skip_discovery: bool = True


GAP_FINDER_MODULES = {"M1", "M1.5", "M2", "M3"}


class TopicDiscoveryRequest(BaseModel):
    query: str
    niche: str = ""
    trends_data: Optional[Dict] = None
    reddit_insights: Optional[Any] = None
    paa_questions: Optional[Any] = None


@app.post("/topic/discover")
def topic_discover(
    body: TopicDiscoveryRequest,
    x_internal_token: Optional[str] = Header(default=None),
) -> Dict:
    """M-1 Topic Discovery: InfoGapRadar go/no-go для темы."""
    _check_token(x_internal_token)
    query = (body.query or body.niche or "").strip()
    if not query:
        raise HTTPException(status_code=422, detail="query is empty")
    return GistPipeline().run_topic_discovery(
        query,
        trends_data=body.trends_data,
        reddit_insights=body.reddit_insights,
        paa_questions=body.paa_questions,
    )


@app.post("/pipeline/run")
def pipeline_run(
    body: PipelineRequest,
    x_internal_token: Optional[str] = Header(default=None),
) -> Dict:
    """Полный пайплайн M0–M10 (default) или режим Gap Finder (modules=[M2,M3]):
    контент + мета + schema + метрики / только top10_claims + information_delta."""
    _check_token(x_internal_token)
    query = (body.query or body.keyword or "").strip()
    if not query:
        raise HTTPException(status_code=422, detail="query/keyword is empty")
    pipeline = GistPipeline(task_id=body.task_id)
    try:
        if body.modules and set(body.modules).issubset(GAP_FINDER_MODULES):
            return pipeline.run_gap_finder(
                query,
                target_audience=body.target_audience,
                competitors_text=body.competitors_text,
            )
        return pipeline.run(
            query,
            target_audience=body.target_audience,
            domain=body.domain,
        )
    except Exception as exc:
        logger.exception("Pipeline failed for %s", query)
        raise HTTPException(status_code=500, detail=str(exc)) from exc
