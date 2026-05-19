"""BM25 + TF-IDF scoring of every vocabulary term against the corpus.

Подход (см. ТЗ ЭТАП 1, п.3):
  1. Собираем единый словарь лемм по всем документам.
  2. Каждую лемму используем как «query» к BM25 над корпусом.
  3. Считаем суммарный BM25-score этого терма по всем документам корпуса.
  4. Дополнительно считаем классический TF-IDF (sum_d (tf_d * idf)),
     idf = log((N + 1) / (df + 1)) + 1 (smoothing как в sklearn).
  5. Сортируем — это вес слова в нише.

Размечаем status по доле документов топа, в которых встречается лемма
(любая словоформа = одна лемма после морфоанализа):
  * df_share_pct ≥ 51%  → "important"  (★ обязательные LSI ниши);
  * 20% ≤ df_share_pct < 51% → "additional" (доп. LSI, желательны);
  * df_share_pct < 20%  → "rare" (показываем для прозрачности, но
    не считаем релевантными — слово встретилось лишь у одного-двух
    документов и, скорее всего, отражает их частную специфику).

Подход согласован с заказчиком: «более 51% сопоставлений слова в разных
словоформах — важный LSI; от 20 до 50% — дополнительный».
"""

from __future__ import annotations

import math
import statistics
from typing import Dict, List

from rank_bm25 import BM25Okapi


# ── Пороги статуса лемм (детерминированные, без env) ─────────────────────────
# Согласовано с заказчиком: «более 51% сопоставлений слова в разных
# словоформах является важным LSI; от 20 до 50% — дополнительный».
# Лемматизация уже сворачивает все словоформы в одну лемму, поэтому df
# (document frequency) по леммам и есть «сколько документов топа содержат
# любую словоформу этого слова».
IMPORTANT_DF_SHARE_PCT  = 51.0   # ≥ → "important"
ADDITIONAL_DF_SHARE_PCT = 20.0   # ≥ → "additional" (если < IMPORTANT)
# меньше ADDITIONAL_DF_SHARE_PCT → "rare" (показываем, но не считаем
# обязательным к покрытию LSI).


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
            # Доля документов корпуса, в которых встретилась лемма (любая
            # словоформа после лемматизации). Используется и для status, и
            # для UI («встречается у X из N сайтов топа = Y%»).
            "df_share_pct": round(100.0 * df_l / max(n_docs, 1), 1),
            "median_count": median_count,
            # Округляем до 4 знаков, чтобы JSON не пух.
            "bm25_score":   round(bm25_sum, 4),
            "tf_idf_score": round(float(tf_idf_sum), 4),
        })

    rows.sort(key=lambda r: r["bm25_score"], reverse=True)
    rows = rows[:max_terms]

    # Размечаем «Важное / Доп. / Редкое» по доле документов топа, в которых
    # встречается лемма (а не по BM25/TF-IDF). Это — детерминированный и
    # объяснимый критерий, согласованный с заказчиком: «более 51% — важный
    # LSI; 20–50% — дополнительный». BM25/TF-IDF остаются в строке для
    # сортировки и для UI-таблицы, но не влияют на status.
    for r in rows:
        share = r.get("df_share_pct") or 0.0
        if share >= IMPORTANT_DF_SHARE_PCT:
            r["status"] = "important"
        elif share >= ADDITIONAL_DF_SHARE_PCT:
            r["status"] = "additional"
        else:
            r["status"] = "rare"

    return rows


# ── Document scoring against an existing corpus (для сравнения нашего сайта) ──

def score_document_against_corpus(
    our_lemmas: List[str],
    corpus_lemmas: List[List[str]],
    *,
    important_lemmas: List[str] | None = None,
) -> Dict[str, float]:
    """Считает BM25-релевантность нашего документа корпусу ТОПа.

    Логика: BM25Okapi(corpus) + query = ВАЖНЫЕ леммы (LSI-ключи). Это даёт
    «насколько хорошо наш текст ранжируется как раз по тем словам, которые
    важны в нише». Если important_lemmas не задан — берём весь словарь
    нашего документа (это общая релевантность всему корпусу).

    Возвращает:
      bm25_score        — суммарный BM25 нашего документа против ТОПа
      bm25_score_norm   — нормированный (доля от макс. score в корпусе)
      tf_idf_cosine     — косинус между нашим TF-IDF вектором и медианным
                          вектором ТОПа (по объединённому словарю).
    """
    out = {"bm25_score": 0.0, "bm25_score_norm": 0.0, "tf_idf_cosine": 0.0}
    if not our_lemmas or not corpus_lemmas:
        return out

    bm25 = BM25Okapi(corpus_lemmas + [our_lemmas])
    # query: либо явно заданные important леммы, либо уникумы нашего документа
    query = list(dict.fromkeys(important_lemmas)) if important_lemmas else list(set(our_lemmas))
    if not query:
        return out

    scores = bm25.get_scores(query)
    # Последняя позиция в массиве scores — наш документ
    our_score = float(scores[-1])
    corpus_scores = [float(s) for s in scores[:-1]]

    out["bm25_score"] = round(our_score, 4)
    if corpus_scores:
        # max из корпуса берём как baseline; при отрицательных значениях
        # нормировка теряет смысл (BM25 на крошечных корпусах часто < 0
        # из-за idf-штрафа за общие слова), поэтому в этом случае
        # возвращаем 0 — нет смысла «нормировать на минус».
        max_score = max(max(corpus_scores), our_score)
        if max_score > 1e-6:
            out["bm25_score_norm"] = round(max(0.0, our_score) / max_score, 4)

    # TF-IDF cosine: вектор по объединённому словарю (corpus + our).
    # 1) df по всему расширенному корпусу (для idf)
    all_docs = corpus_lemmas + [our_lemmas]
    n_docs = len(all_docs)
    df_map: Dict[str, int] = {}
    for doc in all_docs:
        for lemma in set(doc):
            df_map[lemma] = df_map.get(lemma, 0) + 1
    vocab = sorted(df_map.keys())
    if not vocab:
        return out

    idx = {lemma: i for i, lemma in enumerate(vocab)}
    idf_arr = [math.log((n_docs + 1) / (df_map[v] + 1)) + 1.0 for v in vocab]

    def _vec(doc_lemmas: List[str]) -> List[float]:
        cnt: Dict[str, int] = {}
        for l in doc_lemmas:
            cnt[l] = cnt.get(l, 0) + 1
        v = [0.0] * len(vocab)
        for lemma, c in cnt.items():
            if c <= 0 or lemma not in idx:
                continue
            i = idx[lemma]
            v[i] = (1.0 + math.log(c)) * idf_arr[i]
        return v

    # Медианный вектор ТОПа: покомпонентная медиана TF-IDF векторов.
    corpus_vecs = [_vec(d) for d in corpus_lemmas]
    if not corpus_vecs:
        return out
    median_vec = [
        statistics.median([cv[i] for cv in corpus_vecs])
        for i in range(len(vocab))
    ]
    our_vec = _vec(our_lemmas)

    def _cos(a: List[float], b: List[float]) -> float:
        dot = sum(x * y for x, y in zip(a, b))
        na  = math.sqrt(sum(x * x for x in a))
        nb  = math.sqrt(sum(y * y for y in b))
        if na == 0 or nb == 0:
            return 0.0
        return dot / (na * nb)

    out["tf_idf_cosine"] = round(_cos(our_vec, median_vec), 4)
    return out
