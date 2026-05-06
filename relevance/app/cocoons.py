"""Semantic cocoons via Truncated SVD (a.k.a. LSI / LSA).

Идея PR 2:
  1. На вход получаем processed_documents — список документов, каждый
     представлен набором лемм (отфильтрованных от стоп-слов и служебных
     POS на этапе normalizer).
  2. Строим TF-IDF матрицу (sublinear_tf=True, без min_df, чтобы не
     терять редкие, но осмысленные термины — стоп-слова уже отфильтрованы).
  3. Прогоняем `TruncatedSVD(n_components=n_topics)` — каждая компонента
     становится «темой» (cocoon) с вектором весов для всех термов и
     вектором проекций для всех документов.
  4. Для каждой темы возвращаем top-N лемм по абсолютному весу (с
     указанием знака — отрицательные веса означают «антитему», полезно
     копирайтеру для понимания антагонистических кластеров) и top-K
     документов с наивысшей проекцией.
  5. Возвращаем «label» темы — конкатенацию топ-3 лемм с положительным
     весом (просто и читабельно).

Никаких внешних эмбеддингов / LLM — это полностью offline-метод, дёшево
и детерминировано (random_state=0).
"""

from __future__ import annotations

from typing import List, Sequence

import numpy as np
from sklearn.decomposition import TruncatedSVD
from sklearn.feature_extraction.text import TfidfVectorizer


def _safe_n_topics(n_docs: int, requested: int) -> int:
    """SVD требует n_components < min(n_samples, n_features). Подстраховка."""
    if n_docs < 2:
        return 0
    return max(1, min(requested, n_docs - 1, 64))


def compute_cocoons(
    processed_docs: Sequence[dict],
    *,
    n_topics: int = 8,
    top_terms: int = 12,
    top_documents: int = 5,
) -> dict:
    """Возвращает {topics: [...], stats: {...}}.

    Args:
        processed_docs: список объектов вида {url, lemmas: [...]}.
            Лемм должно быть достаточно (хотя бы ~30 на документ),
            иначе SVD не выйдет содержательным — отфильтровываем такие.
        n_topics: желаемое число тем (фактическое может быть меньше).
        top_terms: сколько топ-лемм возвращать на тему.
        top_documents: сколько топ-документов возвращать на тему.
    """
    # Берём только документы с достаточным числом лемм (хотя бы 10).
    docs = [d for d in processed_docs if len(d.get("lemmas") or []) >= 10]
    if len(docs) < 2:
        return {
            "topics": [],
            "stats": {
                "doc_count": len(docs),
                "n_topics_requested": n_topics,
                "n_topics_actual": 0,
                "vocab_size": 0,
                "skipped_too_short": len(processed_docs) - len(docs),
            },
        }

    n_topics_actual = _safe_n_topics(len(docs), n_topics)
    if n_topics_actual <= 0:
        return {
            "topics": [],
            "stats": {
                "doc_count": len(docs),
                "n_topics_requested": n_topics,
                "n_topics_actual": 0,
                "vocab_size": 0,
                "skipped_too_short": len(processed_docs) - len(docs),
            },
        }

    # Каждый документ — «строка» уже нормализованных лемм. Используем
    # стандартный TfidfVectorizer с custom analyzer (просто identity на
    # списке лемм), чтобы не сломать единственно-русскую токенизацию.
    corpus = [doc["lemmas"] for doc in docs]
    urls   = [doc.get("url", "") for doc in docs]

    vectorizer = TfidfVectorizer(
        analyzer=lambda x: x,           # документ уже разбит на леммы
        lowercase=False,                 # уже lower
        token_pattern=None,
        sublinear_tf=True,
        # min_df=1 (default) — не выкидываем редкие термины: стоп-слова
        # уже выпилены normalizer'ом, а редкие термины часто и есть
        # темообразующие («антифриз», «пресс-форма»).
        max_df=0.95,                     # совсем универсальные термы режем
    )
    try:
        X = vectorizer.fit_transform(corpus)
    except ValueError:
        # Например, после max_df фильтра словарь оказался пустым.
        return {
            "topics": [],
            "stats": {
                "doc_count": len(docs),
                "n_topics_requested": n_topics,
                "n_topics_actual": 0,
                "vocab_size": 0,
                "skipped_too_short": len(processed_docs) - len(docs),
            },
        }

    vocab = vectorizer.get_feature_names_out()
    if len(vocab) == 0:
        return {
            "topics": [],
            "stats": {
                "doc_count": len(docs),
                "n_topics_requested": n_topics,
                "n_topics_actual": 0,
                "vocab_size": 0,
                "skipped_too_short": len(processed_docs) - len(docs),
            },
        }

    # Дополнительная подстраховка по числу фич.
    n_topics_actual = max(1, min(n_topics_actual, len(vocab) - 1))

    svd = TruncatedSVD(n_components=n_topics_actual, random_state=0)
    doc_topic = svd.fit_transform(X)            # (n_docs, n_topics)
    components = svd.components_                  # (n_topics, n_terms)
    explained = list(map(float, svd.explained_variance_ratio_))

    topics: List[dict] = []
    for t_idx in range(n_topics_actual):
        weights = components[t_idx]
        # top-N термов по абсолютному весу — берём с запасом, потом срезаем
        # положительную ветку отдельно для label'а.
        order = np.argsort(np.abs(weights))[::-1]
        terms_out = []
        for i in order[:top_terms]:
            terms_out.append({
                "lemma":  str(vocab[i]),
                "weight": round(float(weights[i]), 5),
            })

        # Label = топ-3 положительных лемм
        positive = [t for t in terms_out if t["weight"] > 0][:3]
        label    = " · ".join(t["lemma"] for t in positive) or terms_out[0]["lemma"]

        # top-K документов: проекции doc_topic[:, t_idx]
        doc_scores = doc_topic[:, t_idx]
        doc_order  = np.argsort(doc_scores)[::-1][:top_documents]
        docs_out = [
            {"url": urls[i], "score": round(float(doc_scores[i]), 5)}
            for i in doc_order
            if doc_scores[i] > 0
        ]

        topics.append({
            "id":                 t_idx,
            "label":              label,
            "explained_variance": round(explained[t_idx], 5),
            "terms":              terms_out,
            "top_documents":      docs_out,
        })

    return {
        "topics": topics,
        "stats": {
            "doc_count":          len(docs),
            "n_topics_requested": n_topics,
            "n_topics_actual":    n_topics_actual,
            "vocab_size":         int(len(vocab)),
            "skipped_too_short":  len(processed_docs) - len(docs),
            "total_explained_variance": round(float(sum(explained)), 5),
        },
    }
