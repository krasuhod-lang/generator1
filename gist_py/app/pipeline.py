"""Оркестрация пайплайна (§15): M0 → M1 → … → M10 + цикл рерайта.

Stop criteria:
- GIST Score >= 30%
- robotness_score <= 25%
- не более 3 рерайтов
- сохранён AIO-формат
- сохранено LSI-покрытие

Если установлен dspy-ai — модули можно оборачивать в dspy.Module и
оптимизировать промпты MIPROv2 (см. optimize()); без него пайплайн работает
через прямые LLM-вызовы с теми же промптами.
"""

from __future__ import annotations

import logging
from typing import Callable, Dict, List, Optional

from . import db
from .config import CONFIG
from .llm import DSPY_AVAILABLE, LLMClient
from .modules import (
    m_minus_1_discovery,
    m0_relevance,
    m1_scraper,
    m1_5_cleansing,
    m2_noise,
    m3_gap,
    m4_architect,
    m5_persona,
    m6_generator,
    m7_redundancy,
    m8_detector,
    m9_rewriter,
    m10_formatter,
)

logger = logging.getLogger("gist_py.pipeline")

STAGES = [
    "M-1", "M0", "M1", "M1.5", "M2", "M3", "M4", "M5", "M6",
    "M7", "GIST", "M8", "M9", "M10", "DONE",
]


class GistPipeline:
    """Главный пайплайн генерации SEO-контента (GIST + LinguaForensic)."""

    def __init__(
        self,
        llm: Optional[LLMClient] = None,
        task_id: Optional[str] = None,
        on_stage: Optional[Callable[[str, Dict], None]] = None,
    ):
        self.llm = llm or LLMClient()
        self.task_id = task_id
        self.on_stage = on_stage

    def _stage(self, stage: str, metrics: Optional[Dict] = None) -> None:
        logger.info("Stage %s", stage)
        payload = dict(metrics or {})
        payload["pipeline_stage"] = stage
        db.save_task_metrics(self.task_id, payload)
        if self.on_stage:
            try:
                self.on_stage(stage, payload)
            except Exception:  # колбэк не должен ронять пайплайн
                logger.exception("on_stage callback failed")

    def run_gap_finder(
        self,
        query: str,
        target_audience: str = "",
        competitors_text: Optional[List[str]] = None,
        pages: Optional[List[Dict]] = None,
    ) -> Dict:
        """Лёгкий режим для Node-пайплайнов (M2+M3, без генерации контента).

        Принимает готовые тексты конкурентов (`competitors_text`, Stage 0
        Node-скрейпера) либо скрейпит ТОП сам (M1). Возвращает
        {top10_claims, information_delta, gist_score} — контракт
        gistClient.runGistGapFinder() на стороне Node.
        """
        result: Dict = {"query": query, "mode": "gap_finder"}

        # 1. M1 — страницы конкурентов (готовые тексты приоритетнее скрейпа)
        if pages is None:
            texts = [t for t in (competitors_text or []) if str(t).strip()]
            if texts:
                pages = [
                    {"url": f"node://competitor/{i + 1}", "body_text": str(t)}
                    for i, t in enumerate(texts)
                ]
            else:
                pages = m1_scraper.scrape_competitors(query)
        result["pages_count"] = len(pages)

        if CONFIG["cleansing_enabled"]:
            self._stage("M1.5", {"pages_count": len(pages)})
            try:
                cleansing = m1_5_cleansing.run_cleansing(pages, query, self.llm)
                pages = cleansing["pages"]
                result["core_classification"] = cleansing["core_classification"]
            except Exception as exc:
                logger.warning("M1.5 в gap-finder пропущен: %s", exc)
                result["core_classification"] = {"llm_skipped": True}

        # 2. M2 — шум top10_claims
        self._stage("M2")
        top10_claims = m2_noise.extract_noise(pages, query, self.llm)
        result["top10_claims"] = top10_claims

        # 3. M3 — information_delta
        self._stage("M3", {"top10_claims_json": top10_claims})
        gaps = m3_gap.find_gaps(query, target_audience, top10_claims, self.llm)
        result["information_delta"] = gaps["information_delta"]
        result["gap_reasoning"] = gaps["gap_reasoning"]

        # GIST Score считается по готовой статье (Node Quality Gate);
        # на этапе gap-finder статьи ещё нет.
        result["gist_score"] = None
        self._stage("DONE", {"information_delta_json": gaps["information_delta"]})
        return result

    def run_topic_discovery(
        self,
        query: str,
        trends_data=None,
        reddit_insights=None,
        paa_questions=None,
    ) -> Dict:
        """Запустить M-1 Topic Discovery как отдельный fail-open этап."""
        self._stage("M-1")
        return m_minus_1_discovery.discover_topic(
            query,
            trends_data=trends_data,
            reddit_insights=reddit_insights,
            paa_questions=paa_questions,
            llm=self.llm,
        )

    def run(
        self,
        query: str,
        target_audience: str = "",
        domain: str = "SEO-статья",
        pages: Optional[List[Dict]] = None,
    ) -> Dict:
        """Полный проход. `pages` можно передать заранее (пропустит M1)."""
        result: Dict = {"query": query}

        # 1. M0 — классификация запроса
        self._stage("M0")
        relevance = m0_relevance.scan([query], self.llm)[0]
        result["relevance"] = relevance
        self._stage(
            "M1",
            {
                "aio_trigger_group": relevance["trigger_group"],
                "aio_trigger_rate": relevance["trigger_rate"],
                "content_format": relevance["content_type"],
                "zero_click_risk": relevance["zero_click_risk"],
            },
        )

        # 2. M1 — конкуренты
        if pages is None:
            pages = m1_scraper.scrape_competitors(query)
        result["pages_count"] = len(pages)

        if CONFIG["cleansing_enabled"]:
            self._stage("M1.5", {"pages_count": len(pages)})
            try:
                cleansing = m1_5_cleansing.run_cleansing(pages, query, self.llm)
                pages = cleansing["pages"]
                result["core_classification"] = cleansing["core_classification"]
            except Exception as exc:
                logger.warning("M1.5 пропущен: %s", exc)
                result["core_classification"] = {"llm_skipped": True}

        # 3. M2 — шум top10_claims
        self._stage("M2")
        top10_claims = m2_noise.extract_noise(pages, query, self.llm)
        result["top10_claims"] = top10_claims

        # 4. M3 — information_delta
        self._stage("M3", {"top10_claims_json": top10_claims})
        gaps = m3_gap.find_gaps(query, target_audience, top10_claims, self.llm)
        delta = gaps["information_delta"]
        result["information_delta"] = delta

        # 5. M4 — Entity Footprint + структура
        entity_footprint = m4_architect.build_entity_footprint(
            query,
            target_audience,
            top10_claims,
            delta,
            self.llm,
            is_listicle=relevance["content_type"] == "LIST",
        )
        result["entity_footprint"] = entity_footprint
        self._stage(
            "M4",
            {
                "information_delta_json": delta,
                "entity_count": len(entity_footprint.get("entities", [])),
            },
        )
        outline = m4_architect.build_outline(
            query, target_audience, relevance["content_type"],
            top10_claims, delta, self.llm, entity_footprint=entity_footprint,
        )
        result["outline"] = outline

        # 6. M5 — персона
        self._stage("M5", {"outline_json": outline})
        persona = m5_persona.generate_persona(
            query, target_audience, relevance["content_type"], self.llm
        )
        result["persona"] = persona

        # 7. M6 — генерация секций
        self._stage("M6", {"persona_json": persona})
        article = m6_generator.generate_article(
            query, outline, persona, delta, top10_claims, self.llm
        )

        # 8. M7 — избыточность
        self._stage("M7")
        redundancy = m7_redundancy.check_redundancy(article, top10_claims, self.llm)
        result["redundancy_report"] = redundancy

        # 9. GIST Score
        self._stage("GIST", {"redundancy_report_json": redundancy})
        score = m3_gap.gist_score(article, delta)
        result["gist_score"] = score
        if score < CONFIG["gist_score_min"]:
            logger.warning(
                "GIST Score %.1f%% ниже минимума %.0f%%",
                score, CONFIG["gist_score_min"],
            )

        # 10–11. M8 LinguaForensic + M9 цикл рерайта (до 3 раз)
        self._stage("M8", {"gist_score": score})
        article, detection, iterations = self._detect_and_rewrite(
            article, persona, domain
        )
        result["detection_report"] = detection
        result["rewrite_iterations"] = iterations

        # 12. M10 — SEO-форматирование
        self._stage(
            "M10",
            {
                "robotness_score": detection.get("robotness_score"),
                "robotness_ci": str(detection.get("confidence_interval") or ""),
                "llm_family": detection.get("llm_family"),
                "knockoff_s": detection.get("knockoff_s"),
                "top_ai_categories": detection.get("top_contributing_categories"),
                "full_detection_report": detection.get("raw"),
                "fluency_metrics_json": {
                    "fluency_issues": detection.get("fluency_issues"),
                    "structural_markers_found": detection.get(
                        "structural_markers_found"
                    ),
                },
                "rewrite_iterations": iterations,
            },
        )
        formatted = m10_formatter.format_article(
            article, outline, relevance["content_type"], top10_claims, self.llm
        )
        result.update(
            {
                "content": formatted["content"],
                "meta": formatted["meta"],
                "schema": formatted["schema"],
                "multimodal": formatted["multimodal"],
                "lsi_coverage_pct": formatted["lsi_coverage_pct"],
                "aio_snippets_count": formatted["aio_snippets_count"],
                "aio_issues": formatted["aio_issues"],
            }
        )

        # 13. Финальные метрики в БД
        result["stop_criteria"] = {
            "gist_score_ok": score >= CONFIG["gist_score_min"],
            "robotness_ok": float(detection.get("robotness_score") or 100)
            <= CONFIG["robotness_stop"],
            "rewrites_within_limit": iterations
            <= CONFIG["max_rewrite_iterations"],
            "aio_format_ok": not formatted["aio_issues"],
        }
        self._stage(
            "DONE",
            {
                "status": "done",
                "final_content": formatted["content"],
                "meta_json": formatted["meta"],
                "lsi_coverage_pct": formatted["lsi_coverage_pct"],
                "aio_snippets_count": formatted["aio_snippets_count"],
                "schema_type": formatted["schema"].get("@type"),
            },
        )
        return result

    def _detect_and_rewrite(self, article: str, persona: Dict, domain: str):
        """M8 + M9: детекция и цикл рерайта до max_rewrite_iterations."""
        detection = m8_detector.detect(article, domain, self.llm)
        iterations = 0
        while (
            float(detection.get("robotness_score") or 0)
            > CONFIG["robotness_stop"]
            and iterations < CONFIG["max_rewrite_iterations"]
        ):
            strategy = m8_detector.strategy_for_score(
                float(detection["robotness_score"])
            )
            detection["recommended_strategy"] = (
                detection.get("recommended_strategy") or strategy
            )
            self._stage("M9", {"robotness_score": detection["robotness_score"]})
            article, _changes = m9_rewriter.rewrite(
                article, detection, persona, self.llm
            )
            iterations += 1
            detection = m8_detector.detect(article, domain, self.llm)
        return article, detection, iterations


def optimize(trainset=None):  # pragma: no cover - требует dspy-ai + датасет
    """MIPROv2-оптимизация промптов (Sprint 4). Требует dspy-ai и trainset."""
    if not DSPY_AVAILABLE:
        raise RuntimeError("dspy-ai не установлен — MIPROv2 недоступен")
    import dspy  # type: ignore

    return dspy.MIPROv2(metric=lambda ex, pred, trace=None: 1.0)
