"""Модуль 1: HybridScorer — гибридный скоринг Яндекс + Google.

Cross-Engine SEO:
  • Яндекс-слой: BM25 + LSI coverage + анти-переспам (stuffing / LSI overuse).
  • Google-слой: Entity coverage + Information Gain (уникальные сущности).

Гибрид: 0.45*yandex + 0.55*google, порог прохождения 8.0/10.

Graceful degradation: rank-bm25 — опциональная зависимость. Если пакет не
установлен, используется встроенная реализация BM25 (Okapi), чтобы скорер
оставался чистой функцией без внешних сервисов и работал в тестах.
"""

from __future__ import annotations

import math
import re
from typing import Dict, List, Sequence

from .models import GoogleLayerScore, HybridScoreResult, YandexLayerScore

_REASON = None
try:  # pragma: no cover - зависит от окружения
    from rank_bm25 import BM25Okapi  # type: ignore

    _RANK_BM25_OK = True
except Exception as e:  # pragma: no cover
    BM25Okapi = None  # type: ignore
    _RANK_BM25_OK = False
    _REASON = f"rank_bm25_missing: {e.__class__.__name__}"


def rank_bm25_available() -> bool:
    """True, если установлен внешний rank-bm25 (иначе — внутренний fallback)."""
    return _RANK_BM25_OK


class _FallbackBM25:
    """Минимальная реализация Okapi BM25 (Робертсон) — на случай отсутствия
    rank-bm25. Совпадает по интерфейсу get_scores(query_tokens) -> list[float]."""

    def __init__(self, corpus: Sequence[Sequence[str]], k1: float = 1.5, b: float = 0.75):
        self.k1 = k1
        self.b = b
        self.corpus = [list(doc) for doc in corpus]
        self.doc_len = [len(doc) for doc in self.corpus]
        self.avgdl = (sum(self.doc_len) / len(self.doc_len)) if self.doc_len else 0.0
        self.doc_freqs: List[Dict[str, int]] = []
        df: Dict[str, int] = {}
        for doc in self.corpus:
            freqs: Dict[str, int] = {}
            for term in doc:
                freqs[term] = freqs.get(term, 0) + 1
            self.doc_freqs.append(freqs)
            for term in freqs:
                df[term] = df.get(term, 0) + 1
        n = len(self.corpus)
        # idf по формуле Робертсона (со сглаживанием +0.5).
        self.idf: Dict[str, float] = {
            term: math.log((n - freq + 0.5) / (freq + 0.5) + 1.0) for term, freq in df.items()
        }

    def get_scores(self, query: Sequence[str]) -> List[float]:
        scores: List[float] = []
        for idx, doc in enumerate(self.corpus):
            freqs = self.doc_freqs[idx]
            dl = self.doc_len[idx] or 1
            score = 0.0
            for term in query:
                if term not in freqs:
                    continue
                idf = self.idf.get(term, 0.0)
                tf = freqs[term]
                denom = tf + self.k1 * (1 - self.b + self.b * dl / (self.avgdl or 1))
                score += idf * (tf * (self.k1 + 1)) / (denom or 1)
            scores.append(score)
        return scores


def _build_bm25(corpus_tokens: Sequence[Sequence[str]]):
    if _RANK_BM25_OK:
        return BM25Okapi(list(corpus_tokens))
    return _FallbackBM25(corpus_tokens)


class HybridScorer:
    """Гибридный скорер. Без состояния — можно переиспользовать между ключами."""

    def score_yandex(
        self,
        keyword: str,
        lsi_terms: List[str],
        text: str,
        corpus: List[str],
    ) -> YandexLayerScore:
        # BM25: стандартная формула Робертсона, нормализация к 0–10.
        safe_corpus = corpus if corpus else [text]
        bm25 = _build_bm25([d.lower().split() for d in safe_corpus])
        raw_scores = bm25.get_scores(keyword.lower().split())
        max_raw = max(raw_scores) if raw_scores else 0.0
        bm25_score = min(float(max_raw) / 5.0, 10.0)

        # LSI coverage: доля найденных LSI-терминов.
        lsi_coverage = sum(1 for t in lsi_terms if t.lower() in text.lower()) / max(
            len(lsi_terms), 1
        )

        # Плотность ключа.
        words = re.findall(r"\b\w+\b", text.lower())
        density = text.lower().count(keyword.lower()) / max(len(words), 1)

        stuffing_penalty = -2.0 if density > 0.03 else 0.0
        # Штраф за LSI > 75%: -1 за каждые +5% сверх порога (капом до -3).
        lsi_penalty = -min(max((lsi_coverage - 0.75) / 0.05, 0) * 1.0, 3.0)
        lsi_bonus = 1.0 if 0.60 <= lsi_coverage <= 0.75 else 0.0

        final = max(0.0, min(10.0, bm25_score + lsi_bonus + stuffing_penalty + lsi_penalty))
        return YandexLayerScore(
            bm25_score=round(bm25_score, 2),
            lsi_coverage=round(lsi_coverage, 3),
            keyword_density=round(density, 4),
            stuffing_penalty=stuffing_penalty,
            lsi_overuse_penalty=round(lsi_penalty, 1),
            final_score=round(final, 2),
            details="",
        )

    def score_google(
        self,
        entities_top20: List[str],
        entities_generated: List[str],
        competitor_frequencies: Dict[str, float],
        entities_required: List[str],
    ) -> GoogleLayerScore:
        gen_lower = [e.lower() for e in entities_generated]

        # Coverage: обязательные сущности в тексте.
        covered = sum(1 for e in entities_required if e.lower() in gen_lower)
        coverage_ratio = covered / max(len(entities_required), 1)

        # Information Gain: уникальные сущности (freq < 30% конкурентов).
        unique_in_text = sum(
            1
            for e in entities_top20
            if competitor_frequencies.get(e, 0.5) < 0.30 and e.lower() in gen_lower
        )
        ig_score = min(unique_in_text / 3.0, 1.0)

        details = ""
        if unique_in_text < 2:
            candidates = [
                e
                for e in entities_top20
                if competitor_frequencies.get(e, 0.5) < 0.30 and e.lower() not in gen_lower
            ][:3]
            details = f"⚠ Добавь уникальные сущности: {candidates}"

        final = min(10.0, coverage_ratio * 5.0 + ig_score * 5.0)
        return GoogleLayerScore(
            entities_top20=entities_top20,
            entities_generated=entities_generated,
            coverage_ratio=round(coverage_ratio, 3),
            unique_entities_found=unique_in_text,
            information_gain_score=round(ig_score, 3),
            final_score=round(final, 2),
            details=details,
        )

    def score(
        self,
        project_id: str,
        keyword: str,
        lsi_terms: List[str],
        text: str,
        corpus: List[str],
        entities_top20: List[str],
        entities_generated: List[str],
        competitor_frequencies: Dict[str, float],
        entities_required: List[str],
    ) -> HybridScoreResult:
        y = self.score_yandex(keyword, lsi_terms, text, corpus)
        g = self.score_google(
            entities_top20, entities_generated, competitor_frequencies, entities_required
        )
        hybrid = round(0.45 * y.final_score + 0.55 * g.final_score, 2)
        passed = hybrid >= 8.0
        feedback = None
        if not passed:
            feedback = (
                f"Яндекс ({y.final_score}/10): {y.details}\n"
                f"Google ({g.final_score}/10): {g.details}"
            )
        return HybridScoreResult(
            project_id=project_id,
            keyword=keyword,
            yandex_score=y,
            google_score=g,
            hybrid_final=hybrid,
            passed=passed,
            feedback=feedback,
        )
