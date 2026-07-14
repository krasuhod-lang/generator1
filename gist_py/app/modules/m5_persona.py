"""M5 Persona Generator — профиль автора (промпт G2-PERSONA).

Персона задаёт конкретный голос текста, чтобы он не выглядел усреднённым
LLM-письмом.
"""

from __future__ import annotations

import logging
from typing import Dict, Optional

from .. import prompts
from ..llm import LLMClient, extract_first_json

logger = logging.getLogger("gist_py.m5")

DEFAULT_PERSONA = {
    "role": "практикующий специалист по теме",
    "experience": "работает с темой ежедневно, разбирает реальные кейсы",
    "position": "прагматик",
    "tone": {"formality": 3, "irony": False, "practice_based": True},
    "typical_phrases": [],
    "taboo": ["канцелярит", "рекламные обещания"],
    "short_bio": "практикующий специалист, который пишет из собственного опыта",
}


def generate_persona(
    keyword: str,
    target_audience: str,
    content_format: str,
    llm: Optional[LLMClient] = None,
) -> Dict:
    """Создать профиль автора; при сбое LLM вернуть дефолтную персону."""
    llm = llm or LLMClient()
    try:
        raw = llm.complete(
            prompts.render(
                prompts.G2_PERSONA,
                keyword=keyword,
                target_audience=target_audience or "широкая аудитория",
                content_format=content_format,
            )
        )
        persona = extract_first_json(raw)
        if not isinstance(persona, dict):
            raise ValueError("не JSON")
    except Exception as exc:
        logger.warning("G2-PERSONA не удался (%s), дефолтная персона", exc)
        persona = dict(DEFAULT_PERSONA)
    persona.setdefault("taboo", DEFAULT_PERSONA["taboo"])
    if not persona.get("short_bio"):
        role = persona.get("role") or persona.get("РОЛЬ") or DEFAULT_PERSONA["role"]
        exp = persona.get("experience") or persona.get("ОПЫТ") or ""
        persona["short_bio"] = f"{role}. {exp}".strip(". ")
    return persona
