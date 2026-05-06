"""Bigram, trigram and 4-gram extraction with POS-pattern filtering.

Согласно ТЗ ЭТАП 1, п.4 + правки заказчика «n-грамм надо собирать от 30 штук,
чем больше тем лучше»:

  * биграммы, триграммы и 4-граммы;
  * базовый min DF = 3 сайта (≥ 15%), но если в выдаче меньше TARGET_PER_TYPE
    (по умолчанию 30) — динамически снижаем порог до 2, затем до 1, чтобы
    добрать минимально-приемлемое количество фраз;
  * разрешённые POS-паттерны: NOUN+NOUN, ADJ+NOUN, VERB+NOUN, NOUN+ADJ+NOUN,
    NOUN+NOUN+NOUN, NOUN+NOUN+ADJ+NOUN, ADJ+NOUN+ADJ+NOUN, ADJ+ADJ+NOUN+NOUN;
  * мусор с предлогами/союзами/частицами выкинут на этапе normalizer
    (помечен пустым токеном — n-граммы через него не строятся).
"""

from __future__ import annotations

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

# Сколько n-грамм каждого типа стараемся отдать минимум, прежде чем сдадимся.
TARGET_PER_TYPE = 30


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
) -> List[dict]:
    """Возвращает список `{phrase, df, median_count, type, pos_pattern}`,
    отсортированный по убыванию (df, median_count) внутри каждого типа.

    Args:
        doc_seqs: список документов, каждый — последовательность (lemma, pos)
                  с разрывами '' для стоп-слов / шума.
        min_df: исходное минимальное число документов. Если фраз получается
                меньше TARGET_PER_TYPE, порог автоматически снижается до 2,
                затем до 1.
        max_per_type: ограничение на каждый тип для UI (по умолчанию 2000 —
                достаточно много, чтобы ничего не отбрасывать без нужды).
    """
    if not doc_seqs:
        return []

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

    def _rows_with_threshold(threshold: int) -> List[dict]:
        rows_local: List[dict] = []
        for phrase, info in aggregated.items():
            counts = info["counts_per_doc"]
            df = len(counts)
            if df < threshold:
                continue
            rows_local.append({
                "phrase": phrase,
                "df": df,
                "median_count": float(statistics.median(counts)) if counts else 0.0,
                "type": info["type"],
                "pos_pattern": info["pos_pattern"],
            })
        return rows_local

    # Динамический подбор порога: пытаемся min_df, если для какого-то типа
    # фраз < TARGET_PER_TYPE — снижаем до min_df-1, потом до 1. Не страшно,
    # если уникумы попадут в «Доп»: пользователю важнее увидеть варианты.
    candidate_thresholds = [t for t in (min_df, max(1, min_df - 1), 1) if t >= 1]
    # Уникальный порядок без дублей.
    seen_t = set()
    candidate_thresholds = [t for t in candidate_thresholds if not (t in seen_t or seen_t.add(t))]

    chosen_rows: List[dict] = []
    for t in candidate_thresholds:
        chosen_rows = _rows_with_threshold(t)
        type_counts = Counter(r["type"] for r in chosen_rows)
        # Если хоть один тип имеет < TARGET_PER_TYPE — снижаем порог дальше.
        # Но если уже на min_df=1 не набрали — отдаём что есть.
        worst = min((type_counts.get(k, 0) for k in ("bigram", "trigram", "4gram")), default=0)
        if worst >= TARGET_PER_TYPE or t == 1:
            break

    # Берём топ-N для каждого типа отдельно.
    out: List[dict] = []
    for kind in ("bigram", "trigram", "4gram"):
        same = [r for r in chosen_rows if r["type"] == kind]
        same.sort(key=lambda r: (r["df"], r["median_count"]), reverse=True)
        out.extend(same[:max_per_type])

    return out
