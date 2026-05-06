"""Bigram, trigram and 4-gram extraction with POS-pattern filtering.

Согласно ТЗ ЭТАП 1, п.4 + правки заказчика:
  * биграммы, триграммы и 4-граммы;
  * **жёсткий порог по доле сайтов**: фразу выводим, только если она
    встречается у ≥ MIN_DF_SHARE_PCT (40%) сайтов из корпуса. Заказчик
    явно потребовал: «если встречается более чем у 40% сайтов то выводятся,
    если меньше, то не выводим их». Никакого динамического снижения порога
    больше не делаем — иначе в выдаче появляются «случайные» фразы;
  * разрешённые POS-паттерны: NOUN+NOUN, ADJ+NOUN, VERB+NOUN, NOUN+ADJ+NOUN,
    NOUN+NOUN+NOUN, NOUN+NOUN+ADJ+NOUN, ADJ+NOUN+ADJ+NOUN, ADJ+ADJ+NOUN+NOUN;
  * мусор с предлогами/союзами/частицами выкинут на этапе normalizer
    (помечен пустым токеном — n-граммы через него не строятся).
"""

from __future__ import annotations

import math
import statistics
from collections import Counter
from typing import Dict, List, Tuple

# Какие POS-паттерны принимаем. ADJF/ADJS схлопываем до ADJ.
ALLOWED_BIGRAM_PATTERNS = {
    ("NOUN", "NOUN"),
    ("ADJ",  "NOUN"),
    ("VERB", "NOUN"),
}
ALLOWED_TRIGRAM_PATTERNS = {
    ("NOUN", "ADJ",  "NOUN"),
    ("NOUN", "NOUN", "NOUN"),
    ("ADJ",  "ADJ",  "NOUN"),
    ("ADJ",  "NOUN", "NOUN"),
}
ALLOWED_4GRAM_PATTERNS = {
    ("NOUN", "NOUN", "ADJ",  "NOUN"),
    ("ADJ",  "NOUN", "ADJ",  "NOUN"),
    ("ADJ",  "ADJ",  "NOUN", "NOUN"),
    ("NOUN", "ADJ",  "ADJ",  "NOUN"),
    ("NOUN", "NOUN", "NOUN", "NOUN"),
}

# Жёсткий порог: фраза должна встретиться у ≥ 40% сайтов (по умолчанию).
# Это требование заказчика, см. docstring модуля. min_df на входе остаётся
# как «нижний абсолютный пол» (например, при 5 документах 40% даст 2 —
# и это OK; при 3 документах 40% даст 1.2 → ceil=2, но абсолютный пол 1
# для очень маленьких корпусов).
MIN_DF_SHARE_PCT = 40.0


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
    max_per_type: int = 2000,
    min_df_share_pct: float = MIN_DF_SHARE_PCT,
) -> List[dict]:
    """Возвращает список `{phrase, df, df_share_pct, median_count, type, pos_pattern}`,
    отсортированный по убыванию (df, median_count) внутри каждого типа.

    Args:
        doc_seqs: список документов, каждый — последовательность (lemma, pos)
                  с разрывами '' для стоп-слов / шума.
        min_df:   абсолютный нижний пол по df (защита от случая когда корпус
                  очень маленький и 40% даёт <1).
        max_per_type: ограничение на каждый тип для UI.
        min_df_share_pct: порог по доле сайтов (0..100). По умолчанию 40%
                  согласно требованию заказчика.
    """
    if not doc_seqs:
        return []

    n_docs = len(doc_seqs)
    # Эффективный порог = max(min_df, ceil(n_docs * share/100)).
    share_threshold = max(1, math.ceil(n_docs * (min_df_share_pct / 100.0)))
    effective_min_df = max(int(min_df), share_threshold)

    # phrase -> { 'df': N, 'counts_per_doc': [..], 'type': str, 'pos_pattern': tuple }
    aggregated: Dict[str, dict] = {}

    for seq in doc_seqs:
        for n, allowed, kind in (
            (2, ALLOWED_BIGRAM_PATTERNS,  "bigram"),
            (3, ALLOWED_TRIGRAM_PATTERNS, "trigram"),
            (4, ALLOWED_4GRAM_PATTERNS,   "4gram"),
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

    chosen_rows: List[dict] = []
    for phrase, info in aggregated.items():
        counts = info["counts_per_doc"]
        df = len(counts)
        if df < effective_min_df:
            continue
        chosen_rows.append({
            "phrase": phrase,
            "df": df,
            "df_share_pct": round(100.0 * df / max(n_docs, 1), 1),
            "median_count": float(statistics.median(counts)) if counts else 0.0,
            "type": info["type"],
            "pos_pattern": info["pos_pattern"],
        })

    # Берём топ-N для каждого типа отдельно.
    out: List[dict] = []
    for kind in ("bigram", "trigram", "4gram"):
        same = [r for r in chosen_rows if r["type"] == kind]
        same.sort(key=lambda r: (r["df"], r["median_count"]), reverse=True)
        out.extend(same[:max_per_type])

    return out
