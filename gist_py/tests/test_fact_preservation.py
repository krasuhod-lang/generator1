"""Тесты сохранности фактов после M9-рерайта."""

import json

from app.llm import LLMClient
from app.modules.m9_rewriter import rewrite, verify_facts_present


class FactLossLLM(LLMClient):
    def __init__(self):
        self.model = "fake"
        self._dspy_lm = None
        self.api_base = self.api_key = ""

    @property
    def available(self):
        return True

    def complete(self, prompt, system="", temperature=0.4):
        if "атомарные фактические утверждения" in prompt:
            return json.dumps([
                "Мощность котла считают как 1 кВт на 10 м²",
                "Шум котла ночью достигает 52 дБ",
            ], ensure_ascii=False)
        if "Снизь AI-детектируемость" in prompt:
            return "Мощность котла считают как 1 кВт на 10 м². Текст стал живее.\n\n{\"changes\":[\"F2\"]}"
        if "проверяющего сохранность фактов" in prompt:
            return json.dumps({"missing": ["Шум котла ночью достигает 52 дБ"], "preserved_count": 1}, ensure_ascii=False)
        if "Перепиши только данный проблемный фрагмент" in prompt:
            return "Мощность котла считают как 1 кВт на 10 м². Текст стал живее."
        return ""


def test_verify_facts_present_deterministic_path():
    facts = ["Шум котла ночью достигает 52 дБ", "Мощность котла считают по площади"]
    result = verify_facts_present(
        facts,
        "Шум котла ночью достигает 52 дБ. Мощность котла считают по площади.",
    )
    assert result["missing"] == []
    assert result["preserved_count"] == 2


def test_rewrite_rolls_back_on_fact_loss():
    original = "Мощность котла считают как 1 кВт на 10 м². Шум котла ночью достигает 52 дБ."
    new_text, meta = rewrite(
        original,
        {"robotness_score": 80, "recommended_strategy": "light", "recommended_intensity": "medium"},
        {"short_bio": "редактор", "taboo": []},
        FactLossLLM(),
    )
    assert new_text == original
    assert meta["rejected"] == "fact_loss"
    assert "Шум котла ночью достигает 52 дБ" in meta["missing_facts"]
