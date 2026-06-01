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
from . import vector_gc as vector_gc_mod
from .biobrain.evolver import BioBrainEvolver
from .biobrain.feature_vector import extract_features

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

BIOBRAIN = BioBrainEvolver(min_buffer_to_evolve=32)

# ── Autonomous self-evolution loop ───────────────────────────────────
# Bio-Brain "lives its own life": a daemon thread periodically evolves the
# best genome from accumulated experience, even when no article is being
# generated. Interval mirrors Node featureFlags.biobrain.evolveIntervalSec
# (config lives in code, no new ENV var). The thread only starts on FastAPI
# startup, so unit tests that build TestClient(app) without the lifespan
# context never spawn it.
import threading  # noqa: E402

BIOBRAIN_EVOLVE_INTERVAL_SEC = 300
_biobrain_stop = threading.Event()
_biobrain_thread: Optional[threading.Thread] = None


def _biobrain_evolve_loop() -> None:
    # Небольшая задержка перед первой эволюцией, чтобы дать сервису стартовать.
    while not _biobrain_stop.wait(BIOBRAIN_EVOLVE_INTERVAL_SEC):
        try:
            BIOBRAIN.maybe_evolve()
        except Exception as e:  # pragma: no cover - защитный best-effort
            log.warning("biobrain autonomous evolve failed: %s", e)


@app.on_event("startup")
def _start_biobrain_loop() -> None:  # pragma: no cover - требует живого сервиса
    global _biobrain_thread
    if not BIOBRAIN.available:
        log.info("biobrain autonomous loop skipped: %s", BIOBRAIN.reason)
        return
    if _biobrain_thread is not None:
        return
    _biobrain_stop.clear()
    _biobrain_thread = threading.Thread(
        target=_biobrain_evolve_loop, name="biobrain-evolve", daemon=True
    )
    _biobrain_thread.start()
    log.info("biobrain autonomous loop started (every %ss)", BIOBRAIN_EVOLVE_INTERVAL_SEC)


@app.on_event("shutdown")
def _stop_biobrain_loop() -> None:  # pragma: no cover
    _biobrain_stop.set()


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
            "vector_gc": vector_gc_mod.is_available(),
            "biobrain": BIOBRAIN.available,
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
    run_id: Optional[str] = None
    collection_override: Optional[str] = None


class VectordbSearchRequest(BaseModel):
    niche: str
    query: str
    top_k: int = 5
    embedder: str = "gemini"
    hybrid_alpha: float = 0.5


# ── /vectordb/gc — Phase 14.3: Tombstones & TTL ──────────────────────
class VectorGcSweepRequest(BaseModel):
    ttl_days: int = 30
    ephemeral_prefixes: List[str] = ["evidence_", "serp_", "relevance_"]
    min_age_safety_hours: int = 24
    drop_empty: bool = True


class VectorGcRunRequest(BaseModel):
    run_id: str
    collections: Optional[List[str]] = None
    ephemeral_prefixes: Optional[List[str]] = None


@app.get("/vectordb/health")
def vectordb_health() -> Dict[str, Any]:
    return {"ok": vectordb_mod.is_available(), "reason": vectordb_mod.unavailable_reason()}


@app.post("/vectordb/index")
def vectordb_index(req: VectordbIndexRequest) -> Dict[str, Any]:
    if not vectordb_mod.is_available():
        raise _unavailable("vectordb_disabled", vectordb_mod.unavailable_reason())
    return vectordb_mod.index(
        req.niche, req.paragraphs, req.source_url, req.embedder,
        run_id=req.run_id, collection_override=req.collection_override,
    )


@app.post("/vectordb/search")
def vectordb_search(req: VectordbSearchRequest) -> Dict[str, Any]:
    if not vectordb_mod.is_available():
        return {"hits": [], "reason": "vectordb_disabled"}
    return {"hits": vectordb_mod.search(req.niche, req.query, req.top_k, req.embedder, req.hybrid_alpha)}


@app.get("/vectordb/gc/health")
def vector_gc_health() -> Dict[str, Any]:
    from . import vector_gc as _gc
    return {"ok": _gc.is_available(), "reason": _gc.unavailable_reason()}


@app.post("/vectordb/gc/sweep")
def vector_gc_sweep(req: VectorGcSweepRequest) -> Dict[str, Any]:
    from . import vector_gc as _gc
    if not _gc.is_available():
        return {"status": "disabled", "reason": _gc.unavailable_reason(),
                "collections": [], "points_deleted_total": 0,
                "collections_seen": 0}
    return _gc.sweep_ttl(
        ttl_days=req.ttl_days,
        ephemeral_prefixes=req.ephemeral_prefixes,
        min_age_safety_hours=req.min_age_safety_hours,
        drop_empty=req.drop_empty,
    )


@app.post("/vectordb/gc/run")
def vector_gc_run(req: VectorGcRunRequest) -> Dict[str, Any]:
    from . import vector_gc as _gc
    if not _gc.is_available():
        return {"status": "disabled", "reason": _gc.unavailable_reason(),
                "run_id": req.run_id, "collections": [],
                "points_deleted_total": 0}
    return _gc.cleanup_run(
        run_id=req.run_id,
        collections=req.collections,
        ephemeral_prefixes=req.ephemeral_prefixes,
    )


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
    use_bio_filter: bool = True


@app.post("/langgraph/run")
def langgraph_run(req: LangGraphRunRequest) -> Dict[str, Any]:
    if not lg_mod.is_available():
        raise _unavailable("langgraph_disabled", lg_mod.unavailable_reason())
    return lg_mod.run(
        req.user_prompt, req.niche, req.max_iters,
        bio_predictor=(BIOBRAIN.predict if req.use_bio_filter else None),
    )


class BioBrainPredictRequest(BaseModel):
    features: Optional[List[float]] = None
    text: Optional[str] = None
    signals: Optional[Dict[str, Any]] = None
    threshold_fast_reject: float = 0.35


class BioBrainFeedbackRequest(BaseModel):
    features: Optional[List[float]] = None
    text: Optional[str] = None
    signals: Optional[Dict[str, Any]] = None
    predicted: Optional[float] = None
    real_spq_overall: float
    real_eeat: Optional[float] = None


@app.get("/biobrain/status")
def biobrain_status() -> Dict[str, Any]:
    return BIOBRAIN.stats()


@app.post("/biobrain/predict")
def biobrain_predict(req: BioBrainPredictRequest) -> Dict[str, Any]:
    return BIOBRAIN.predict(
        features=req.features,
        text=req.text,
        signals=req.signals,
        threshold_fast_reject=req.threshold_fast_reject,
    )


@app.post("/biobrain/feedback")
def biobrain_feedback(req: BioBrainFeedbackRequest) -> Dict[str, Any]:
    # Закрываем цикл обучения: если features не переданы, выводим их из
    # текста/сигналов (тот же детерминированный вектор, что и в predict).
    feats = req.features
    if feats is None:
        feats = extract_features(req.text or "", signals=req.signals)
    stored = BIOBRAIN.record_outcome(
        features=feats,
        real_spq_overall=req.real_spq_overall,
    )
    evolved = BIOBRAIN.maybe_evolve()
    return {
        **stored,
        "evolved": bool(evolved.get("evolved")),
        "evolve_reason": evolved.get("reason"),
        "stats": BIOBRAIN.stats(),
    }


@app.post("/biobrain/advice")
def biobrain_advice(req: BioBrainPredictRequest) -> Dict[str, Any]:
    """JARVIS-style: вернуть ранжированные подсказки для черновика."""
    pred = BIOBRAIN.predict(
        features=req.features,
        text=req.text,
        signals=req.signals,
        threshold_fast_reject=req.threshold_fast_reject,
    )
    return {
        "score": pred.get("score"),
        "gate": pred.get("gate"),
        "confidence": pred.get("confidence"),
        "advice": pred.get("advice"),
    }


# ── /dspy ─────────────────────────────────────────────────────────────
class DspyRetrainRequest(BaseModel):
    niche: Optional[str] = None
    dry_run: bool = False
    max_trials: int = 20
    max_cost_usd: float = 50.0
    min_improvement_pct: float = 5.0
    # Phase 14: cold-start + ε-greedy ───────────────────────────────
    real_rows: Optional[List[Dict[str, Any]]] = None  # caller передаёт выборку из БД
    cold_start_use_seeds: bool = True
    cold_start_min_rows: int = 10
    epsilon_greedy_rate: float = 0.07
    epsilon_greedy_max_rate: float = 0.20


@app.get("/dspy/status")
def dspy_status() -> Dict[str, Any]:
    return dspy_mod.status()


@app.get("/dspy/seeds")
def dspy_seeds_overview(niche: Optional[str] = None) -> Dict[str, Any]:
    """Phase 14.1: что лежит в seed-датасете для cold-start MIPROv2."""
    from . import dspy_seed
    rows = dspy_seed.load_seed_dataset(niche=niche)
    return {
        "total":   len(rows),
        "niches":  dspy_seed.seed_niches(),
        "filter_niche": niche,
        "items": [
            {
                "id":          r["id"],
                "niche":       r.get("niche"),
                "tags":        r.get("tags", []),
                "spq_overall": r.get("spq_overall"),
                "ppo_weight":  r.get("ppo_weight"),
                "html_chars":  len(r.get("html_output") or ""),
            }
            for r in rows
        ],
    }


@app.post("/dspy/retrain")
def dspy_retrain(req: DspyRetrainRequest) -> Dict[str, Any]:
    if not dspy_mod.is_available():
        # Phase 14: даже без dspy-ai мы можем вернуть план seed/ε-greedy
        # (dry-run эквивалент), чтобы аналитика и аудит работали.
        plan = dspy_mod.retrain(
            niche=req.niche,
            dry_run=True,
            max_trials=req.max_trials,
            max_cost_usd=req.max_cost_usd,
            min_improvement_pct=req.min_improvement_pct,
            real_rows=req.real_rows,
            cold_start_min_rows=req.cold_start_min_rows,
            cold_start_use_seeds=req.cold_start_use_seeds,
            epsilon_greedy_rate=req.epsilon_greedy_rate,
            epsilon_greedy_max_rate=req.epsilon_greedy_max_rate,
        )
        plan["available"] = False
        plan["reason"] = dspy_mod.unavailable_reason()
        return plan
    return dspy_mod.retrain(
        niche=req.niche,
        dry_run=req.dry_run,
        max_trials=req.max_trials,
        max_cost_usd=req.max_cost_usd,
        min_improvement_pct=req.min_improvement_pct,
        real_rows=req.real_rows,
        cold_start_min_rows=req.cold_start_min_rows,
        cold_start_use_seeds=req.cold_start_use_seeds,
        epsilon_greedy_rate=req.epsilon_greedy_rate,
        epsilon_greedy_max_rate=req.epsilon_greedy_max_rate,
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
