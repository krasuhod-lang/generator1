"""SEO Content Engine v2.0 — 4 обёртки поверх текущей архитектуры.

Модуль 1: HybridScorer          (hybrid_scorer.py)
Модуль 2: DSPy Assertions       (drafting.py, text_utils.py)
Модуль 3: LangGraph State Machine (pipeline.py)
Модуль 4: DrMax E-E-A-T         (drmax.py)

Плюс: модели (models.py), конфиг LLM (llm_config.py), мультипроектность
(ProjectContext в models.py). Все heavy-зависимости (langgraph, dspy-ai,
rank-bm25) опциональны — пакет импортируется и без них.
"""

from __future__ import annotations

from .drmax import CRITIC_PROMPT, ENTITY_RESEARCH_PROMPT, build_drmax_signals
from .hybrid_scorer import HybridScorer, rank_bm25_available
from .llm_config import LLMConfig
from .models import (
    GoogleLayerScore,
    HybridScoreResult,
    PipelineStatus,
    ProjectContext,
    SEOPipelineState,
    YandexLayerScore,
)
from .pipeline import (
    PipelineDeps,
    build_pipeline,
    routing_function,
    run_seo_pipeline,
)
from .text_utils import fact_in_context, has_fluff

__all__ = [
    "HybridScorer",
    "rank_bm25_available",
    "YandexLayerScore",
    "GoogleLayerScore",
    "HybridScoreResult",
    "SEOPipelineState",
    "PipelineStatus",
    "ProjectContext",
    "PipelineDeps",
    "build_pipeline",
    "run_seo_pipeline",
    "routing_function",
    "build_drmax_signals",
    "ENTITY_RESEARCH_PROMPT",
    "CRITIC_PROMPT",
    "LLMConfig",
    "fact_in_context",
    "has_fluff",
]
