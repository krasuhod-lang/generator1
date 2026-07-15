"""Интеграционный тест оркестрации: полный проход M0–M10 на фейковом LLM."""

import json

from app.llm import LLMClient
from app.pipeline import GistPipeline


class FakeLLM(LLMClient):
    """Фейковый LLM: отвечает по типу промпта, считает вызовы детектора."""

    def __init__(self, robotness_scores=None):
        # Не вызываем super().__init__ — не нужен ни dspy, ни HTTP
        self.model = "fake"
        self._dspy_lm = None
        self.api_base = self.api_key = ""
        self.detect_calls = 0
        self.robotness_scores = robotness_scores or [10.0]

    @property
    def available(self):
        return True

    def complete(self, prompt, system="", temperature=0.4):
        if "Режим 2. Полная детекция" in prompt:
            score = self.robotness_scores[
                min(self.detect_calls, len(self.robotness_scores) - 1)
            ]
            self.detect_calls += 1
            return json.dumps(
                {
                    "robotness_score": score,
                    "confidence_interval": [score - 5, score + 5],
                    "verdict": "ai" if score > 25 else "human",
                    "llm_family": "gpt",
                    "top_contributing_categories": ["clichés"],
                    "structural_markers_found": ["tricolon"],
                    "fluency_issues": ["passive"],
                    "knockoff": {"s_statistic": 0.42},
                    "recommended_strategy": "light",
                    "recommended_intensity": "medium",
                }
            )
        if "Снизь AI-детектируемость" in prompt:
            return (
                "Датчик мощности котла показал расход на площади 1 кВт на 10 м². "
                * 12
                + '\n\n{"changes": ["F2", "F6"]}'
            )
        if "SEO-аналитик с опытом оптимизации под AI-Overview" in prompt:
            return json.dumps(
                [{"query": "как выбрать газовый котёл", "content_type": "HOW-TO",
                  "zero_click_risk": "HIGH", "needs_table": False,
                  "needs_steps": True}]
            )
        if "выпиши из него ВСЕ уникальные факты" in prompt:
            return "1. Мощность котла считают как 1 кВт на 10 м²\n2. Двухконтурные котлы греют воду"
        if "СЕМАНТИЧЕСКИЕ ПРОБЕЛЫ" in prompt:
            return "1. Никто не пишет про шум котла в 52 дБ ночью\n2. Нет данных о расходе газа зимой"
        if "информационный архитектор" in prompt:
            return json.dumps(
                {
                    "h1": "Как выбрать газовый котёл",
                    "meta_title": "Выбор газового котла",
                    "meta_description": "Гид по выбору котла",
                    "schema_type": "HowTo",
                    "sections": [
                        {"h2": "Как рассчитать мощность?", "type": "TEXT",
                         "is_expert": False, "brief": "база", "word_count": 120},
                        {"h2": "Почему котёл шумит ночью?", "type": "EXPERT",
                         "is_expert": True, "brief": "дельта", "word_count": 120},
                    ],
                }
            )
        if "директор по контенту" in prompt.lower():
            return json.dumps(
                {"role": "инженер-теплотехник", "short_bio": "инженер-теплотехник",
                 "taboo": ["канцелярит"]}
            )
        if "семантическом аудите" in prompt:
            return json.dumps([{"block": "x", "redundancy": "LOW"}])
        if "AIO-формату" in prompt:
            return prompt.split("Статья:")[-1].strip()
        # генерация интро/секций
        return (
            "Расход газа зимой достигает 2,5 м³/час при шуме котла 52 дБ ночью. "
            "Мощность считают как 1 кВт на 10 м². Это проверено замерами."
        )


def test_gap_finder_mode_with_node_texts():
    """Режим Gap Finder (Node gistClient): M2+M3 без генерации контента."""
    llm = FakeLLM()
    pipe = GistPipeline(llm=llm)
    result = pipe.run_gap_finder(
        "как выбрать газовый котёл",
        competitors_text=["текст конкурента " * 100, "  ", "второй текст " * 100],
    )
    assert result["mode"] == "gap_finder"
    assert result["pages_count"] == 2  # пустые тексты отброшены
    assert len(result["top10_claims"]) == 2
    assert len(result["information_delta"]) == 2
    assert result["gist_score"] is None  # статьи ещё нет — score считает Node Quality Gate
    assert "content" not in result


def test_full_pipeline_accept_first_pass():
    llm = FakeLLM(robotness_scores=[10.0])
    pipe = GistPipeline(llm=llm)
    pages = [{"url": "https://ex.ru", "body_text": "текст " * 400, "word_count": 400}]
    result = pipe.run("как выбрать газовый котёл", pages=pages)
    assert result["relevance"]["content_type"] == "HOW-TO"
    assert len(result["top10_claims"]) == 2
    assert len(result["information_delta"]) == 2
    assert result["rewrite_iterations"] == 0
    assert result["detection_report"]["robotness_score"] == 10.0
    assert result["content"].startswith("# Как выбрать газовый котёл")
    assert result["meta"]["title"] == "Выбор газового котла"
    assert result["schema"]["@type"] == "HowTo"
    assert result["stop_criteria"]["robotness_ok"] is True
    assert "gist_score" in result


def test_rewrite_loop_stops_at_three_iterations():
    # robotness всегда > 25 → должно быть ровно 3 рерайта и 4 детекции
    llm = FakeLLM(robotness_scores=[80.0, 60.0, 40.0, 30.0])
    pipe = GistPipeline(llm=llm)
    pages = [{"url": "https://ex.ru", "body_text": "текст " * 400, "word_count": 400}]
    result = pipe.run("как выбрать газовый котёл", pages=pages)
    assert result["rewrite_iterations"] == 3
    assert llm.detect_calls == 4
    assert result["stop_criteria"]["rewrites_within_limit"] is True
    assert result["stop_criteria"]["robotness_ok"] is False


def test_rewrite_loop_exits_when_score_drops():
    llm = FakeLLM(robotness_scores=[50.0, 15.0])
    pipe = GistPipeline(llm=llm)
    pages = [{"url": "https://ex.ru", "body_text": "текст " * 400, "word_count": 400}]
    result = pipe.run("как выбрать газовый котёл", pages=pages)
    assert result["rewrite_iterations"] == 1
    assert result["detection_report"]["robotness_score"] == 15.0


def test_stage_callback_reaches_done():
    llm = FakeLLM()
    stages = []
    pipe = GistPipeline(llm=llm, on_stage=lambda s, m: stages.append(s))
    pages = [{"url": "https://ex.ru", "body_text": "текст " * 400, "word_count": 400}]
    pipe.run("как выбрать газовый котёл", pages=pages)
    assert stages[0] == "M0"
    assert stages[-1] == "DONE"
    assert "GIST" in stages and "M8" in stages
