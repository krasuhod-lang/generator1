"""M6 Content Generator (G3) — генерация статьи по секциям.

Каждая секция создаётся отдельным вызовом (интро / базовые / экспертные),
чтобы контролировать структуру и антидетекцию.
"""

from __future__ import annotations

import logging
from typing import Dict, List, Optional

from .. import prompts
from ..llm import LLMClient

logger = logging.getLogger("gist_py.m6")

# Запрещённые клише (G3): используются и для пост-проверки
BANNED_PHRASES = [
    "стоит отметить",
    "следует подчеркнуть",
    "важно понимать",
    "в свою очередь",
    "более того",
    "кроме того",
    "в современном мире",
    "сегодня всё больше",
    "в данной статье мы рассмотрим",
]


def _persona_vars(persona: Dict) -> Dict[str, str]:
    taboo = persona.get("taboo") or []
    if isinstance(taboo, list):
        taboo = "; ".join(str(t) for t in taboo)
    return {
        "persona_short_bio": str(persona.get("short_bio", "")),
        "persona_taboo": str(taboo),
    }


def generate_intro(keyword: str, persona: Dict, llm: Optional[LLMClient] = None) -> str:
    llm = llm or LLMClient()
    return llm.complete(
        prompts.render(prompts.G3_INTRO, keyword=keyword, **_persona_vars(persona)),
        temperature=0.7,
    ).strip()


def generate_section(
    keyword: str,
    section: Dict,
    persona: Dict,
    information_delta: List[str],
    top10_claims: List[str],
    llm: Optional[LLMClient] = None,
) -> str:
    """Сгенерировать одну секцию (экспертную — G3-SECTION-EXPERT, базовую — BASE)."""
    llm = llm or LLMClient()
    common = dict(
        keyword=keyword,
        h2_title=section.get("h2", ""),
        section_brief=section.get("brief", ""),
        word_count=section.get("word_count", 250),
        **_persona_vars(persona),
    )
    if section.get("is_expert"):
        prompt = prompts.render(
            prompts.G3_SECTION_EXPERT,
            section_type=section.get("type", "TEXT"),
            information_delta_claims="\n".join(f"- {d}" for d in information_delta),
            **common,
        )
    else:
        prompt = prompts.render(
            prompts.G3_SECTION_BASE,
            top10_context="\n".join(f"- {c}" for c in top10_claims[:15]),
            **common,
        )
    return llm.complete(prompt, temperature=0.7).strip()


def find_banned_phrases(text: str) -> List[str]:
    """Пост-проверка на клише из запрещённого списка."""
    lower = (text or "").lower()
    return [p for p in BANNED_PHRASES if p in lower]


def generate_article(
    keyword: str,
    outline: Dict,
    persona: Dict,
    information_delta: List[str],
    top10_claims: List[str],
    llm: Optional[LLMClient] = None,
) -> str:
    """Собрать статью: H1 + интро + все секции в Markdown."""
    llm = llm or LLMClient()
    parts: List[str] = [f"# {outline.get('h1', keyword)}", ""]
    try:
        parts += [generate_intro(keyword, persona, llm), ""]
    except Exception as exc:
        logger.warning("Интро не сгенерировано: %s", exc)
    for section in outline.get("sections", []):
        body = generate_section(
            keyword, section, persona, information_delta, top10_claims, llm
        )
        banned = find_banned_phrases(body)
        if banned:
            logger.warning(
                "Секция «%s» содержит клише: %s", section.get("h2"), banned
            )
        parts += [f"## {section.get('h2', '')}", "", body, ""]
    return "\n".join(parts).strip()
