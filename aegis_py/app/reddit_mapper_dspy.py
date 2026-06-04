"""reddit_mapper_dspy — DSPy-сигнатуры для усиления промтов Reddit Mapper V2.

Reddit Mapper V2 (директория `Промты/`, перенесена в backend/src/prompts/redditMapper)
исследует голос аудитории по 7 этапам: картография Reddit → боли → язык →
ранние сдвиги → приоритизация тем → кластеры/страницы. Этот модуль даёт
few-shot-усиленные инструкции для ключевых извлекающих этапов, чтобы поднять
качество и стабильность выходного master JSON.

Архитектура GRACEFUL (как в projects_dspy):
    * Если `dspy-ai` установлен — определяем настоящие dspy.Signature.
    * Если НЕ установлен — модуль импортируется и отдаёт статически усиленные
      инструкции (few-shot demos захардкожены), node-сторона получает рабочий
      prompt-суффикс без DSPy.

Node вызывает это через тот же FastAPI-эндпоинт POST /dspy/prompt/{signature}.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

try:  # DSPy опционален — тяжёлая зависимость.
    import dspy  # type: ignore

    _DSPY_AVAILABLE = True
except Exception:  # pragma: no cover - окружение без dspy-ai
    dspy = None  # type: ignore
    _DSPY_AVAILABLE = False


# ── Усиленные инструкции по сигнатурам (работают и без dspy-ai) ────────────
_SIGNATURES: Dict[str, Dict[str, Any]] = {
    "RedditPainMap": {
        "instructions": (
            "Извлекай ТОЛЬКО подтверждённые Reddit-материалом боли. Каждая боль = "
            "{id, label, description, evidence_summary, source_refs, frequency_signal, "
            "emotional_weight, confidence}. Строго разделяй core_pain / objection / "
            "friction / desired_outcome. Запрещено достраивать боли из общей логики "
            "ниши: если evidence слабый — confidence=low и в quality_control.unknowns. "
            "Не путай симптом с болью. Сохраняй machine-readable master JSON."
        ),
        "demos": [
            "core_pain «не понимаю, переживу ли я установку сам или нужен сервис» — "
            "evidence: 3 треда с вопросом про самостоятельную замену; frequency=recurring",
            "objection «боюсь, что дешёвый аналог убьёт узел» — evidence: коммент с "
            "личным негативным опытом; emotional_weight=high",
        ],
    },
    "RedditLanguageMap": {
        "instructions": (
            "Извлекай ЖИВОЙ язык аудитории, не маркетинговый. Каждая запись = "
            "{id, label, pattern, interpretation, evidence_summary, linked_pain_ids, "
            "confidence}. Разделяй phrase / question_pattern / comparison_language / "
            "trust_language / emotional_language. Бери формулировки как они есть в "
            "Reddit, не перефразируй в SEO-стиль. Не выдумывай фразы без evidence."
        ),
        "demos": [
            "question_pattern «что лучше для города — X или Y?» — comparison-интент, "
            "linked_pain: выбор под ежедневную эксплуатацию",
            "trust_language «брал у них, полёт нормальный год» — маркер доверия по "
            "личному сроку эксплуатации",
        ],
    },
    "RedditTopicPriority": {
        "instructions": (
            "Приоритизируй темы по сигналам Этапов 1–4. Каждая тема = {id, label, "
            "topic_type, priority_tier(must/should/test/monitor), why_prioritized, "
            "linked_pain_ids, linked_language_ids, dimension_scores, priority_score, "
            "confidence}. priority_tier обоснуй частотой боли, силой языка и ранними "
            "сдвигами, а не вкусом. must_cover — только темы с сильным evidence."
        ),
        "demos": [
            "must: «перфорация vs насечки для города» — высокая частота вопроса + "
            "сильный comparison-язык + выраженная боль выбора",
            "monitor: новый сленговый термин с единичным упоминанием — confidence=low",
        ],
    },
}


def available_signatures() -> List[str]:
    return list(_SIGNATURES.keys())


def is_dspy_available() -> bool:
    return _DSPY_AVAILABLE


def build_prompt(signature: str, context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Возвращает усиленные инструкции + few-shot demos для сигнатуры.

    Работает и без dspy-ai (статические эталоны). Совместимо по форме ответа с
    projects_dspy.build_prompt, чтобы node-сторона дёргала единый эндпоинт.
    """
    sig = _SIGNATURES.get(signature)
    if sig is None:
        return {
            "ok": False,
            "reason": "unknown_signature",
            "available": available_signatures(),
        }
    return {
        "ok": True,
        "signature": signature,
        "instructions": sig["instructions"],
        "demos": list(sig.get("demos", [])),
        "optimized": False,
        "dspy_available": _DSPY_AVAILABLE,
        "context_keys": sorted((context or {}).keys()),
    }


if _DSPY_AVAILABLE:  # pragma: no cover - требует установленного dspy-ai

    class RedditPainMap(dspy.Signature):  # type: ignore
        """Извлечение болей/возражений/трений аудитории из Reddit-материалов."""

        reddit_materials = dspy.InputField(desc="Сырьё Reddit-обсуждений + master JSON")
        pain_map = dspy.OutputField(desc="core_pains/objections/frictions/desired_outcomes")

    class RedditLanguageMap(dspy.Signature):  # type: ignore
        """Извлечение живого языка аудитории (фразы/вопросы/сравнение/доверие)."""

        reddit_materials = dspy.InputField(desc="Сырьё Reddit + pain_map из master JSON")
        language_map = dspy.OutputField(desc="phrases/question_patterns/comparison/trust")

    class RedditTopicPriority(dspy.Signature):  # type: ignore
        """Приоритизация тем по сигналам Этапов 1–4."""

        master_json = dspy.InputField(desc="master JSON с pain/language/emerging картами")
        priority_matrix = dspy.OutputField(desc="must/should/test/monitor + priority_score")

    _DSPY_SIGNATURE_CLASSES = {
        "RedditPainMap": RedditPainMap,
        "RedditLanguageMap": RedditLanguageMap,
        "RedditTopicPriority": RedditTopicPriority,
    }
else:
    _DSPY_SIGNATURE_CLASSES = {}
