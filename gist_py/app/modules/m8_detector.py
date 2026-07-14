"""M8 LinguaForensic Detector — полная детекция AI-текста (v3.6).

System prompt = полное содержимое skill-файла `AI-detect-v-3-6.md`
(путь: GIST_LINGUAFORENSIC_SKILL). User prompt = команда «Режим 2. Полная
детекция» (см. prompts.LF_DETECT).

Пороги robotness (§11) определяют стратегию рерайта.
"""

from __future__ import annotations

import logging
import os
from typing import Dict, Optional

from .. import prompts
from ..config import CONFIG
from ..llm import LLMClient, extract_first_json

logger = logging.getLogger("gist_py.m8")

STRATEGIES = ["accept", "light", "medium", "deep", "full"]


def load_skill() -> str:
    """Загрузить skill-файл LinguaForensic v3.6 (system prompt детектора)."""
    path = CONFIG["linguaforensic_skill_path"]
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    logger.warning(
        "Skill-файл LinguaForensic не найден: %s — детекция будет работать "
        "в упрощённом режиме (LLM без специализированного system prompt)",
        path,
    )
    return (
        "Ты — LinguaForensic v3.6, система детекции AI-сгенерированного текста. "
        "Оцени текст по структурным маркерам (вводные клише, tricolon, "
        "равномерная длина предложений, номинализации, пассив, цепочки "
        "родительного падежа) и верни строго JSON с полями: robotness_score "
        "(0–100), confidence_interval, verdict, llm_family, "
        "top_contributing_categories, structural_markers_found, fluency_issues, "
        "knockoff (объект с s_statistic), recommended_strategy, "
        "recommended_intensity."
    )


def strategy_for_score(robotness: float) -> str:
    """Пороги §11: <=20 accept, 21–35 light, 36–55 medium, 56–75 deep, >75 full."""
    if robotness <= CONFIG["robotness_accept"]:
        return "accept"
    if robotness <= CONFIG["robotness_light_max"]:
        return "light"
    if robotness <= CONFIG["robotness_medium_max"]:
        return "medium"
    if robotness <= CONFIG["robotness_deep_max"]:
        return "deep"
    return "full"


def detect(
    article_text: str,
    domain: str = "SEO-статья",
    llm: Optional[LLMClient] = None,
) -> Dict:
    """Запустить полную детекцию; вернуть нормализованный отчёт."""
    llm = llm or LLMClient()
    raw = llm.complete(
        prompts.render(prompts.LF_DETECT, domain=domain, article_text=article_text),
        system=load_skill(),
        temperature=0.1,
    )
    report = extract_first_json(raw)
    if not isinstance(report, dict):
        raise RuntimeError("LinguaForensic не вернул JSON-отчёт")
    score = float(report.get("robotness_score") or 0.0)
    knockoff = report.get("knockoff") or {}
    normalized = {
        "robotness_score": score,
        "confidence_interval": report.get("confidence_interval"),
        "verdict": report.get("verdict"),
        "llm_family": report.get("llm_family"),
        "top_contributing_categories": report.get("top_contributing_categories") or [],
        "structural_markers_found": report.get("structural_markers_found") or [],
        "fluency_issues": report.get("fluency_issues") or [],
        "knockoff_s": (
            knockoff.get("s_statistic")
            if isinstance(knockoff, dict)
            else report.get("knockoff.s_statistic")
        ),
        "recommended_strategy": report.get("recommended_strategy")
        or strategy_for_score(score),
        "recommended_intensity": report.get("recommended_intensity") or "auto",
        "raw": report,
    }
    return normalized
