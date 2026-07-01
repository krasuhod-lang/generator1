"""Модуль 3: LangGraph State Machine.

Поток:
    START → DataIngestion → EntityResearch → Structure → Drafting →
    CriticFactCheck →
        ├─ score≥8.0            → Finalize  → END
        ├─ score<8.0, retry<2   → Drafting (с feedback)
        └─ score<8.0, retry≥2   → Fallback (needs_human_review=True) → END

Обёртка поверх существующего пайплайна — логику keys.so / xmlstock и вызовы
LLM НЕ дублируем, а внедряем через `PipelineDeps` (dependency injection).
Реальная интеграция подставляет боевые колбэки (Node/DeepSeek/Gemini);
по умолчанию используются оффлайн-заглушки, чтобы граф запускался и
тестировался без внешних сервисов.

Graceful degradation: langgraph — опциональная зависимость. Если пакет не
установлен, используется встроенный последовательный исполнитель с той же
маршрутизацией (routing_function), поэтому run_seo_pipeline работает всегда.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from .drmax import build_drmax_signals
from .hybrid_scorer import HybridScorer
from .models import HybridScoreResult, PipelineStatus, SEOPipelineState

_REASON = None
try:  # pragma: no cover - зависит от окружения
    from langgraph.graph import END, StateGraph  # type: ignore

    _LG_OK = True
except Exception as e:  # pragma: no cover
    StateGraph = None  # type: ignore
    END = None  # type: ignore
    _LG_OK = False
    _REASON = f"langgraph_missing: {e.__class__.__name__}"


def is_available() -> bool:
    """True, если установлен langgraph (иначе — встроенный fallback-исполнитель)."""
    return _LG_OK


def unavailable_reason() -> Optional[str]:
    return _REASON


MAX_RETRIES = 2


# ── Оффлайн-заглушки по умолчанию ────────────────────────────────────
def _default_fetch_semantics(keyword: str, project_id: str) -> Dict[str, Any]:
    return {"keyword": keyword, "lsi_terms": []}


def _default_fetch_serp(keyword: str, project_id: str) -> List[Dict[str, Any]]:
    return []


def _default_entity_research(state: SEOPipelineState) -> Dict[str, Any]:
    return {
        "ground_truth": "",
        "entities": [],
        "unique_entities": [],
        "frequencies": {},
    }


def _default_generate_structure(state: SEOPipelineState) -> str:
    return f"H1: {state.keyword}"


def _default_draft(state: SEOPipelineState, drmax_signals: str) -> Dict[str, Any]:
    # Детерминированная заглушка: собирает текст из структуры и обязательных
    # сущностей (без LLM). Реальная интеграция подставляет Gemini + DSPy.
    parts = [state.structure or state.keyword]
    if state.entities_required:
        parts.append(" ".join(state.entities_required))
    return {"draft_text": "\n".join(parts), "used_facts": []}


def _default_extract_entities(text: str) -> List[str]:
    return []


def _default_extract_lsi_terms(raw_semantics: Optional[Dict[str, Any]]) -> List[str]:
    if not raw_semantics:
        return []
    return list(raw_semantics.get("lsi_terms", []) or [])


def _default_llm_factcheck(state: SEOPipelineState, hybrid: HybridScoreResult) -> Dict[str, Any]:
    return {"hallucinations": [], "feedback": ""}


@dataclass
class PipelineDeps:
    """Точки внедрения внешней логики (keys.so, xmlstock, DeepSeek, Gemini).

    Все поля — колбэки с оффлайн-заглушками по умолчанию, поэтому пайплайн
    запускается и без внешних сервисов (для тестов и локального прогона)."""

    fetch_semantics: Callable[[str, str], Dict[str, Any]] = _default_fetch_semantics
    fetch_serp: Callable[[str, str], List[Dict[str, Any]]] = _default_fetch_serp
    entity_research: Callable[[SEOPipelineState], Dict[str, Any]] = _default_entity_research
    generate_structure: Callable[[SEOPipelineState], str] = _default_generate_structure
    draft: Callable[[SEOPipelineState, str], Dict[str, Any]] = _default_draft
    extract_entities: Callable[[str], List[str]] = _default_extract_entities
    extract_lsi_terms: Callable[[Optional[Dict[str, Any]]], List[str]] = _default_extract_lsi_terms
    llm_factcheck: Callable[[SEOPipelineState, HybridScoreResult], Dict[str, Any]] = _default_llm_factcheck
    is_commercial: bool = False
    scorer: HybridScorer = field(default_factory=HybridScorer)


# ── Ноды ─────────────────────────────────────────────────────────────
def data_ingestion_node(state: SEOPipelineState, deps: PipelineDeps) -> SEOPipelineState:
    """Обёртка над существующим кодом keys.so + xmlstock. Логику НЕ меняем."""
    state.raw_semantics = deps.fetch_semantics(state.keyword, state.project_id)
    state.serp_top20 = deps.fetch_serp(state.keyword, state.project_id)
    return state


def entity_research_node(state: SEOPipelineState, deps: PipelineDeps) -> SEOPipelineState:
    """DeepSeek v4: Ground Truth + Named Entities + Information Gain из ТОП-20."""
    resp = deps.entity_research(state)
    state.ground_truth_context = resp.get("ground_truth", "")
    state.entities_required = list(resp.get("entities", []) or [])
    state.unique_entities = list(resp.get("unique_entities", []) or [])
    state.competitor_frequencies = dict(resp.get("frequencies", {}) or {})
    return state


def structure_node(state: SEOPipelineState, deps: PipelineDeps) -> SEOPipelineState:
    """DeepSeek v4: H1-H3 каркас по методологии DrMax."""
    state.structure = deps.generate_structure(state)
    return state


def drafting_node(state: SEOPipelineState, deps: PipelineDeps) -> SEOPipelineState:
    """Gemini 3.1 Pro + скомпилированная DSPy программа. При ретрае передаёт feedback."""
    signals = build_drmax_signals(state.keyword, is_commercial=deps.is_commercial)
    if state.retry_feedback:
        signals += (
            f"\n\n## ИСПРАВЛЕНИЯ (попытка {state.retry_count + 1}/{MAX_RETRIES})\n"
            f"{state.retry_feedback}"
        )
    result = deps.draft(state, signals)
    state.draft_text = result.get("draft_text", "")
    used_facts = result.get("used_facts", [])
    if isinstance(used_facts, str):
        used_facts = json.loads(used_facts) if used_facts else []
    state.used_facts = list(used_facts or [])
    state.retry_count += 1
    return state


def critic_factcheck_node(state: SEOPipelineState, deps: PipelineDeps) -> SEOPipelineState:
    """DeepSeek v4: HybridScorer + LLM-as-a-Judge фактчекинг."""
    lsi_terms = deps.extract_lsi_terms(state.raw_semantics)
    corpus = [p.get("content", "") for p in (state.serp_top20 or [])]
    entities_gen = deps.extract_entities(state.draft_text or "")
    hybrid = deps.scorer.score(
        state.project_id,
        state.keyword,
        lsi_terms,
        state.draft_text or "",
        corpus,
        state.entities_required,
        entities_gen,
        state.competitor_frequencies,
        state.entities_required,
    )
    # LLM-as-a-Judge: дополнительный фактчекинг DeepSeek.
    judge = deps.llm_factcheck(state, hybrid)
    hallucinations = judge.get("hallucinations") or []
    state.hybrid_score = hybrid
    state.retry_feedback = "\n".join(
        filter(
            None,
            [
                hybrid.feedback,
                judge.get("feedback") or "",
                f"Галлюцинации: {hallucinations}" if hallucinations else "",
            ],
        )
    )
    return state


def finalize_node(state: SEOPipelineState, deps: PipelineDeps) -> SEOPipelineState:
    state.final_text = state.draft_text
    state.status = PipelineStatus.DONE
    return state


def fallback_node(state: SEOPipelineState, deps: PipelineDeps) -> SEOPipelineState:
    """НЕ роняет пайплайн. Сохраняет черновик, ставит флаг проверки."""
    state.final_text = state.draft_text
    state.needs_human_review = True
    state.status = PipelineStatus.FALLBACK
    return state


# ── Маршрутизация ────────────────────────────────────────────────────
def routing_function(state: SEOPipelineState) -> str:
    if state.status == PipelineStatus.FAILED:
        return "fallback"
    if state.hybrid_score and state.hybrid_score.passed:
        return "finalize"
    if state.retry_count < MAX_RETRIES:
        return "retry"
    return "fallback"


# ── Сборка графа ─────────────────────────────────────────────────────
def build_pipeline(deps: Optional[PipelineDeps] = None):
    """Собрать LangGraph-граф. Требует установленного langgraph."""
    if not _LG_OK:
        raise RuntimeError(f"langgraph недоступен: {_REASON}")
    deps = deps or PipelineDeps()

    def _bind(fn):
        return lambda state: fn(state, deps)

    g = StateGraph(SEOPipelineState)
    for name, fn in [
        ("data_ingestion", data_ingestion_node),
        ("entity_research", entity_research_node),
        ("structure", structure_node),
        ("drafting", drafting_node),
        ("critic_factcheck", critic_factcheck_node),
        ("finalize", finalize_node),
        ("fallback", fallback_node),
    ]:
        g.add_node(name, _bind(fn))
    g.set_entry_point("data_ingestion")
    g.add_edge("data_ingestion", "entity_research")
    g.add_edge("entity_research", "structure")
    g.add_edge("structure", "drafting")
    g.add_edge("drafting", "critic_factcheck")
    g.add_conditional_edges(
        "critic_factcheck",
        routing_function,
        {"finalize": "finalize", "retry": "drafting", "fallback": "fallback"},
    )
    g.add_edge("finalize", END)
    g.add_edge("fallback", END)
    return g.compile()


def _run_sequential(state: SEOPipelineState, deps: PipelineDeps) -> SEOPipelineState:
    """Fallback-исполнитель без langgraph. Повторяет маршрутизацию графа."""
    state = data_ingestion_node(state, deps)
    state = entity_research_node(state, deps)
    state = structure_node(state, deps)
    # Цикл Drafting → Critic → routing (finalize / retry / fallback).
    while True:
        state = drafting_node(state, deps)
        state = critic_factcheck_node(state, deps)
        route = routing_function(state)
        if route == "finalize":
            return finalize_node(state, deps)
        if route == "fallback":
            return fallback_node(state, deps)
        # route == "retry" → повторяем drafting с feedback.


def run_seo_pipeline(
    project_id: str,
    keyword: str,
    deps: Optional[PipelineDeps] = None,
) -> SEOPipelineState:
    """Запустить пайплайн для одного ключа. Работает с langgraph и без него."""
    deps = deps or PipelineDeps()
    initial = SEOPipelineState(project_id=project_id, keyword=keyword)
    if _LG_OK:
        pipeline = build_pipeline(deps)
        result = pipeline.invoke(initial)
        # langgraph может вернуть dict-подобное состояние — нормализуем.
        if isinstance(result, SEOPipelineState):
            return result
        return SEOPipelineState(**dict(result))
    return _run_sequential(initial, deps)
