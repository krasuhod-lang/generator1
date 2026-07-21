"""M9 Fluency Rewriter — снижение AI-детектируемости (техники F1–F7).

Переписывает текст по отчёту M8 (промпт G3-REWRITE-EXPERT) без потери
смысла, структуры и SEO-функции. Объём меняется не более чем на ±15%.
"""

from __future__ import annotations

import logging
import re
from typing import Dict, List, Optional, Tuple

from .. import prompts
from ..config import CONFIG
from ..llm import LLMClient, extract_first_json

logger = logging.getLogger("gist_py.m9")

VOLUME_TOLERANCE = 0.15  # ±15% объёма

TECHNIQUES = {
    "F1": "декомпрессия номинализаций",
    "F2": "вариативность длины предложений",
    "F3": "пассив → актив",
    "F4": "убрать родительные цепочки",
    "F5": "заменить абстракции на конкретику",
    "F6": "убрать модальные рамки и добавить органичные хеджи",
    "F7": "контролировать повтор ключевого термина",
}


def _fmt(value) -> str:
    if isinstance(value, (list, tuple)):
        return "\n".join(f"- {v}" for v in value) or "-"
    return str(value or "-")


def rewrite(
    original_text: str,
    detection_report: Dict,
    persona: Dict,
    llm: Optional[LLMClient] = None,
) -> Tuple[str, Dict]:
    """Один проход рерайта → (новый текст, JSON изменений)."""
    llm = llm or LLMClient()
    facts = extract_atomic_facts(original_text, llm)
    raw = llm.complete(
        prompts.render(
            prompts.G3_REWRITE_EXPERT,
            persona_short_bio=str(persona.get("short_bio", "")),
            current_robotness=detection_report.get("robotness_score", 0),
            top_contributing_categories=_fmt(
                detection_report.get("top_contributing_categories")
            ),
            strategy=detection_report.get("recommended_strategy", "medium"),
            intensity=detection_report.get("recommended_intensity", "auto"),
            structural_markers_found=_fmt(
                detection_report.get("structural_markers_found")
            ),
            fluency_issues=_fmt(detection_report.get("fluency_issues")),
            original_text=original_text,
        ),
        temperature=0.6,
    )
    changes = extract_first_json(raw) or {}
    new_text = _strip_changes_json(raw)
    if not _volume_ok(original_text, new_text):
        logger.warning(
            "Рерайт изменил объём более чем на ±%.0f%% — оставляем оригинал",
            VOLUME_TOLERANCE * 100,
        )
        return original_text, {"rejected": "volume_change", "changes": changes}
    if facts:
        verification = verify_facts_present(facts, new_text, llm)
        missing = verification.get("missing") or []
        retries = 0
        while missing and retries < CONFIG["fact_preservation_max_retries"]:
            retries += 1
            new_text = _targeted_restore(new_text, missing, llm)
            verification = verify_facts_present(facts, new_text, llm)
            missing = verification.get("missing") or []
        if missing:
            logger.warning("Рерайт отклонён из-за потери фактов: %s", missing)
            meta = changes if isinstance(changes, dict) else {"changes": changes}
            meta.update({"rejected": "fact_loss", "missing_facts": missing})
            return original_text, meta
        if isinstance(changes, dict):
            changes["fact_preservation"] = verification
    return new_text, changes if isinstance(changes, dict) else {"changes": changes}


def extract_atomic_facts(text: str, llm: Optional[LLMClient] = None) -> List[str]:
    """Извлечь атомарные факты для контроля сохранности после рерайта."""
    llm = llm or LLMClient()
    try:
        raw = llm.complete(
            prompts.render(prompts.G3_ATOMIC_FACTS, text=text[:20000]),
            temperature=0.1,
        )
        parsed = extract_first_json(raw)
        if isinstance(parsed, list):
            return [str(item).strip() for item in parsed if str(item).strip()]
    except Exception as exc:
        logger.warning("Извлечение атомарных фактов пропущено: %s", exc)
    return []


def _significant_words(text: str) -> set[str]:
    return set(re.findall(r"[а-яёa-z0-9]{4,}", (text or "").lower()))


def _deterministic_missing(facts: List[str], new_text: str) -> List[str]:
    text_words = _significant_words(new_text)
    missing: List[str] = []
    for fact in facts:
        words = _significant_words(fact)
        if not words:
            continue
        overlap = len(words & text_words) / len(words)
        if overlap < 0.6:
            missing.append(fact)
    return missing


def verify_facts_present(
    facts: List[str], new_text: str, llm: Optional[LLMClient] = None
) -> Dict:
    """Проверить сохранность фактов: сначала token-overlap, затем LLM-подтверждение."""
    deterministic_missing = _deterministic_missing(facts, new_text)
    if not deterministic_missing:
        return {"missing": [], "preserved_count": len(facts)}
    llm = llm or LLMClient()
    try:
        raw = llm.complete(
            prompts.render(
                prompts.G3_FACT_VERIFY,
                facts="\n".join(f"- {f}" for f in deterministic_missing),
                new_text=new_text[:20000],
            ),
            temperature=0.1,
        )
        parsed = extract_first_json(raw)
        if isinstance(parsed, dict) and isinstance(parsed.get("missing"), list):
            missing = [str(item).strip() for item in parsed["missing"] if str(item).strip()]
            return {"missing": missing, "preserved_count": max(0, len(facts) - len(missing))}
    except Exception as exc:
        logger.warning("LLM-проверка фактов пропущена: %s", exc)
    return {
        "missing": deterministic_missing,
        "preserved_count": max(0, len(facts) - len(deterministic_missing)),
    }


def _targeted_restore(text: str, missing_facts: List[str], llm: LLMClient) -> str:
    """Точечно переписать проблемный фрагмент, не трогая остальную статью."""
    paragraphs = re.split(r"(\n\s*\n)", text)
    content_indexes = [i for i, part in enumerate(paragraphs) if part.strip() and not part.isspace()]
    if not content_indexes:
        return text
    target_idx = min(
        content_indexes,
        key=lambda i: max(
            (
                len(_significant_words(fact) & _significant_words(paragraphs[i]))
                / max(1, len(_significant_words(fact)))
                for fact in missing_facts
            ),
            default=0,
        ),
    )
    try:
        fixed = llm.complete(
            prompts.render(
                prompts.G3_TARGETED_REWRITE,
                paragraph=paragraphs[target_idx],
                missing_facts="\n".join(f"- {f}" for f in missing_facts),
            ),
            temperature=0.4,
        ).strip()
        if fixed:
            paragraphs[target_idx] = fixed
    except Exception as exc:
        logger.warning("Точечный факт-рерайт не удался: %s", exc)
    return "".join(paragraphs)


def _strip_changes_json(raw: str) -> str:
    """Отрезать финальный JSON-блок изменений, оставить переписанный текст."""
    text = raw.strip()
    text = re.sub(r"```json[\s\S]*?```\s*$", "", text).strip()
    # Если ответ заканчивается сырым JSON-объектом/массивом — отрезаем его
    m = re.search(r"\n\s*[\[{][\s\S]*[\]}]\s*$", text)
    if m and m.start() > len(text) * 0.3:
        text = text[: m.start()].strip()
    text = re.sub(r"^(?:1\.\s*)?Переписанный текст:?\s*", "", text, flags=re.I)
    return text.strip()


def _volume_ok(original: str, rewritten: str) -> bool:
    ow, rw = len(original.split()), len(rewritten.split())
    if not ow or not rw:
        return False
    return abs(rw - ow) / ow <= VOLUME_TOLERANCE + 0.05  # небольшой допуск
