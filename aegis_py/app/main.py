"""A.E.G.I.S. Python microservice — FastAPI entrypoint.

POST /graphrag/upsert      — записать узлы и связи в Neo4j
POST /graphrag/retrieve_lsi — top-K LSI по Betweenness Centrality
POST /vectordb/index       — индексировать абзацы (hybrid dense+sparse)
POST /vectordb/search      — гибридный поиск (фактчекинг, антиплагиат)
POST /ray/submit           — submit Ray-job
GET  /ray/jobs/{id}        — статус Ray-job
POST /langgraph/run        — запустить writer→critic→refiner граф
POST /dspy/retrain         — MIPROv2 weekly retrain
GET  /dspy/status          — статус последнего retrain
POST /ga4/fetch            — агрегированные метрики GA4 по URL-путям
POST /mutate/analyze       — DeepSeek-V4-Pro анализирует DOM-падение
POST /shannon              — энтропия Шеннона (отладка)
GET  /health               — общий healthcheck

Графейс-деградация: каждый блок endpoint'ов оборачивает соответствующий
импорт в try/except. Если зависимости не установлены (см. requirements.txt
с закомментированными heavy deps) — endpoint вернёт 503 с понятным reason.
"""

import logging
import os
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, status
from pydantic import BaseModel, Field

from .shannon import shannon_entropy
from . import graphrag as graphrag_mod
from . import vectordb as vectordb_mod
from . import ray_runner as ray_mod
from . import langgraph_runner as lg_mod
from . import dspy_optimizer as dspy_mod
from . import ga4 as ga4_mod
from . import mutator as mut_mod
from . import backup as backup_mod

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("aegis_py")

APP_VERSION = "0.1.0"

app = FastAPI(
    title="A.E.G.I.S. Python",
    version=APP_VERSION,
    description="Адаптивный движок для генеративных интеллектуальных систем.",
)


# ── Утилита: ответ 503 если подсистема не готова ─────────────────────
def _unavailable(reason: str, detail: Optional[str] = None) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={"reason": reason, "detail": detail},
    )


# ── /health ───────────────────────────────────────────────────────────
@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "ok": True,
        "version": APP_VERSION,
        "subsystems": {
            "graphrag": graphrag_mod.is_available(),
            "vectordb": vectordb_mod.is_available(),
            "ray":      ray_mod.is_available(),
            "langgraph": lg_mod.is_available(),
            "dspy":     dspy_mod.is_available(),
            "ga4":      ga4_mod.is_available(),
            "mutator":  mut_mod.is_available(),
            "backup":   backup_mod.is_available(),
        },
    }


# ── /backup ───────────────────────────────────────────────────────────
class BackupRunRequest(BaseModel):
    targets: List[str] = ["qdrant", "neo4j"]
    s3_bucket: str = ""
    s3_region: str = "eu-central-1"
    s3_prefix: str = "aegis/backups"
    local_dir: str = "/var/lib/aegis/backups"
    retain_days: int = 30


@app.get("/backup/health")
def backup_health() -> Dict[str, Any]:
    return {"ok": True, "deps": backup_mod.is_available()}


@app.post("/backup/run")
def backup_run(req: BackupRunRequest):
    # _safe_dir внутри run_backup может бросить ValueError. Перехватываем
    # на одну строку (без обращения к атрибутам исключения), и возвращаем
    # обычный 400 с константной строкой — никакой утечки stack trace.
    if not _is_safe_local_dir(req.local_dir):
        raise HTTPException(status_code=400, detail="invalid_local_dir")
    return backup_mod.run_backup(
        targets=req.targets,
        s3_bucket=req.s3_bucket,
        s3_region=req.s3_region,
        s3_prefix=req.s3_prefix,
        local_dir=req.local_dir,
        retain_days=req.retain_days,
    )


@app.get("/backup/list")
def backup_list(local_dir: str = "/var/lib/aegis/backups"):
    if not _is_safe_local_dir(local_dir):
        raise HTTPException(status_code=400, detail="invalid_local_dir")
    return backup_mod.list_backups(local_dir=local_dir)


def _is_safe_local_dir(p: str) -> bool:
    """Тонкая обёртка-предикат вокруг ``backup_mod._safe_dir`` — без stack trace."""
    try:
        backup_mod._safe_dir(p)
        return True
    except Exception:  # noqa: BLE001
        return False


# ── /shannon ──────────────────────────────────────────────────────────
class ShannonRequest(BaseModel):
    text: str = Field(..., min_length=1)


@app.post("/shannon")
def shannon(req: ShannonRequest) -> Dict[str, float]:
    return {"entropy": shannon_entropy(req.text)}


# ── /graphrag ─────────────────────────────────────────────────────────
class GraphragUpsertRequest(BaseModel):
    niche: str
    entities: List[Dict[str, Any]] = []
    intents:  List[Dict[str, Any]] = []
    facts:    List[Dict[str, Any]] = []
    articleId: Optional[str] = None


class GraphragRetrieveRequest(BaseModel):
    niche: str
    query: str = ""
    top_k: int = 12


@app.get("/graphrag/health")
def graphrag_health() -> Dict[str, Any]:
    return {"ok": graphrag_mod.is_available(), "reason": graphrag_mod.unavailable_reason()}


@app.post("/graphrag/upsert")
def graphrag_upsert(req: GraphragUpsertRequest) -> Dict[str, Any]:
    if not graphrag_mod.is_available():
        raise _unavailable("graphrag_disabled", graphrag_mod.unavailable_reason())
    return graphrag_mod.upsert(req.niche, req.entities, req.intents, req.facts, req.articleId)


@app.post("/graphrag/retrieve_lsi")
def graphrag_retrieve(req: GraphragRetrieveRequest) -> Dict[str, Any]:
    if not graphrag_mod.is_available():
        # Возвращаем пустой items — frontend graceful path.
        return {"items": [], "reason": "graphrag_disabled"}
    return {"items": graphrag_mod.retrieve_top_lsi(req.niche, req.query, req.top_k)}


# ── /vectordb ─────────────────────────────────────────────────────────
class VectordbIndexRequest(BaseModel):
    niche: str
    paragraphs: List[str] = []
    source_url: Optional[str] = None
    embedder: str = "gemini"


class VectordbSearchRequest(BaseModel):
    niche: str
    query: str
    top_k: int = 5
    embedder: str = "gemini"
    hybrid_alpha: float = 0.5


@app.get("/vectordb/health")
def vectordb_health() -> Dict[str, Any]:
    return {"ok": vectordb_mod.is_available(), "reason": vectordb_mod.unavailable_reason()}


@app.post("/vectordb/index")
def vectordb_index(req: VectordbIndexRequest) -> Dict[str, Any]:
    if not vectordb_mod.is_available():
        raise _unavailable("vectordb_disabled", vectordb_mod.unavailable_reason())
    return vectordb_mod.index(req.niche, req.paragraphs, req.source_url, req.embedder)


@app.post("/vectordb/search")
def vectordb_search(req: VectordbSearchRequest) -> Dict[str, Any]:
    if not vectordb_mod.is_available():
        return {"hits": [], "reason": "vectordb_disabled"}
    return {"hits": vectordb_mod.search(req.niche, req.query, req.top_k, req.embedder, req.hybrid_alpha)}


# ── /ray ──────────────────────────────────────────────────────────────
class RaySubmitRequest(BaseModel):
    kind: str
    payload: Dict[str, Any] = {}


@app.get("/ray/health")
def ray_health() -> Dict[str, Any]:
    return {"ok": ray_mod.is_available(), "reason": ray_mod.unavailable_reason()}


@app.post("/ray/submit")
def ray_submit(req: RaySubmitRequest) -> Dict[str, Any]:
    if not ray_mod.is_available():
        raise _unavailable("ray_disabled", ray_mod.unavailable_reason())
    return ray_mod.submit(req.kind, req.payload)


@app.get("/ray/jobs/{job_id}")
def ray_get_job(job_id: str) -> Dict[str, Any]:
    if not ray_mod.is_available():
        raise _unavailable("ray_disabled", ray_mod.unavailable_reason())
    return ray_mod.get_job(job_id)


# ── /langgraph ────────────────────────────────────────────────────────
class LangGraphRunRequest(BaseModel):
    user_prompt: str
    niche: Optional[str] = None
    max_iters: int = 3


@app.post("/langgraph/run")
def langgraph_run(req: LangGraphRunRequest) -> Dict[str, Any]:
    if not lg_mod.is_available():
        raise _unavailable("langgraph_disabled", lg_mod.unavailable_reason())
    return lg_mod.run(req.user_prompt, req.niche, req.max_iters)


# ── /dspy ─────────────────────────────────────────────────────────────
class DspyRetrainRequest(BaseModel):
    niche: Optional[str] = None
    dry_run: bool = False
    max_trials: int = 20
    max_cost_usd: float = 50.0
    min_improvement_pct: float = 5.0


@app.get("/dspy/status")
def dspy_status() -> Dict[str, Any]:
    return dspy_mod.status()


@app.post("/dspy/retrain")
def dspy_retrain(req: DspyRetrainRequest) -> Dict[str, Any]:
    if not dspy_mod.is_available():
        raise _unavailable("dspy_disabled", dspy_mod.unavailable_reason())
    return dspy_mod.retrain(
        niche=req.niche,
        dry_run=req.dry_run,
        max_trials=req.max_trials,
        max_cost_usd=req.max_cost_usd,
        min_improvement_pct=req.min_improvement_pct,
    )


# ── /ga4 ──────────────────────────────────────────────────────────────
class Ga4FetchRequest(BaseModel):
    property_id: str
    page_paths: List[str]
    date_range: str = "14daysAgo"


@app.post("/ga4/fetch")
def ga4_fetch(req: Ga4FetchRequest) -> Dict[str, Any]:
    if not ga4_mod.is_available():
        raise _unavailable("ga4_disabled", ga4_mod.unavailable_reason())
    return ga4_mod.fetch_page_metrics(req.property_id, req.page_paths, req.date_range)


# ── /mutate ───────────────────────────────────────────────────────────
class MutateAnalyzeRequest(BaseModel):
    file_path: str
    old_code: str
    error_context: str = ""
    dom_snippet: str = ""


@app.post("/mutate/analyze")
def mutate_analyze(req: MutateAnalyzeRequest) -> Dict[str, Any]:
    if not mut_mod.is_available():
        raise _unavailable("mutator_disabled", mut_mod.unavailable_reason())
    return mut_mod.analyze(req.file_path, req.old_code, req.error_context, req.dom_snippet)
