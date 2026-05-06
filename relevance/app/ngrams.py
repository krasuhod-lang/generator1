"""Bigram and trigram extraction with POS-pattern filtering.

Согласно ТЗ ЭТАП 1, п.4:
  * биграммы и триграммы;
  * min DF = 3 сайта из 20 (≥ 15%);
  * разрешённые POS-паттерны: NOUN+NOUN, ADJ+NOUN, VERB+NOUN, NOUN+ADJ+NOUN;
  * мусор с предлогами/союзами/частицами выкинут на этапе normalizer
    (помечен пустым токеном — n-граммы через него не строятся).
"""

from __future__ import annotations

import statistics
from collections import Counter
from typing import Dict, List, Tuple

# Какие POS-паттерны принимаем. ADJF/ADJS схлопываем до ADJ.
ALLOWED_BIGRAM_PATTERNS = {("NOUN", "NOUN"), ("ADJ", "NOUN"), ("VERB", "NOUN")}
ALLOWED_TRIGRAM_PATTERNS = {("NOUN", "ADJ", "NOUN")}


def _norm_pos(pos: str) -> str:
    if pos in ("ADJF", "ADJS"):
        return "ADJ"
    if pos == "INFN":
        return "VERB"
    if pos in ("PRTF", "PRTS"):
        return "ADJ"  # причастия как прилагательные
    return pos


def _ngrams_from_seq(
    seq: List[Tuple[str, str]],
    n: int,
    allowed_patterns: set,
) -> List[Tuple[str, Tuple[str, ...]]]:
    """Возвращает [(phrase, pos_pattern_tuple)] длины n из последовательности.
    Любая позиция с lemma='' (разрыв стоп-словом / пунктуацией) обнуляет окно.
    """
    out: List[Tuple[str, Tuple[str, ...]]] = []
    L = len(seq)
    for i in range(L - n + 1):
        window = seq[i:i + n]
        if any(lemma == "" for lemma, _ in window):
            continue
        pos_pattern = tuple(_norm_pos(p) for _, p in window)
        if pos_pattern not in allowed_patterns:
            continue
        phrase = " ".join(lemma for lemma, _ in window)
        out.append((phrase, pos_pattern))
    return out


def compute_ngrams(
    doc_seqs: List[List[Tuple[str, str]]],
    *,
    min_df: int = 3,
    max_per_type: int = 200,
) -> List[dict]:
    """Возвращает список `{phrase, df, median_count, type, pos_pattern}`,
    отсортированный по убыванию (df, median_count).

    Args:
        doc_seqs: список документов, каждый — последовательность (lemma, pos)
                  с разрывами '' для стоп-слов / шума.
        min_df: минимальное число документов, в которых встретилась n-грамма.
        max_per_type: ограничение на каждый тип (биграмм/триграмм) для UI.
    """
    if not doc_seqs:
        return []

    # phrase -> { 'df': N, 'counts_per_doc': [..], 'type': str, 'pos_pattern': tuple }
    aggregated: Dict[str, dict] = {}

    for seq in doc_seqs:
        for n, allowed, kind in (
            (2, ALLOWED_BIGRAM_PATTERNS, "bigram"),
            (3, ALLOWED_TRIGRAM_PATTERNS, "trigram"),
        ):
            ngrams_in_doc = _ngrams_from_seq(seq, n, allowed)
            doc_counter = Counter(ph for ph, _ in ngrams_in_doc)
            seen_patterns: Dict[str, Tuple[str, ...]] = {}
            for ph, pat in ngrams_in_doc:
                seen_patterns.setdefault(ph, pat)
            for phrase, count in doc_counter.items():
                bucket = aggregated.setdefault(phrase, {
                    "type": kind,
                    "pos_pattern": "+".join(seen_patterns[phrase]),
                    "counts_per_doc": [],
                })
                bucket["counts_per_doc"].append(count)

    rows: List[dict] = []
    for phrase, info in aggregated.items():
        counts = info["counts_per_doc"]
        df = len(counts)
        if df < min_df:
            continue
        rows.append({
            "phrase": phrase,
            "df": df,
            "median_count": float(statistics.median(counts)) if counts else 0.0,
            "type": info["type"],
            "pos_pattern": info["pos_pattern"],
        })

    # Берём топ-N для каждого типа (биграммы и триграммы отдельно).
    bigrams = sorted([r for r in rows if r["type"] == "bigram"],
                     key=lambda r: (r["df"], r["median_count"]), reverse=True)[:max_per_type]
    trigrams = sorted([r for r in rows if r["type"] == "trigram"],
                      key=lambda r: (r["df"], r["median_count"]), reverse=True)[:max_per_type]

    return bigrams + trigrams
