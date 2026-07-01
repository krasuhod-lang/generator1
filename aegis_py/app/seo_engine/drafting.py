"""Модуль 2: DSPy Assertions + Offline Compilation.

SEODraftingProgram генерирует SEO-текст СТРОГО из ground_truth_context и
проверяет результат через dspy.Assert (анти-галлюцинация) и dspy.Suggest
(Zero-Fluff).

Offline Compilation: BootstrapFewShotWithRandomSearch компилируется 1 раз
(флаг --recompile) на 50 исторических генерациях с HybridScore > 8/10 и
сохраняется в .pkl по project_id. В runtime читается только .pkl — без
API-запросов и без пересборки (требование п.12 «DSPy кэш»).

Graceful degradation: dspy — опциональная зависимость. Классы Signature /
Program и оптимизатор определяются только если dspy установлен. Утилиты
fact_in_context / has_fluff вынесены в text_utils.py и работают всегда.
"""

from __future__ import annotations

import json
import os
import pickle
from pathlib import Path
from typing import Any, Callable, List, Optional

from .text_utils import fact_in_context, has_fluff

_REASON = None
try:  # pragma: no cover - зависит от окружения
    import dspy  # type: ignore

    _DSPY_OK = True
except Exception as e:  # pragma: no cover
    dspy = None  # type: ignore
    _DSPY_OK = False
    _REASON = f"dspy_missing: {e.__class__.__name__}"


# Каталог скомпилированных программ. Переопределяется через ENV для деплоя.
COMPILED_DIR = Path(os.environ.get("SEO_COMPILED_DIR", "compiled_programs"))


def is_available() -> bool:
    return _DSPY_OK


def unavailable_reason() -> Optional[str]:
    return _REASON


if _DSPY_OK:  # pragma: no cover - требует установленного dspy-ai

    class SEODraftingSignature(dspy.Signature):
        """Генерирует SEO-текст СТРОГО из ground_truth_context. Выдумывать факты ЗАПРЕЩЕНО."""

        keyword: str = dspy.InputField(desc="Главный SEO-ключ")
        structure: str = dspy.InputField(desc="H1-H3 каркас (из StructureNode)")
        ground_truth_context: str = dspy.InputField(
            desc="Якорь достоверности — единственный источник фактов"
        )
        entities_required: str = dspy.InputField(desc="JSON-список обязательных сущностей")
        drmax_signals: str = dspy.InputField(
            desc="E-E-A-T инструкции: contentEffort, Negative Capability"
        )
        draft_text: str = dspy.OutputField(desc="Финальный SEO-текст")
        used_facts: str = dspy.OutputField(desc="JSON-список всех фактов/цифр из текста")

    class SEODraftingProgram(dspy.Module):
        def __init__(self):
            super().__init__()
            self.generate = dspy.ChainOfThought(SEODraftingSignature)

        def forward(self, keyword, structure, ground_truth_context, entities_required, drmax_signals):
            result = self.generate(
                keyword=keyword,
                structure=structure,
                ground_truth_context=ground_truth_context,
                entities_required=entities_required,
                drmax_signals=drmax_signals,
            )

            facts = json.loads(result.used_facts) if result.used_facts else []
            entities = json.loads(entities_required) if entities_required else []

            # Assert 1: все факты из текста должны быть в Ground Truth.
            for fact in facts:
                dspy.Assert(
                    fact_in_context(fact, ground_truth_context),
                    f"ГАЛЛЮЦИНАЦИЯ: '{fact}' отсутствует в ground_truth_context. Убери или замени.",
                )

            # Assert 2: обязательные сущности присутствуют.
            missing = [e for e in entities if e.lower() not in result.draft_text.lower()]
            dspy.Assert(
                len(missing) == 0,
                f"ОТСУТСТВУЮТ СУЩНОСТИ: {missing}. Добавь из ground_truth_context.",
            )

            # Suggest: нет воды.
            dspy.Suggest(
                not has_fluff(result.draft_text),
                "ВОДА: замени клише на конкретику из ground_truth_context.",
            )
            return result

else:  # dspy не установлен — заглушки, чтобы модуль всё равно импортировался.
    SEODraftingSignature = None  # type: ignore
    SEODraftingProgram = None  # type: ignore


def run_offline_compilation(
    project_id: str,
    training_examples: List[Any],
    metric_fn: Callable[..., Any],
):
    """50 исторических генераций с HybridScore > 8/10. Запускать с --recompile."""
    if not _DSPY_OK:
        raise RuntimeError(f"dspy недоступен: {_REASON}")
    from dspy.teleprompt import BootstrapFewShotWithRandomSearch  # type: ignore

    COMPILED_DIR.mkdir(parents=True, exist_ok=True)
    tp = BootstrapFewShotWithRandomSearch(
        metric=metric_fn,
        max_bootstrapped_demos=8,
        max_labeled_demos=16,
        num_candidate_programs=10,
    )
    compiled = tp.compile(SEODraftingProgram(), trainset=training_examples)
    with open(COMPILED_DIR / f"seo_{project_id}.pkl", "wb") as f:
        pickle.dump(compiled, f)
    return compiled


def load_compiled_program(project_id: str):
    """Runtime: только читает .pkl, без API запросов."""
    path = COMPILED_DIR / f"seo_{project_id}.pkl"
    if not path.exists():
        raise FileNotFoundError(
            f"Сначала запустите run_offline_compilation() для {project_id}"
        )
    with open(path, "rb") as f:
        return pickle.load(f)
