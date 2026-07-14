"""M0 Relevance Scanner — классификация запросов по AIO/LLM-потенциалу.

Сначала детерминированный regex-анализ (обязательные группы из ТЗ §3),
затем LLM (промпт G0-FORMAT) только для доразметки формата контента.
"""

from __future__ import annotations

import csv
import io
import json
import logging
import re
from typing import Dict, List, Optional

from .. import prompts
from ..llm import LLMClient, LLMUnavailable, extract_first_json

logger = logging.getLogger("gist_py.m0")

# Обязательные regex-группы (§3). Порядок = приоритет при нескольких матчах.
# Каждая группа: (name, pattern, trigger_rate, content_type,
#                 zero_click_risk, needs_table, needs_steps)
TRIGGER_GROUPS = [
    (
        "howto",
        r"\bкак\s+(?:сделать|настроить|установить|подключить|выбрать|создать|"
        r"написать|собрать|запустить|удалить|исправить|проверить|включить|"
        r"отключить|поменять|заменить|использовать)\b|\bhow\s+to\b|\bпошагов",
        0.85, "HOW-TO", "HIGH", False, True,
    ),
    (
        "troubleshooting",
        r"\bне\s+(?:работает|включается|запускается|открывается|грузится|"
        r"подключается|обновляется|устанавливается)\b|\bошибк\w+|\bпроблем\w+|"
        r"\bне\s+удалось\b|\berror\b|\bfix\b|\bзависает\b|\bвылетает\b|\bсбой\b",
        0.75, "TROUBLESHOOT", "MEDIUM", False, True,
    ),
    (
        "comparison",
        r"\b(?:или|vs|versus|против)\b|\bсравнени\w+|\bчем\s+отличает\w+|"
        r"\bразница\s+между\b|\bотличи[ея]\b|\bлучше\s*[:,]?\s*.+\s+или\b",
        0.8, "COMPARISON", "HIGH", True, False,
    ),
    (
        "best_top_list",
        r"\b(?:лучши[ейх]|топ|top|рейтинг|подборк\w+|список)\b|\b\d+\s+лучших\b|\bbest\b",
        0.7, "LIST", "MEDIUM", True, False,
    ),
    (
        "definition",
        r"^что\s+(?:такое|значит|означает)\b|\bопределени[ея]\b|\bwhat\s+is\b|\bрасшифровка\b",
        0.9, "DEFINITION", "HIGH", False, False,
    ),
    (
        "freshness",
        r"\b20\d{2}\b|\bсегодня\b|\bсейчас\b|\bновы[йе]\b|\bпоследн\w+\b|"
        r"\bактуальн\w+\b|\bсвеж\w+\b",
        0.6, "DEEP-DIVE", "MEDIUM", False, False,
    ),
    (
        "commercial",
        r"\bкупить\b|\bцена\b|\bстоимость\b|\bзаказать\b|\bнедорого\b|\bдешево\b|"
        r"\bскидк\w+\b|\bдоставк\w+\b|\bпрайс\b|\bстоит\b|\bсколько\s+стоит\b|\bуслуг\w+\b",
        0.2, "COMMERCIAL", "LOW", False, False,
    ),
    (
        "question",
        r"^(?:что|как|почему|зачем|когда|где|какой|какая|какие|каков|можно\s+ли|"
        r"нужно\s+ли|стоит\s+ли|сколько|чем|кто|куда|откуда)\b|\?$",
        0.8, "FAQ", "HIGH", False, False,
    ),
]

CONVERSATIONAL_MIN_WORDS = 9  # conversational 9+ слов


def classify_query(query: str) -> Dict:
    """Детерминированная классификация одного запроса по regex-группам."""
    q = (query or "").strip().lower()
    result = {
        "query": query,
        "trigger_group": "other",
        "trigger_rate": 0.3,
        "content_type": "DEEP-DIVE",
        "zero_click_risk": "LOW",
        "needs_table": False,
        "needs_steps": False,
    }
    for name, pattern, rate, ctype, risk, table, steps in TRIGGER_GROUPS:
        if re.search(pattern, q, re.IGNORECASE):
            result.update(
                trigger_group=name,
                trigger_rate=rate,
                content_type=ctype,
                zero_click_risk=risk,
                needs_table=table,
                needs_steps=steps,
            )
            break
    if len(q.split()) >= CONVERSATIONAL_MIN_WORDS:
        result["trigger_group"] = (
            "conversational"
            if result["trigger_group"] == "other"
            else result["trigger_group"]
        )
        result["trigger_rate"] = round(min(1.0, result["trigger_rate"] + 0.1), 3)
        if result["zero_click_risk"] == "LOW":
            result["zero_click_risk"] = "MEDIUM"
    return result


def parse_gsc_csv(content: str) -> List[Dict]:
    """Разобрать CSV из GSC: query, clicks, impressions, ctr, position."""
    rows: List[Dict] = []
    reader = csv.DictReader(io.StringIO(content))
    for row in reader:
        norm = {(k or "").strip().lower(): (v or "").strip() for k, v in row.items()}
        query = norm.get("query") or norm.get("запрос") or ""
        if not query:
            continue
        rows.append(
            {
                "query": query,
                "clicks": _num(norm.get("clicks")),
                "impressions": _num(norm.get("impressions")),
                "ctr": _num(norm.get("ctr", "").replace("%", "")),
                "position": _num(norm.get("position")),
            }
        )
    return rows


def _num(value: Optional[str]) -> float:
    try:
        return float(str(value).replace(",", "."))
    except (TypeError, ValueError):
        return 0.0


def scan(
    queries: List[str],
    llm: Optional[LLMClient] = None,
) -> List[Dict]:
    """Полный проход M0: regex-классификация + LLM-доразметка формата."""
    results = [classify_query(q) for q in queries]
    llm = llm or LLMClient()
    try:
        raw = llm.complete(
            prompts.render(
                prompts.G0_FORMAT,
                queries="\n".join(f"- {q}" for q in queries),
            )
        )
        refined = extract_first_json(raw)
        if isinstance(refined, list):
            by_query = {
                str(item.get("query", "")).strip().lower(): item
                for item in refined
                if isinstance(item, dict)
            }
            for res in results:
                item = by_query.get(res["query"].strip().lower())
                if not item:
                    continue
                ctype = str(
                    item.get("content_type") or item.get("тип_контента") or ""
                ).strip("[] ").upper()
                if ctype in {
                    "DEFINITION", "HOW-TO", "COMPARISON", "LIST",
                    "DEEP-DIVE", "FAQ", "COMMERCIAL", "TROUBLESHOOT",
                }:
                    res["content_type"] = ctype
                risk = str(item.get("zero_click_risk", "")).strip().upper()
                if risk in {"HIGH", "MEDIUM", "LOW"}:
                    res["zero_click_risk"] = risk
                for src, dst in (("needs_table", "needs_table"), ("needs_steps", "needs_steps")):
                    if isinstance(item.get(src), bool):
                        res[dst] = item[src]
                if item.get("intent"):
                    res["intent"] = item["intent"]
    except LLMUnavailable:
        logger.info("LLM недоступен — используем только regex-классификацию")
    except Exception as exc:
        logger.warning("G0-FORMAT доразметка не удалась: %s", exc)
    return results
