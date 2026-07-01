"""Pydantic-модели SEO Content Engine v2.0.

Все выходы LLM и внутренние структуры пайплайна валидируются через Pydantic
(требование п.12 ТЗ). Модели общие для четырёх модулей рефакторинга:

    • HybridScorer      → YandexLayerScore, GoogleLayerScore, HybridScoreResult
    • LangGraph State   → SEOPipelineState, PipelineStatus
    • Мультипроектность → ProjectContext

Модели НЕ содержат бизнес-логики (только валидация) — расчёты живут в
hybrid_scorer.py, ноды — в pipeline.py.
"""

from __future__ import annotations

import uuid
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


# ── Модуль 1: HybridScorer ───────────────────────────────────────────
class YandexLayerScore(BaseModel):
    """Яндекс-слой релевантности: BM25 + LSI + анти-переспам."""

    bm25_score: float
    lsi_coverage: float          # фактический % покрытия LSI (0.0–1.0)
    keyword_density: float
    stuffing_penalty: float      # штраф если плотность ключа > 3%
    lsi_overuse_penalty: float   # штраф если LSI > 75%
    final_score: float           # итог 0–10
    details: str = ""


class GoogleLayerScore(BaseModel):
    """Google-слой: Entity coverage + Information Gain."""

    entities_top20: List[str]
    entities_generated: List[str]
    coverage_ratio: float
    unique_entities_found: int   # сущности с freq < 30% конкурентов
    information_gain_score: float  # min(unique/3, 1.0)
    final_score: float
    details: str = ""


class HybridScoreResult(BaseModel):
    """Итоговый гибридный скор (0.45*yandex + 0.55*google)."""

    project_id: str
    keyword: str
    yandex_score: YandexLayerScore
    google_score: GoogleLayerScore
    hybrid_final: float          # 0.45*yandex + 0.55*google
    passed: bool                 # True если hybrid_final >= 8.0
    feedback: Optional[str] = None  # детали для ретрая


# ── Модуль 3: LangGraph State Machine ────────────────────────────────
class PipelineStatus(str, Enum):
    RUNNING = "running"
    RETRY = "retry"
    FALLBACK = "fallback"
    DONE = "done"
    FAILED = "failed"


class SEOPipelineState(BaseModel):
    """Единое состояние пайплайна. Pydantic (не TypedDict) — для автовалидации."""

    # Идентификация
    project_id: str
    keyword: str
    trace_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    # Данные (DataIngestion)
    raw_semantics: Optional[Dict[str, Any]] = None
    serp_top20: Optional[List[Dict[str, Any]]] = None
    # Ground Truth (EntityResearch)
    ground_truth_context: Optional[str] = None
    entities_required: List[str] = Field(default_factory=list)
    unique_entities: List[str] = Field(default_factory=list)
    competitor_frequencies: Dict[str, float] = Field(default_factory=dict)
    # Структура (StructureNode)
    structure: Optional[str] = None
    # Генерация (DraftingNode)
    draft_text: Optional[str] = None
    used_facts: List[str] = Field(default_factory=list)
    # Скоринг (CriticNode)
    hybrid_score: Optional[HybridScoreResult] = None
    # Управление ретраями
    retry_count: int = Field(default=0, ge=0, le=2)
    retry_feedback: Optional[str] = None
    # Результат
    final_text: Optional[str] = None
    status: PipelineStatus = PipelineStatus.RUNNING
    needs_human_review: bool = False
    error_log: List[str] = Field(default_factory=list)


# ── Модуль 9: Мультипроектность ──────────────────────────────────────
class ProjectContext(BaseModel):
    """Настройки проекта. Интегрируется с существующей инфраструктурой
    хранения проектов — не заменяет её."""

    project_id: str
    language: str = "ru"
    search_engine_priority: str = "both"  # "yandex" | "google" | "both"
    hybrid_score_weights: Dict[str, float] = Field(
        default_factory=lambda: {"yandex": 0.45, "google": 0.55}
    )
    lsi_coverage_target: float = Field(default=0.70, ge=0.60, le=0.75)
    minimum_word_count: int = 800
