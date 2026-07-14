"""M2 Noise Extractor (G1) — атомарные claims из страниц конкурентов.

Каждая страница → 10–30 атомарных тезисов (промпт G1-EXTRACT), затем общий
пул top10_claims дедуплицируется через embeddings (cosine > 0.85).
"""

from __future__ import annotations

import logging
from typing import Dict, List, Optional

from .. import prompts
from ..embeddings import dedup_claims
from ..llm import LLMClient, parse_numbered_list

logger = logging.getLogger("gist_py.m2")

MAX_BODY_CHARS = 20000  # защита от переполнения контекста LLM


def extract_page_claims(
    page: Dict, keyword: str, llm: Optional[LLMClient] = None
) -> List[str]:
    """Извлечь claims одной страницы промптом G1-EXTRACT."""
    llm = llm or LLMClient()
    raw = llm.complete(
        prompts.render(
            prompts.G1_EXTRACT,
            keyword=keyword,
            url=page.get("url", ""),
            body_text=(page.get("body_text") or "")[:MAX_BODY_CHARS],
        )
    )
    claims = parse_numbered_list(raw)
    if not claims:
        logger.warning("G1-EXTRACT вернул пустой список для %s", page.get("url"))
    return claims


def extract_noise(
    pages: List[Dict], keyword: str, llm: Optional[LLMClient] = None
) -> List[str]:
    """Полный проход M2: claims всех страниц + дедупликация → top10_claims."""
    llm = llm or LLMClient()
    all_claims: List[str] = []
    for page in pages:
        try:
            all_claims.extend(extract_page_claims(page, keyword, llm))
        except Exception as exc:
            logger.warning("M2 не смог обработать %s: %s", page.get("url"), exc)
    return dedup_claims(all_claims)
