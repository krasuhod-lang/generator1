"""M-1 Topic Discovery — поиск информационной лакуны InfoGapRadar.

Модуль оценивает разрыв между спросом и качеством предложения до запуска
основного GIST-пайплайна. LLM-этап опционален: при сбое используется
детерминированная классификация или режим ручной проверки.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from .. import prompts
from ..config import CONFIG
from ..llm import LLMClient, extract_first_json

logger = logging.getLogger("gist_py.m_minus_1")

ALLOWED_STATUSES = {"void", "lack", "balance", "abundance"}


def _clamp(value: Any, default: float = 50.0) -> float:
    try:
        num = float(value)
    except (TypeError, ValueError):
        return default
    return max(0.0, min(100.0, num))


def _extract_signal(data: Any, keys: tuple[str, ...], default: Optional[float] = None) -> Optional[float]:
    if isinstance(data, dict):
        for key in keys:
            if key in data:
                return _clamp(data[key])
    return default


def classify_topic_score(demand_signal: float, supply_quality: float) -> str:
    """Классифицировать тему по дельте спроса и качества предложения.

    `demand_signal` и `supply_quality` нормированы в диапазоне 0..100.
    Высокий спрос при почти пустом или слабом SERP даёт `void`/`lack`;
    качественное предложение выше спроса даёт `abundance`.
    """
    demand = _clamp(demand_signal)
    supply = _clamp(supply_quality)
    delta = demand - supply
    if (demand >= 60 and supply <= 30) or delta >= 50:
        return "void"
    if delta >= 15 or (demand >= 50 and supply <= 45):
        return "lack"
    if delta <= -20 or (supply >= 75 and demand < 70):
        return "abundance"
    return "balance"


def _fallback_result(query: str, trends_data=None) -> Dict:
    demand = _extract_signal(trends_data, ("demand_signal", "demand", "trend_score", "score"))
    supply = _extract_signal(trends_data, ("supply_quality", "supply", "serp_quality"))
    if demand is None or supply is None:
        logger.warning("M-1: недостаточно числовых сигналов для %s — нужна ручная проверка", query)
        return {
            "topic_status": "balance",
            "topic_score": 50.0,
            "go_decision": True,
            "sub_niche_suggestions": [],
            "reasoning": "LLM недоступен, числовые сигналы неполные; требуется ручная проверка.",
            "manual_review": True,
        }
    status = classify_topic_score(demand, supply)
    score = round(max(0.0, min(100.0, 50.0 + (demand - supply) / 2.0)), 2)
    suggestions = [f"Узкий сценарий запроса: {query}"] if status == "abundance" else []
    return {
        "topic_status": status,
        "topic_score": score,
        "go_decision": status in CONFIG["topic_score_go_states"],
        "sub_niche_suggestions": suggestions,
        "reasoning": "Детерминированная оценка по demand_signal и supply_quality.",
    }


def _normalize_result(data: Any, query: str, trends_data=None) -> Dict:
    if not isinstance(data, dict):
        return _fallback_result(query, trends_data)
    status = str(data.get("topic_status", "")).strip().lower()
    if status not in ALLOWED_STATUSES:
        fallback = _fallback_result(query, trends_data)
        status = fallback["topic_status"]
    score = _clamp(data.get("topic_score"), 50.0)
    suggestions = data.get("sub_niche_suggestions") or []
    if not isinstance(suggestions, list):
        suggestions = [str(suggestions)]
    suggestions = [str(s).strip() for s in suggestions if str(s).strip()]
    if status == "abundance" and not suggestions:
        suggestions = [f"Сузить тему до подниши с конкретным сценарием: {query}"]
    return {
        "topic_status": status,
        "topic_score": score,
        "go_decision": status in CONFIG["topic_score_go_states"],
        "sub_niche_suggestions": suggestions,
        "reasoning": str(data.get("reasoning") or ""),
    }


def discover_topic(
    query: str,
    trends_data=None,
    reddit_insights=None,
    paa_questions=None,
    llm: Optional[LLMClient] = None,
) -> Dict:
    """Оценить статус темы по InfoGapRadar и вернуть go/no-go решение."""
    llm = llm or LLMClient()
    try:
        raw = llm.complete(
            prompts.render(
                prompts.M_MINUS_1_DISCOVERY,
                query=query,
                trends_data=trends_data or {},
                reddit_insights=reddit_insights or [],
                paa_questions=paa_questions or [],
            ),
            temperature=0.2,
        )
        return _normalize_result(extract_first_json(raw), query, trends_data)
    except Exception as exc:
        logger.warning("M-1 Topic Discovery пропущен: %s", exc)
        return _fallback_result(query, trends_data)
