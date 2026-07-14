"""M3 Gap Finder (G2) — поиск information_delta.

Находит семантические пробелы: то, чего нет у конкурентов, но что реально
нужно пользователю (промпт G2-GAP).
"""

from __future__ import annotations

import logging
import re
from typing import Dict, List, Optional

from .. import prompts
from ..llm import LLMClient, extract_first_json, parse_numbered_list

logger = logging.getLogger("gist_py.m3")

DELTA_TYPES = ["ДАННЫЕ", "ОПЫТ", "РИСК", "СРАВНЕНИЕ", "СЦЕНАРИЙ", "МЕХАНИКА", "FAQ"]


def find_gaps(
    keyword: str,
    target_audience: str,
    top10_claims: List[str],
    llm: Optional[LLMClient] = None,
) -> Dict:
    """Полный проход M3 → {"information_delta": [...], "gap_reasoning": "..."}."""
    llm = llm or LLMClient()
    raw = llm.complete(
        prompts.render(
            prompts.G2_GAP,
            keyword=keyword,
            target_audience=target_audience or "широкая аудитория",
            top10_claims="\n".join(f"- {c}" for c in top10_claims),
        )
    )
    parsed = extract_first_json(raw)
    delta: List[str] = []
    if isinstance(parsed, dict) and isinstance(parsed.get("information_delta"), list):
        delta = [str(x) for x in parsed["information_delta"] if str(x).strip()]
    elif isinstance(parsed, list):
        for item in parsed:
            if isinstance(item, dict):
                thesis = item.get("тезис") or item.get("thesis") or item.get("claim")
                if thesis:
                    delta.append(str(thesis))
            elif isinstance(item, str) and item.strip():
                delta.append(item.strip())
    if not delta:
        delta = parse_numbered_list(raw)
    return {"information_delta": delta, "gap_reasoning": raw}


# ── GIST Score (§6) ─────────────────────────────────────────────────────────

def _paragraph_covers(paragraph: str, delta_claim: str) -> bool:
    """Параграф покрывает тезис, если пересечение значимых слов достаточное."""
    def words(t: str) -> set:
        return {w for w in re.findall(r"[а-яёa-z0-9]{4,}", t.lower())}

    pw, dw = words(paragraph), words(delta_claim)
    if not dw:
        return False
    overlap = len(pw & dw) / len(dw)
    return overlap >= 0.5


def gist_score(article_text: str, information_delta: List[str]) -> float:
    """GIST Score = covered_paragraphs / total_paragraphs * 100.

    Разбиваем статью на параграфы; параграф «покрыт», если в нём отражён
    хотя бы один тезис из information_delta.
    """
    paragraphs = [
        p.strip()
        for p in re.split(r"\n\s*\n", article_text or "")
        if p.strip() and not p.strip().startswith("#")
    ]
    if not paragraphs:
        return 0.0
    covered = sum(
        1
        for p in paragraphs
        if any(_paragraph_covers(p, d) for d in information_delta)
    )
    return round(covered / len(paragraphs) * 100, 2)
