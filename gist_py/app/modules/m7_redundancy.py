"""M7 Redundancy Checker — поиск избыточных блоков (промпт G3-REDUNDANCY).

Критерии: высокая семантическая схожесть с top10_claims, блок заменяем любым
конкурентом, нет первичных данных, нет реального опыта.
"""

from __future__ import annotations

import logging
import re
from typing import Dict, List, Optional

from .. import prompts
from ..embeddings import cosine_similarity
from ..llm import LLMClient, extract_first_json

logger = logging.getLogger("gist_py.m7")

SIMILARITY_HIGH = 0.75  # эвристический порог семантической схожести блока


def heuristic_redundancy(article_draft: str, top10_claims: List[str]) -> List[Dict]:
    """Детерминированная оценка: cosine схожесть параграфов с top10_claims."""
    blocks = [
        p.strip()
        for p in re.split(r"\n\s*\n", article_draft or "")
        if p.strip() and not p.strip().startswith("#")
    ]
    report: List[Dict] = []
    for block in blocks:
        best = max(
            (cosine_similarity(block, claim) for claim in top10_claims),
            default=0.0,
        )
        level = "HIGH" if best > SIMILARITY_HIGH else "MEDIUM" if best > 0.5 else "LOW"
        report.append(
            {
                "block": block[:200],
                "similarity": round(best, 3),
                "redundancy": level,
            }
        )
    return report


def check_redundancy(
    article_draft: str,
    top10_claims: List[str],
    llm: Optional[LLMClient] = None,
) -> Dict:
    """Полный проход M7: LLM-аудит + эвристика схожести."""
    llm = llm or LLMClient()
    heuristic = heuristic_redundancy(article_draft, top10_claims)
    llm_report = None
    try:
        raw = llm.complete(
            prompts.render(
                prompts.G3_REDUNDANCY,
                article_draft=article_draft,
                top10_claims="\n".join(f"- {c}" for c in top10_claims),
            )
        )
        llm_report = extract_first_json(raw)
    except Exception as exc:
        logger.warning("G3-REDUNDANCY LLM-аудит не удался: %s", exc)
    return {
        "blocks": llm_report if isinstance(llm_report, (list, dict)) else [],
        "heuristic": heuristic,
        "high_redundancy_count": sum(
            1 for b in heuristic if b["redundancy"] == "HIGH"
        ),
    }
