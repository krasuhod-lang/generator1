"""Модуль 8: Конфигурация LLM.

Разделение моделей (Cost Efficiency):
  • DeepSeek v4 — аналитика/структура/критика (дёшево, temperature=0.1).
  • Gemini 3.1 Pro — только финальный райтинг (дорого, temperature=0.7).

Graceful degradation: dspy — опциональная зависимость. Методы get_*_lm()
бросают понятную ошибку, если dspy не установлен; is_available() позволяет
нодам заранее это проверить.
"""

from __future__ import annotations

import os
from typing import Optional

_REASON = None
try:  # pragma: no cover - зависит от окружения
    import dspy  # type: ignore

    _DSPY_OK = True
except Exception as e:  # pragma: no cover
    dspy = None  # type: ignore
    _DSPY_OK = False
    _REASON = f"dspy_missing: {e.__class__.__name__}"


def is_available() -> bool:
    return _DSPY_OK


def unavailable_reason() -> Optional[str]:
    return _REASON


class LLMConfig:
    """DeepSeek — аналитика/критика (дёшево). Gemini — только райтинг (дорого)."""

    @staticmethod
    def _require_dspy() -> None:
        if not _DSPY_OK:
            raise RuntimeError(f"dspy недоступен: {_REASON}")

    @staticmethod
    def get_deepseek_lm():
        LLMConfig._require_dspy()
        return dspy.LM(
            model="deepseek/deepseek-chat",
            api_key=os.environ["DEEPSEEK_API_KEY"],
            max_tokens=4096,
            temperature=0.1,
            cache=True,
        )

    @staticmethod
    def get_gemini_lm():
        LLMConfig._require_dspy()
        return dspy.LM(
            model="google/gemini-2.5-pro-preview",
            api_key=os.environ["GOOGLE_API_KEY"],
            max_tokens=8192,
            temperature=0.7,
            cache=False,
        )

    @staticmethod
    def configure_for_node(node_type: str) -> None:
        """Переключить активную LLM в зависимости от типа ноды."""
        LLMConfig._require_dspy()
        if node_type in ("entity_research", "structure", "critic"):
            dspy.configure(lm=LLMConfig.get_deepseek_lm())
        elif node_type == "drafting":
            dspy.configure(lm=LLMConfig.get_gemini_lm())
