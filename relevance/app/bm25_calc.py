"""BM25 + TF-IDF scoring of every vocabulary term against the corpus.

Подход (см. ТЗ ЭТАП 1, п.3):
  1. Собираем единый словарь лемм по всем документам.
  2. Каждую лемму используем как «query» к BM25 над корпусом.
  3. Считаем суммарный BM25-score этого терма по всем документам корпуса.
  4. Дополнительно считаем классический TF-IDF (sum_d (tf_d * idf)),
     idf = log((N + 1) / (df + 1)) + 1 (smoothing как в sklearn).
  5. Сортируем — это вес слова в нише.

Размечаем status="important" для топовых токенов и "additional" для остальных.
Порог — top 30% по BM25 ИЛИ top 30% по TF-IDF, плюс DF >= 3.
"""

from __future__ import annotations

import math
import statistics
from typing import Dict, List

from rank_bm25 import BM25Okapi


def _doc_term_counts(doc_lemmas: List[List[str]]) -> List[Dict[str, int]]:
    out: List[Dict[str, int]] = []
    for doc in doc_lemmas:
        counts: Dict[str, int] = {}
        for lemma in doc:
            counts[lemma] = counts.get(lemma, 0) + 1
        out.append(counts)
    return out


def _document_frequency(doc_counts: List[Dict[str, int]]) -> Dict[str, int]:
    df: Dict[str, int] = {}
    for counts in doc_counts:
        for lemma in counts:
            df[lemma] = df.get(lemma, 0) + 1
    return df


def compute_vocabulary_bm25(
    doc_lemmas: List[List[str]],
    *,
    min_df: int = 2,
    max_terms: int = 5000,
) -> List[dict]:
    """Возвращает список `{lemma, df, median_count, bm25_score, tf_idf_score, status}`,
    отсортированный по убыванию bm25_score.

    Args:
        doc_lemmas: список документов, каждый — список лемм.
        min_df: минимальный document frequency, чтобы попасть в выдачу.
        max_terms: ограничение на размер словаря (защита от patological-edge).
            По умолчанию 5000 — все «интересные» леммы влезают, ничего не
            отбрасываем без необходимости.
    """
    if not doc_lemmas:
        return []

    bm25 = BM25Okapi(doc_lemmas)
    doc_counts = _doc_term_counts(doc_lemmas)
    df_map = _document_frequency(doc_counts)

    n_docs = len(doc_lemmas)

    # Фильтруем словарь по min_df.
    vocab = [lemma for lemma, df in df_map.items() if df >= min_df]
    if not vocab:
        return []

    rows: List[dict] = []
    for lemma in vocab:
        # BM25 для query=[lemma] возвращает массив scores по документам.
        scores = bm25.get_scores([lemma])
        # Суммарный BM25 (как в ТЗ — «суммарный score по всем документам»).
        bm25_sum = float(sum(scores))

        # TF-IDF: классический smoothed вариант (как в sklearn TfidfTransformer).
        # idf = log((N + 1) / (df + 1)) + 1
        df_l = df_map[lemma]
        idf = math.log((n_docs + 1) / (df_l + 1)) + 1.0
        # tf — sublinear (1 + log(tf)) для устойчивости к спам-повторам.
        per_doc_counts = [c.get(lemma, 0) for c in doc_counts if c.get(lemma, 0) > 0]
        tf_idf_sum = sum((1.0 + math.log(tf)) * idf for tf in per_doc_counts) if per_doc_counts else 0.0

        # Медиана числа вхождений по документам, где терм встретился.
        median_count = float(statistics.median(per_doc_counts)) if per_doc_counts else 0.0

        rows.append({
            "lemma": lemma,
            "df": df_l,
            "median_count": median_count,
            # Округляем до 4 знаков, чтобы JSON не пух.
            "bm25_score":   round(bm25_sum, 4),
            "tf_idf_score": round(float(tf_idf_sum), 4),
        })

    rows.sort(key=lambda r: r["bm25_score"], reverse=True)
    rows = rows[:max_terms]

    # Размечаем «Важное / Доп»: top-30% по BM25 ИЛИ top-30% по TF-IDF →
    # important, при условии, что терм встречается минимум в 3 документах
    # (даже если min_df ниже — «важными» считаем только те, что подтверждены
    # ≥3 сайтами, чтобы не помечать редкий шум).
    if rows:
        threshold_idx = max(1, math.ceil(len(rows) * 0.3))

        # Порог по BM25 (rows уже отсортирован по bm25_score)
        bm25_top = sorted([r["bm25_score"] for r in rows], reverse=True)
        bm25_threshold = bm25_top[min(threshold_idx, len(bm25_top)) - 1]

        # Порог по TF-IDF
        tfidf_top = sorted([r["tf_idf_score"] for r in rows], reverse=True)
        tfidf_threshold = tfidf_top[min(threshold_idx, len(tfidf_top)) - 1]

        important_min_df = max(min_df, 3)
        for r in rows:
            top_bm25  = r["bm25_score"]   >= bm25_threshold
            top_tfidf = r["tf_idf_score"] >= tfidf_threshold
            r["status"] = "important" if (top_bm25 or top_tfidf) and r["df"] >= important_min_df else "additional"

    return rows
