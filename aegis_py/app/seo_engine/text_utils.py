"""Текстовые утилиты Модуля 2 (Anti-Hallucination / Zero-Fluff).

Чистый Python, без внешних зависимостей — используются и внутри DSPy
Assertions (drafting.py), и в критике/скорере, и в тестах.
"""

from __future__ import annotations

import difflib
import re
from typing import List

# Клише / «вода» / AI-шаблонность — запрещённые обороты (п.7 Zero-Fluff).
FLUFF_PATTERNS: List[str] = [
    r"в современном мире",
    r"актуальность темы",
    r"невозможно переоценить",
    r"следует отметить",
    r"как известно",
    r"играет важную роль",
    r"является неотъемлемой",
    r"на сегодняшний день",
    r"очевидно, что",
]


def fact_in_context(fact: str, context: str, threshold: float = 0.75) -> bool:
    """Нечёткая проверка факта в контексте. Числа проверяются точно.

    Порядок проверки:
      1. Точное подстрочное вхождение факта в контекст.
      2. Если в факте есть числа — все они обязаны присутствовать в контексте
         (иначе это выдуманная цифра → галлюцинация).
      3. Иначе — нечёткое сравнение (SequenceMatcher) по первым 2000 символам.
    """
    if not fact:
        return True
    if not context:
        return False
    if fact.lower() in context.lower():
        return True
    nums = re.findall(r"\d+(?:[.,]\d+)?", fact)
    if nums:
        ctx_nums = re.findall(r"\d+(?:[.,]\d+)?", context)
        return all(n in ctx_nums for n in nums)
    return (
        difflib.SequenceMatcher(None, fact.lower(), context.lower()[:2000]).ratio()
        >= threshold
    )


def has_fluff(text: str) -> bool:
    """True, если в тексте найден хотя бы один запрещённый клише-оборот."""
    if not text:
        return False
    return any(re.search(p, text, re.IGNORECASE) for p in FLUFF_PATTERNS)
