"""Сравнение «наш сайт vs ТОП конкурентов».

Берём готовый отчёт по корпусу ТОПа (vocabulary + ngrams + processed_documents)
и леммы нашего документа — и считаем:

  * **lsi_coverage**       — % важных лемм ТОПа, встречающихся у нас ≥ 1 раз;
  * **vocab_coverage**     — то же для всего словаря (не только important);
  * **ngrams_coverage**    — % биграмм/триграмм/4-грамм ТОПа у нас;
  * **bm25_score**         — BM25 нашего документа против корпуса ТОПа
                             (через rank-bm25 с query=important_lemmas);
  * **tf_idf_cosine**      — косинус угла между нашим TF-IDF вектором и
                             покомпонентной медианой векторов ТОПа;
  * **per_term_gap**       — для каждой леммы из словаря: our_count vs
                             median_count_top, и статус
                             missing/under/ok/over;
  * **per_phrase_gap**     — то же для n-грамм;
  * **directives**         — конкретные текстовые директивы для копирайтера
                             («Слово X: у вас 8, медиана 26, +18»).

Никаких сетевых вызовов — модуль чистый, считает поверх готовых лемм.
"""

from __future__ import annotations

from collections import Counter
from typing import Dict, List, Sequence

from .bm25_calc import score_document_against_corpus

# Пороги статусов для per-term gap (доля от медианы):
#   < UNDER_RATIO          → under
#   между UNDER..OVER      → ok
#   > OVER_RATIO * median  → over (риск переспама)
UNDER_RATIO = 0.5
OVER_RATIO  = 1.5
# Минимальное «лишнее» абсолютное значение, чтобы счесть over: + 5 к медиане.
# Иначе при медиане 1 любой повтор 2 раз помечался бы как переспам.
OVER_ABSOLUTE_BUFFER = 5

# Сколько максимум директив выдавать (чтобы UI не лопнул).
MAX_DIRECTIVES = 200


def _doc_term_counts(lemmas: Sequence[str]) -> Dict[str, int]:
    c: Dict[str, int] = {}
    for l in lemmas:
        c[l] = c.get(l, 0) + 1
    return c


def _classify(our_count: int, median: float) -> str:
    if our_count == 0:
        return "missing"
    if median <= 0:
        # Терм есть только у нас — это «over» с т.з. ниши.
        return "over"
    ratio = our_count / median
    if ratio < UNDER_RATIO:
        return "under"
    if ratio > OVER_RATIO and our_count >= median + OVER_ABSOLUTE_BUFFER:
        return "over"
    return "ok"


def compute_comparison(
    *,
    our_lemmas: List[str],
    vocabulary: List[dict],
    ngrams: List[dict],
    corpus_lemmas: List[List[str]],
    our_text_chars: int = 0,
    our_html_chars: int = 0,
    median_text_chars: float = 0.0,
    median_html_chars: float = 0.0,
    top3_median_counts: Dict[str, float] | None = None,
    synonym_map: Dict[str, str] | None = None,
) -> dict:
    """Считает сравнительный отчёт. Все аргументы keyword-only — не путаемся.

    Args:
        our_lemmas: леммы нашего документа (после normalizer).
        vocabulary: уже посчитанный словарь ТОПа (rows из compute_vocabulary_bm25).
        ngrams: уже посчитанные n-граммы ТОПа (rows из compute_ngrams).
        corpus_lemmas: lemmas всех документов ТОПа (для BM25 нашего документа).
        our_text_chars / our_html_chars: длины нашего документа (для text/HTML
            ratio в сравнении с корпусом).
        median_text_chars / median_html_chars: медианы по корпусу.
        top3_median_counts: (SEO Relevance Analyzer 2.0) медиана вхождений
            каждой леммы среди страниц ТОП-3. Если задано — добавляем
            anti-overoptimization директивы (§17): «сократите переспам леммы X:
            выше медианы top-3». Опционально, обратная совместимость сохранена.
        synonym_map: (ТЗ 23.07.2026, п.1.1) mapping `lemma -> canonical` от
            семантической кластеризации синонимов. Если задан, our_count леммы
            считается по всему её кластеру (напр. «автомобиль» засчитывает и
            «машина»), устраняя ложные «missing» из-за использования синонимов.
    """
    our_counts = _doc_term_counts(our_lemmas)

    # Кластерные (синонимичные) счётчики: для каждой леммы — суммарный our_count
    # по всему семантическому кластеру. Даёт устойчивость к синонимам.
    cluster_counts: Dict[str, int] = {}
    if synonym_map:
        clusters: Dict[str, set] = {}
        for term, canon in synonym_map.items():
            members = clusters.setdefault(canon, set())
            members.add(term)
            members.add(canon)
        for canon, members in clusters.items():
            total = sum(our_counts.get(m, 0) for m in members)
            for m in members:
                cluster_counts[m] = total

    # ── 1) Vocabulary gap (per-term) ──────────────────────────────────────
    important_lemmas: List[str] = []
    per_term: List[dict] = []
    important_hits = 0
    important_total = 0
    vocab_hits = 0
    vocab_total = len(vocabulary)

    for v in vocabulary:
        lemma = v.get("lemma", "")
        if not lemma:
            continue
        median = float(v.get("median_count") or 0)
        own_count = int(our_counts.get(lemma, 0))
        # our_count с учётом синонимичного кластера (если кластеризация активна).
        our_count = int(cluster_counts.get(lemma, own_count))
        status = _classify(our_count, median)
        is_important = (v.get("status") == "important")
        if is_important:
            important_lemmas.append(lemma)
            important_total += 1
            if our_count > 0:
                important_hits += 1
        if our_count > 0:
            vocab_hits += 1
        row = {
            "lemma":         lemma,
            "df":            int(v.get("df") or 0),
            "median_top":    median,
            "our_count":     our_count,
            "bm25_score":    float(v.get("bm25_score") or 0),
            "tf_idf_score":  float(v.get("tf_idf_score") or 0),
            "important":     is_important,
            "status":        status,    # missing / under / ok / over
        }
        # Если синоним-кластер добавил вхождения сверх собственных — помечаем,
        # чтобы UI/копирайтер понимали, что покрытие достигнуто синонимом.
        canon = (synonym_map or {}).get(lemma)
        if canon and canon != lemma:
            row["synonym_of"] = canon
        if our_count != own_count:
            row["own_count"] = own_count
        per_term.append(row)

    # ── 2) N-grams gap ────────────────────────────────────────────────────
    # Считаем фразы у нас «грубо»: сшиваем леммы подряд и ищем подстроку.
    our_lemma_str = " ".join(our_lemmas)

    def _phrase_count(phrase: str) -> int:
        if not phrase:
            return 0
        # +1 рамка, чтобы " слово " не нашло в "словосочетании"
        needle = " " + phrase + " "
        hay = " " + our_lemma_str + " "
        # быстрый подсчёт неперекрывающихся вхождений
        c = 0
        i = 0
        while True:
            j = hay.find(needle, i)
            if j == -1:
                break
            c += 1
            # неперекрывающиеся — двигаемся за конец фразы
            i = j + len(needle) - 1
        return c

    per_phrase: List[dict] = []
    ngrams_hits = 0
    ngrams_total = len(ngrams)
    for n in ngrams:
        phrase = n.get("phrase", "")
        median = float(n.get("median_count") or 0)
        our_count = _phrase_count(phrase)
        status = _classify(our_count, median)
        if our_count > 0:
            ngrams_hits += 1
        per_phrase.append({
            "phrase":     phrase,
            "df":         int(n.get("df") or 0),
            "median_top": median,
            "our_count":  our_count,
            "type":       n.get("type", ""),
            "status":     status,
        })

    # ── 3) BM25 + TF-IDF cosine нашего документа против корпуса ──────────
    # Для BM25 query = important_lemmas (если их < 5 — берём весь словарь).
    query = important_lemmas if len(important_lemmas) >= 5 \
        else [v.get("lemma", "") for v in vocabulary if v.get("lemma")]
    scoring = score_document_against_corpus(
        our_lemmas, corpus_lemmas, important_lemmas=query,
    )

    # ── 4) Coverage % ────────────────────────────────────────────────────
    def _pct(num, den) -> float:
        if not den:
            return 0.0
        return round(100.0 * num / den, 2)

    summary = {
        "our_text_chars":     int(our_text_chars or 0),
        "our_html_chars":     int(our_html_chars or 0),
        "our_text_html_ratio": round(
            (our_text_chars / max(our_html_chars, 1)) if our_text_chars else 0.0, 4,
        ),
        "median_text_chars_top": round(median_text_chars or 0, 1),
        "median_html_chars_top": round(median_html_chars or 0, 1),
        "median_text_html_ratio_top": round(
            (median_text_chars / max(median_html_chars, 1)) if median_text_chars else 0.0, 4,
        ),
        "lsi_coverage_pct":      _pct(important_hits, important_total),
        "vocab_coverage_pct":    _pct(vocab_hits, vocab_total),
        "ngrams_coverage_pct":   _pct(ngrams_hits, ngrams_total),
        "bm25_score":            scoring["bm25_score"],
        "bm25_score_norm":       scoring["bm25_score_norm"],
        "tf_idf_cosine":         scoring["tf_idf_cosine"],
        "important_lemmas_total": important_total,
        "important_lemmas_hit":   important_hits,
        "ngrams_total":           ngrams_total,
        "ngrams_hit":             ngrams_hits,
    }

    # ── 5) Math directives — самая ценная часть для копирайтера ──────────
    # Сортируем кандидатов по «важности» (BM25 score конкурентов) и берём
    # ТОП MAX_DIRECTIVES, у которых статус ≠ ok (т.е. что-то надо менять).
    directives: List[dict] = []
    sorted_terms = sorted(
        per_term,
        key=lambda x: (x["important"], x["bm25_score"]),
        reverse=True,
    )
    for t in sorted_terms:
        if t["status"] == "ok":
            continue
        if t["status"] == "missing":
            text = (
                f"Добавьте слово «{t['lemma']}» (рекомендуется ~{int(round(t['median_top']))} вхождений, "
                f"медиана ТОПа). У вас 0."
            )
            delta = int(round(t["median_top"]))
        elif t["status"] == "under":
            need = max(int(round(t["median_top"])) - t["our_count"], 1)
            text = (
                f"Увеличьте количество «{t['lemma']}» с {t['our_count']} до "
                f"{int(round(t['median_top']))} (медиана ТОПа). +{need}."
            )
            delta = need
        else:  # over
            cut = max(t["our_count"] - int(round(t["median_top"])), 1)
            text = (
                f"Сократите количество «{t['lemma']}» с {t['our_count']} до "
                f"{int(round(t['median_top']))} (медиана ТОПа). −{cut}."
            )
            delta = -cut
        directives.append({
            "lemma":     t["lemma"],
            "status":    t["status"],
            "class":     "lexical",
            "important": t["important"],
            "delta":     delta,          # положит = добавить, отриц = убрать
            "our_count": t["our_count"],
            "median_top": t["median_top"],
            "text":      text,
        })
        if len(directives) >= MAX_DIRECTIVES:
            break

    # ── 5b. Anti-overoptimization директивы по медиане ТОП-3 (§17) ────────
    # Продуктовый guardrail: не толкаем к переспаму. Если наше вхождение
    # леммы заметно выше медианы среди лидеров (ТОП-3) — рекомендуем сократить.
    if top3_median_counts:
        existing = {d["lemma"] for d in directives}
        extra: List[dict] = []
        for t in sorted_terms:
            lemma = t["lemma"]
            if lemma in existing:
                continue
            m3 = top3_median_counts.get(lemma)
            if m3 is None:
                continue
            our_count = t["our_count"]
            # Значимый перебор: выше 1.5×медианы top-3 и минимум +5 абсолютно.
            if our_count > max(m3 * OVER_RATIO, m3 + OVER_ABSOLUTE_BUFFER) and our_count > 0:
                cut = max(our_count - int(round(m3)), 1)
                extra.append({
                    "lemma":      lemma,
                    "status":     "over_top3",
                    "class":      "lexical",
                    "important":  t["important"],
                    "delta":      -cut,
                    "our_count":  our_count,
                    "median_top": t["median_top"],
                    "median_top3": round(m3, 2),
                    "text": (
                        f"Сократите переспам леммы «{lemma}»: у вас {our_count}, "
                        f"медиана ТОП-3 — {int(round(m3))}. −{cut} (риск переоптимизации)."
                    ),
                })
            if len(extra) >= MAX_DIRECTIVES:
                break
        directives.extend(extra)

    return {
        "summary":     summary,
        "per_term":    per_term,
        "per_phrase":  per_phrase,
        "directives":  directives,
    }


def per_competitor_table(
    *,
    competitors: List[dict],
    vocabulary: List[dict],
    corpus_lemmas: List[List[str]],
    our_doc: dict | None = None,
    text_chars_by_url: Dict[str, int] | None = None,
    word_count_by_url: Dict[str, int] | None = None,
    serp_position_by_url: Dict[str, int] | None = None,
    our_text_chars: int = 0,
    our_word_count: int = 0,
    our_serp_position: int | None = None,
) -> List[dict]:
    """Сводная табличка ТОП-N + наш сайт.

    Для каждого конкурента и для нашего документа считает:
      - lsi_coverage_pct — % важных лемм, присутствующих в документе
      - bm25_score       — BM25 этого документа против общего корпуса
      - tf_idf_cosine    — косинус с медианным вектором ТОПа
      - text_chars       — длина основного текста (для прозрачности)
      - word_count       — сырое число словоформ (без лемматизации/стоп-слов)
      - serp_position    — позиция URL в выдаче Яндекса по ключу (если есть)

    Args:
        competitors: список {url, lemmas} — документы ТОПа.
        vocabulary:  словарь ТОПа (для определения important).
        corpus_lemmas: lemmas корпуса ТОПа (= [c.lemmas for c in competitors]).
        our_doc:     {url, lemmas} нашего документа или None.
        text_chars_by_url / word_count_by_url: маппинг URL→метрика для
            конкурентов (берутся из document_diagnostics, не пересчитываются).
        serp_position_by_url: URL→номер в SERP (1-based). Может отсутствовать.
        our_text_chars / our_word_count / our_serp_position: метрики нашего
            документа (наш URL может быть не в ТОПе → our_serp_position=None).
    """
    important_lemmas = [
        v["lemma"] for v in vocabulary if v.get("status") == "important" and v.get("lemma")
    ]
    important_set = set(important_lemmas)

    text_chars_by_url = text_chars_by_url or {}
    word_count_by_url = word_count_by_url or {}
    serp_position_by_url = serp_position_by_url or {}

    rows: List[dict] = []

    def _row(
        url: str,
        lemmas: List[str],
        is_ours: bool,
        text_chars: int,
        word_count: int,
        serp_position: int | None,
    ) -> dict:
        cnt = _doc_term_counts(lemmas)
        hits = sum(1 for l in important_set if cnt.get(l, 0) > 0)
        coverage = (100.0 * hits / len(important_set)) if important_set else 0.0
        scoring = score_document_against_corpus(
            lemmas, corpus_lemmas, important_lemmas=important_lemmas,
        )
        return {
            "url":               url,
            "is_ours":           is_ours,
            "lsi_coverage_pct":  round(coverage, 2),
            "bm25_score":        scoring["bm25_score"],
            "bm25_score_norm":   scoring["bm25_score_norm"],
            "tf_idf_cosine":     scoring["tf_idf_cosine"],
            "tokens":            len(lemmas),
            "text_chars":        int(text_chars or 0),
            "word_count":        int(word_count or 0),
            "serp_position":     serp_position,
        }

    if our_doc and our_doc.get("lemmas"):
        rows.append(_row(
            our_doc.get("url", ""),
            list(our_doc["lemmas"]),
            True,
            our_text_chars,
            our_word_count,
            our_serp_position,
        ))
    for c in competitors:
        url = c.get("url", "")
        rows.append(_row(
            url,
            list(c.get("lemmas") or []),
            False,
            text_chars_by_url.get(url, 0),
            word_count_by_url.get(url, 0),
            serp_position_by_url.get(url),
        ))

    return rows
