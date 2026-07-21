"""M4 Content Architect — структура статьи (промпт G2-ARCH).

Правило баланса: 40% статьи — база и LSI-покрытие, 60% — уникальная дельта.
"""

from __future__ import annotations

import logging
import json
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
    entity_footprint: Optional[Dict] = None,
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
            entity_footprint=(
                json.dumps(entity_footprint, ensure_ascii=False)
                if entity_footprint
                else "-"
            ),
        )
        + "\n\nВерни ответ строго в JSON: {\"h1\":..., \"meta_title\":..., "
        "\"meta_description\":..., \"unique_angle\":..., \"schema_type\":..., \"sections\":[{"
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
    outline.setdefault("unique_angle", "")
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


def build_entity_footprint(
    keyword: str,
    target_audience: str,
    top10_claims: List[str],
    information_delta: List[str],
    llm: Optional[LLMClient] = None,
    is_listicle: bool = False,
    promoted_domain: str = "",
) -> Dict:
    """Построить граф сущностей Entity Footprint для M4.

    Этап опциональный: если LLM недоступен или вернул невалидный JSON,
    пайплайн продолжает работу с пустым графом и primary_entity=keyword.
    """
    llm = llm or LLMClient()
    try:
        raw = llm.complete(
            prompts.render(
                prompts.G2_ENTITY,
                keyword=keyword,
                target_audience=target_audience or "широкая аудитория",
                top10_claims="\n".join(f"- {c}" for c in top10_claims[:20]),
                information_delta="\n".join(f"- {d}" for d in information_delta),
                is_listicle=str(bool(is_listicle)).lower(),
                promoted_domain=promoted_domain or "-",
            ),
            temperature=0.2,
        )
        parsed = extract_first_json(raw)
        if not isinstance(parsed, dict):
            raise ValueError("G2-ENTITY не вернул JSON-объект")
        entities = parsed.get("entities") or []
        if not isinstance(entities, list):
            entities = []
        normalized = []
        for entity in entities:
            if not isinstance(entity, dict):
                continue
            try:
                salience = float(entity.get("salience", 0.0))
            except (TypeError, ValueError):
                salience = 0.0
            normalized.append(
                {
                    "name": str(entity.get("name") or "").strip(),
                    "type": str(entity.get("type") or "unknown").strip(),
                    "salience": max(0.0, min(1.0, salience)),
                    "relations": entity.get("relations") if isinstance(entity.get("relations"), list) else [],
                    "tier1_sources": entity.get("tier1_sources")
                    if isinstance(entity.get("tier1_sources"), list)
                    else [],
                }
            )
        return {
            "entities": [e for e in normalized if e["name"]],
            "primary_entity": str(parsed.get("primary_entity") or keyword),
        }
    except Exception as exc:
        logger.warning("Entity Footprint пропущен: %s", exc)
        return {"entities": [], "primary_entity": keyword, "llm_skipped": True}


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
