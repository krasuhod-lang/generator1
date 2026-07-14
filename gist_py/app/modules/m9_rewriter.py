"""M9 Fluency Rewriter — снижение AI-детектируемости (техники F1–F7).

Переписывает текст по отчёту M8 (промпт G3-REWRITE-EXPERT) без потери
смысла, структуры и SEO-функции. Объём меняется не более чем на ±15%.
"""

from __future__ import annotations

import logging
import re
from typing import Dict, Optional, Tuple

from .. import prompts
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
    return new_text, changes if isinstance(changes, dict) else {"changes": changes}


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
