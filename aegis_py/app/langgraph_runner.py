"""LangGraph runner (writer → critic → refiner) — Python вариант для
сценариев, где удобно вызывать orchestrator из Python (например, из
DSPy retrain'а).

В Node-стеке аналог — backend/src/services/aegis/orchestrator.js. Здесь
оставляем минимальную обёртку: если langgraph не установлен — graceful
degradation, иначе — рендерим простой 3-step граф.
"""

from typing import Any, Callable, Dict, Optional

_REASON = None
try:  # pragma: no cover
    from langgraph.graph import StateGraph, END  # type: ignore
    _LG_OK = True
except Exception as e:  # pragma: no cover
    StateGraph = None  # type: ignore
    END = None  # type: ignore
    _LG_OK = False
    _REASON = f"langgraph_missing: {e.__class__.__name__}"


def is_available() -> bool:
    return _LG_OK


def unavailable_reason() -> Optional[str]:
    return _REASON


def run(
    user_prompt: str,
    niche: Optional[str],
    max_iters: int,
    bio_predictor: Optional[Callable[..., Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Заглушка: возвращает trace без реального вызова LLM.

    В Node-пайплайне реальный writer/critic/refiner уже реализованы —
    эта функция нужна только для случаев, когда DSPy/optimizer хочет
    запустить symbolic-граф изолированно (без HTTP).
    """
    trace = []
    bio_score = None
    bio_gate = "pass"
    if bio_predictor is not None:
        try:
            bio = bio_predictor(text=user_prompt, threshold_fast_reject=0.35)
            bio_score = bio.get("score")
            bio_gate = bio.get("gate") or "pass"
            trace.append({"iter": 0, "node": "bio_filter", "score": bio_score, "gate": bio_gate})
            if bio_gate == "fast_reject":
                trace.append({"iter": 0, "node": "refiner", "reason": "bio_fast_reject"})
        except Exception:
            trace.append({"iter": 0, "node": "bio_filter", "error": "predict_failed"})
    for i in range(max_iters):
        trace.append({"iter": i, "node": "writer", "ok": True})
        trace.append({"iter": i, "node": "critic", "score_stub": 75 + i * 3})
    return {
        "user_prompt": user_prompt,
        "niche": niche,
        "iterations": max_iters,
        "bio_score": bio_score,
        "bio_gate": bio_gate,
        "trace": trace,
        "stub": True,
        "note": "Real writer/critic live in Node orchestrator.js",
    }
