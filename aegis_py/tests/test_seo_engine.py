"""Тесты SEO Content Engine v2.0 (Модули 1–4).

Работают без heavy-зависимостей (langgraph / dspy-ai / rank-bm25) — проверяют
чистую логику скоринга, утилиты, маршрутизацию и оффлайн-прогон пайплайна с
внедрёнными колбэками.
"""

from aegis_py.app import seo_engine as se
from aegis_py.app.seo_engine import hybrid_scorer, llm_config, pipeline
from aegis_py.app.seo_engine.models import (
    HybridScoreResult,
    PipelineStatus,
    ProjectContext,
    SEOPipelineState,
)


# ── Модуль 1: HybridScorer ───────────────────────────────────────────
def test_yandex_stuffing_penalty_applied():
    scorer = se.HybridScorer()
    # Плотность ключа заведомо > 3% → штраф -2.0.
    text = "ключ " * 50
    y = scorer.score_yandex("ключ", ["термин"], text, [text])
    assert y.stuffing_penalty == -2.0
    assert y.keyword_density > 0.03


def test_yandex_lsi_overuse_penalty():
    scorer = se.HybridScorer()
    lsi = [f"t{i}" for i in range(10)]
    text = " ".join(lsi)  # 100% покрытие LSI → overuse penalty < 0
    y = scorer.score_yandex("ключ", lsi, text, [text])
    assert y.lsi_coverage == 1.0
    assert y.lsi_overuse_penalty < 0


def test_google_information_gain_and_coverage():
    scorer = se.HybridScorer()
    g = scorer.score_google(
        entities_top20=["A", "B", "C"],
        entities_generated=["a", "b", "c"],
        competitor_frequencies={"A": 0.1, "B": 0.2, "C": 0.9},
        entities_required=["A", "B"],
    )
    assert g.coverage_ratio == 1.0
    # A и B редкие (<0.30) и присутствуют → 2 уникальные сущности.
    assert g.unique_entities_found == 2
    assert 0.0 < g.information_gain_score <= 1.0


def test_hybrid_weighting_and_pass_threshold():
    scorer = se.HybridScorer()
    corpus = ["слон живёт в африке", "африканский слон крупный"]
    res = scorer.score(
        project_id="p1",
        keyword="слон",
        lsi_terms=["африка", "крупный"],
        text="африканский слон живёт в африке и он крупный",
        corpus=corpus,
        entities_top20=["Африка", "Саванна", "Хобот"],
        entities_generated=["африка", "саванна", "хобот"],
        competitor_frequencies={"Африка": 0.1, "Саванна": 0.1, "Хобот": 0.1},
        entities_required=["Африка"],
    )
    assert isinstance(res, HybridScoreResult)
    expected = round(0.45 * res.yandex_score.final_score + 0.55 * res.google_score.final_score, 2)
    assert res.hybrid_final == expected
    assert res.passed == (res.hybrid_final >= 8.0)


def test_fallback_bm25_matches_interface():
    # Даже без rank-bm25 fallback возвращает по одному скору на документ.
    bm25 = hybrid_scorer._build_bm25([["a", "b"], ["b", "c"]])
    scores = bm25.get_scores(["b"])
    assert len(scores) == 2


# ── Модуль 2: утилиты ────────────────────────────────────────────────
def test_fact_in_context_exact_and_numeric():
    assert se.fact_in_context("цена 500 рублей", "товар стоит 500 рублей")
    # Выдуманная цифра отсутствует в контексте.
    assert not se.fact_in_context("вес 999 кг", "вес изделия 12 кг")


def test_has_fluff_detects_cliches():
    assert se.has_fluff("В современном мире это важно")
    assert not se.has_fluff("Конкретный факт: батарея 5000 мАч")


# ── Модуль 4: DrMax сигналы ──────────────────────────────────────────
def test_build_drmax_signals_blocks_and_commercial():
    base = se.build_drmax_signals("телефон")
    assert "Negative Capability" in base
    assert "Zero-Fluff" in base
    assert "Коммерческие факторы" not in base
    commercial = se.build_drmax_signals("телефон", is_commercial=True)
    assert "Коммерческие факторы" in commercial


# ── Модуль 3: маршрутизация + пайплайн ───────────────────────────────
def test_routing_finalize_on_pass():
    state = SEOPipelineState(project_id="p", keyword="k")
    state.hybrid_score = HybridScoreResult(
        project_id="p", keyword="k",
        yandex_score=se.YandexLayerScore(
            bm25_score=9, lsi_coverage=0.7, keyword_density=0.01,
            stuffing_penalty=0, lsi_overuse_penalty=0, final_score=9),
        google_score=se.GoogleLayerScore(
            entities_top20=[], entities_generated=[], coverage_ratio=1,
            unique_entities_found=3, information_gain_score=1, final_score=9),
        hybrid_final=9.0, passed=True)
    assert pipeline.routing_function(state) == "finalize"


def test_routing_retry_then_fallback():
    state = SEOPipelineState(project_id="p", keyword="k")
    state.hybrid_score = HybridScoreResult(
        project_id="p", keyword="k",
        yandex_score=se.YandexLayerScore(
            bm25_score=1, lsi_coverage=0.1, keyword_density=0.01,
            stuffing_penalty=0, lsi_overuse_penalty=0, final_score=1),
        google_score=se.GoogleLayerScore(
            entities_top20=[], entities_generated=[], coverage_ratio=0,
            unique_entities_found=0, information_gain_score=0, final_score=1),
        hybrid_final=1.0, passed=False)
    state.retry_count = 1
    assert pipeline.routing_function(state) == "retry"
    state.retry_count = 2
    assert pipeline.routing_function(state) == "fallback"


class _PassingScorer:
    """Стаб скорера (DI): всегда возвращает проходной балл — для проверки
    finalize-ветки маршрутизации независимо от нормализации BM25."""

    def score(self, project_id, keyword, *args, **kwargs):
        return HybridScoreResult(
            project_id=project_id, keyword=keyword,
            yandex_score=se.YandexLayerScore(
                bm25_score=9, lsi_coverage=0.7, keyword_density=0.01,
                stuffing_penalty=0, lsi_overuse_penalty=0, final_score=9),
            google_score=se.GoogleLayerScore(
                entities_top20=[], entities_generated=[], coverage_ratio=1,
                unique_entities_found=3, information_gain_score=1, final_score=9),
            hybrid_final=9.0, passed=True)


def _passing_deps():
    """Deps, при которых критик выставляет проходной балл (finalize)."""
    def entity_research(state):
        return {
            "ground_truth": "Факт: экран 6.5 дюймов. Батарея 5000 мАч.",
            "entities": ["Экран", "Батарея"],
            "unique_entities": ["Экран"],
            "frequencies": {"Экран": 0.1, "Батарея": 0.1},
        }

    def draft(state, signals):
        return {
            "draft_text": "Экран 6.5 дюймов. Батарея 5000 мАч. Экран Батарея.",
            "used_facts": ["экран 6.5 дюймов"],
        }

    return pipeline.PipelineDeps(
        entity_research=entity_research,
        draft=draft,
        extract_lsi_terms=lambda sem: ["дюймов", "мАч"],
        extract_entities=lambda text: ["Экран", "Батарея"],
        scorer=_PassingScorer(),
    )


def test_run_pipeline_finalize_path():
    deps = _passing_deps()
    result = se.run_seo_pipeline("proj-A", "смартфон", deps=deps)
    assert isinstance(result, SEOPipelineState)
    assert result.status == PipelineStatus.DONE
    assert result.needs_human_review is False
    assert result.final_text
    assert result.hybrid_score.passed is True
    assert result.trace_id  # trace_id сквозной


def test_run_pipeline_fallback_no_crash():
    # Дефолтные заглушки дают низкий скор → fallback без краша, retry исчерпан.
    result = se.run_seo_pipeline("proj-B", "ключ", deps=pipeline.PipelineDeps())
    assert result.status == PipelineStatus.FALLBACK
    assert result.needs_human_review is True
    assert result.retry_count == pipeline.MAX_RETRIES
    assert result.final_text is not None


# ── Модуль 9: мультипроектность ──────────────────────────────────────
def test_project_context_defaults_and_bounds():
    ctx = ProjectContext(project_id="p1")
    assert ctx.hybrid_score_weights == {"yandex": 0.45, "google": 0.55}
    assert 0.60 <= ctx.lsi_coverage_target <= 0.75


# ── Graceful degradation ─────────────────────────────────────────────
def test_llm_config_reports_availability():
    # В тестовом окружении dspy не установлен → недоступен, но без исключения.
    assert isinstance(llm_config.is_available(), bool)
    if not llm_config.is_available():
        import pytest

        with pytest.raises(RuntimeError):
            llm_config.LLMConfig.configure_for_node("critic")


def test_pipeline_is_available_bool():
    assert isinstance(pipeline.is_available(), bool)


# ── FastAPI endpoints ────────────────────────────────────────────────
def test_seo_endpoints():
    from fastapi.testclient import TestClient

    from aegis_py.app.main import app

    client = TestClient(app)

    health = client.get("/health").json()
    assert "seo_engine" in health["subsystems"]

    score = client.post(
        "/seo/score",
        json={"project_id": "p", "keyword": "слон", "text": "слон живёт", "lsi_terms": ["живёт"]},
    ).json()
    assert "hybrid_final" in score and "passed" in score

    drmax = client.post("/seo/drmax", json={"keyword": "телефон", "is_commercial": True}).json()
    assert "Коммерческие факторы" in drmax["signals"]

    run = client.post("/seo/run", json={"project_id": "p", "keyword": "к"}).json()
    assert run["status"] in ("done", "fallback")
    assert "trace_id" in run
