"""M4 Content Architect — структура статьи (промпт G2-ARCH).

Правило баланса: 40% статьи — база и LSI-покрытие, 60% — уникальная дельта.
"""

from __future__ import annotations

import logging
import re
from typing import Dict, List, Optional

from .. import prompts
from ..config import CONFIG
from ..llm import LLMClient, extract_first_json

logger = logging.getLogger("gist_py.m4")

SECTION_TYPES = {"TEXT", "TABLE", "LIST", "FAQ", "EXPERT"}


def build_outline(
    keyword: str,
    target_audience: str,
    content_format: str,
    top10_claims: List[str],
    information_delta: List[str],
    llm: Optional[LLMClient] = None,
) -> Dict:
    """Построить структуру: H1, meta, секции H2/H3, ТЗ, Schema.org."""
    llm = llm or LLMClient()
    raw = llm.complete(
        prompts.render(
            prompts.G2_ARCH,
            keyword=keyword,
            target_audience=target_audience or "широкая аудитория",
            content_format=content_format,
            top10_claims_top15="\n".join(f"- {c}" for c in top10_claims[:15]),
            information_delta="\n".join(f"- {d}" for d in information_delta),
        )
        + "\n\nВерни ответ строго в JSON: {\"h1\":..., \"meta_title\":..., "
        "\"meta_description\":..., \"schema_type\":..., \"sections\":[{"
        "\"h2\":..., \"h3\":[...], \"type\":\"TEXT|TABLE|LIST|FAQ|EXPERT\", "
        "\"is_expert\":bool, \"brief\":..., \"word_count\":int, "
        "\"aio_snippet\":\"...\"}]}"
    )
    outline = extract_first_json(raw)
    if not isinstance(outline, dict) or not outline.get("sections"):
        raise RuntimeError("G2-ARCH не вернул валидную структуру")
    outline.setdefault("h1", keyword)
    outline.setdefault("meta_title", outline["h1"])
    outline.setdefault("meta_description", "")
    outline.setdefault("schema_type", "Article")
    for sec in outline["sections"]:
        stype = str(sec.get("type", "TEXT")).upper()
        sec["type"] = stype if stype in SECTION_TYPES else "TEXT"
        sec["is_expert"] = bool(
            sec.get("is_expert")
            or sec["type"] == "EXPERT"
            or "[ЭКСПЕРТНЫЙ БЛОК]" in str(sec.get("h2", "")).upper()
        )
        sec["h2"] = re.sub(
            r"\[ЭКСПЕРТНЫЙ БЛОК\]\s*", "", str(sec.get("h2", "")), flags=re.I
        ).strip()
        sec.setdefault("brief", "")
        sec.setdefault("word_count", 250)
    _check_balance(outline["sections"])
    return outline


def _check_balance(sections: List[Dict]) -> None:
    """Проверка правила 40/60; при перекосе только логируем предупреждение."""
    total = len(sections) or 1
    expert = sum(1 for s in sections if s.get("is_expert"))
    share = expert / total
    target = CONFIG["expert_blocks_share"]
    if abs(share - target) > 0.2:
        logger.warning(
            "Баланс блоков нарушен: эксперт %.0f%% (цель %.0f%%)",
            share * 100,
            target * 100,
        )
