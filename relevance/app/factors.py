"""SERP factor-matrix assembler (Phase 1 of Relevance Analyzer 2.0).

Собирает из УЖЕ посчитанных артефактов один плоский вектор факторов на каждую
страницу топа (row-per-page). Ничего заново не парсит и не качает — берёт:

  * lexical-метрики из `per_competitor_table` (comparison.py): bm25_score,
    tf_idf_cosine, lsi_coverage_pct, tokens, text_chars, word_count;
  * non-lexical сигналы из `signals.extract_competitor_signals` (per-URL):
    title/H1, UX-профиль, trust-links, freshness, exact-form occurrences,
    URL/slug, schema, intent (commercial), lexical diversity (TTR/MTLD),
    format (FAQ/таблицы/списки), question-bank;
  * позицию в SERP (`serp_position`).

Матрица — фундамент для `correlations.py` (Спирмен фактор↔позиция) и для
`top3_vs_top20` дифференциала. По ТЗ §14 сырую матрицу отдаём наружу
(`page_factor_vectors`), чтобы её можно было пересчитать офлайн без повторного
скачивания SERP.

Всё чисто и детерминировано, без внешних тяжёлых зависимостей.
"""

from __future__ import annotations

import statistics
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple


def _get(d: Optional[dict], *path, default=None):
    """Безопасный доступ к вложенному dict по цепочке ключей."""
    cur: Any = d
    for key in path:
        if not isinstance(cur, dict):
            return default
        cur = cur.get(key)
        if cur is None:
            return default
    return cur


def _num(v) -> Optional[float]:
    """Приводит значение к float. bool → 0/1. Некорректное → None."""
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        f = float(v)
        # NaN/inf защита
        if f != f or f in (float("inf"), float("-inf")):
            return None
        return f
    return None


# ── Декларативная спецификация факторов ───────────────────────────────────────
# Каждый фактор: (имя, группа, getter(lex_row, sig) -> value|None).
# lex_row — строка из per_competitor_table по этому URL (может быть None).
# sig     — per-URL сигналы из signals.py (может быть None).

FactorGetter = Callable[[Optional[dict], Optional[dict]], Any]


def _lex(key: str) -> FactorGetter:
    return lambda lex, sig: (_num(lex.get(key)) if isinstance(lex, dict) else None)


def _sigp(*path) -> FactorGetter:
    return lambda lex, sig: _num(_get(sig, *path))


# (name, group, getter)
FACTOR_DEFS: List[Tuple[str, str, FactorGetter]] = [
    # ── lexical ──
    ("text_chars",              "lexical",     _lex("text_chars")),
    ("word_count",              "lexical",     _lex("word_count")),
    ("unique_terms",            "lexical",     _lex("tokens")),
    ("bm25_score",              "lexical",     _lex("bm25_score")),
    ("tf_idf_cosine",           "lexical",     _lex("tf_idf_cosine")),
    ("lsi_coverage_pct",        "lexical",     _lex("lsi_coverage_pct")),
    # ── structural ──
    ("h2_count",                "structural",  _sigp("ux_profile", "h2_count")),
    ("h3_count",                "structural",  _sigp("ux_profile", "h3_count")),
    ("headings_per_1k_words",   "structural",  _sigp("ux_profile", "headings_per_1k_words")),
    ("paragraph_count",         "structural",  _sigp("ux_profile", "paragraph_count")),
    ("has_toc",                 "structural",  _sigp("ux_profile", "has_toc")),
    ("has_faq_early",           "structural",  _sigp("ux_profile", "has_faq_early")),
    ("media_count",             "structural",  _sigp("ux_profile", "media_count")),
    # ── formatting ──
    ("avg_paragraph_chars",     "formatting",  _sigp("ux_profile", "avg_paragraph_chars")),
    ("short_paragraph_share_pct", "formatting", _sigp("ux_profile", "short_paragraph_share_pct")),
    ("above_the_fold_words",    "formatting",  _sigp("ux_profile", "above_the_fold_words")),
    # ── html / schema ──
    ("schema_types_count",      "html_schema", lambda lex, sig: (
        float(len(sig.get("schema_types"))) if isinstance(sig, dict)
        and isinstance(sig.get("schema_types"), list) else None)),
    ("title_chars",             "html_schema", _sigp("title_meta", "title_chars")),
    ("h1_chars",                "html_schema", _sigp("title_meta", "h1_chars")),
    ("title_query_exact_hits",  "html_schema", _sigp("title_meta", "title_query_exact_hits")),
    ("title_query_token_coverage_pct", "html_schema",
     _sigp("title_meta", "title_query_token_coverage_pct")),
    ("url_depth_slashes",       "html_schema", _sigp("url_factors", "depth_slashes")),
    ("is_https",                "html_schema", _sigp("url_factors", "is_https")),
    # ── trust ──
    ("external_links",          "trust",       _sigp("trust_links", "external_links")),
    ("trust_links",             "trust",       _sigp("trust_links", "trust_links")),
    ("trust_share_pct",         "trust",       _sigp("trust_links", "trust_share_pct")),
    ("age_modified_days",       "trust",       _sigp("freshness", "age_modified_days")),
    ("is_fresh_365",            "trust",       _sigp("freshness", "is_fresh_365")),
    # ── commercial ──
    ("commercial_score",        "commercial",  _sigp("intent_signals", "commercial_score")),
    # ── exact-match / partial-match ──
    ("exact_occurrences_total", "lexical",     _sigp("exact_occurrences", "total")),
    ("exact_in_first_100_words", "lexical",    _sigp("exact_occurrences", "first_100_words")),
    # ── readability / diversity ──
    ("ttr",                     "readability", _sigp("lexical_diversity", "ttr")),
    ("mtld",                    "readability", _sigp("lexical_diversity", "mtld")),
    # ── effort proxy ──
    ("effort_score",            "readability", lambda lex, sig: _num(_get(sig, "effort_score"))),
]

# Публичный список имён факторов (порядок стабилен).
FACTOR_NAMES: List[str] = [name for name, _grp, _g in FACTOR_DEFS]
FACTOR_GROUPS: Dict[str, str] = {name: grp for name, grp, _g in FACTOR_DEFS}


def build_factor_matrix(
    per_doc: Sequence[dict],
) -> Dict[str, Any]:
    """Строит матрицу факторов row-per-page.

    Args:
        per_doc: список бандлов по документу:
            { "url": str,
              "serp_position": int|None,
              "lex_row": dict|None,   # строка per_competitor_table
              "signals": dict|None }  # per-URL из signals.py

    Returns:
        {
          "factors": [ {name, group}, ... ],
          "rows": [ {url, serp_position, values:{factor: float|None}}, ... ],
        }
    """
    rows: List[dict] = []
    for bundle in (per_doc or []):
        lex = bundle.get("lex_row") if isinstance(bundle, dict) else None
        sig = bundle.get("signals") if isinstance(bundle, dict) else None
        values: Dict[str, Optional[float]] = {}
        for name, _grp, getter in FACTOR_DEFS:
            try:
                values[name] = getter(lex, sig)
            except Exception:
                values[name] = None
        pos = bundle.get("serp_position") if isinstance(bundle, dict) else None
        rows.append({
            "url":           bundle.get("url", "") if isinstance(bundle, dict) else "",
            "serp_position": pos if isinstance(pos, (int, float)) else None,
            "values":        values,
        })
    return {
        "factors": [{"name": n, "group": FACTOR_GROUPS[n]} for n in FACTOR_NAMES],
        "rows":    rows,
    }


def _median_or_none(vals: Sequence[float]) -> Optional[float]:
    clean = [v for v in vals if isinstance(v, (int, float)) and v is not None]
    if not clean:
        return None
    return round(float(statistics.median(clean)), 4)


def top3_vs_top20_delta(
    rows: Sequence[dict],
    factor_names: Sequence[str] = FACTOR_NAMES,
) -> Dict[str, Any]:
    """Сравнивает медианы факторов в бакетах позиций 1–3 / 4–10 / 11–20.

    Цель (§9.3): найти не «среднее по SERP», а «что отличает лидеров».

    Returns:
        {
          "buckets": {"top3": n, "top4_10": n, "top11_20": n},
          "deltas": [ {factor, group, median_top3, median_top4_10,
                       median_top11_20, delta_top3_minus_top20,
                       leader_advantage}, ... ] sorted by |delta| share.
        }
    """
    def _bucket(lo: int, hi: int) -> List[dict]:
        return [
            r for r in rows
            if isinstance(r.get("serp_position"), (int, float))
            and lo <= r["serp_position"] <= hi
        ]

    top3 = _bucket(1, 3)
    top4_10 = _bucket(4, 10)
    top11_20 = _bucket(11, 20)

    deltas: List[dict] = []
    for name in factor_names:
        def _vals(bucket):
            return [
                r["values"].get(name) for r in bucket
                if isinstance((r.get("values") or {}).get(name), (int, float))
            ]
        m3 = _median_or_none(_vals(top3))
        m4 = _median_or_none(_vals(top4_10))
        m11 = _median_or_none(_vals(top11_20))
        if m3 is None and m11 is None:
            continue
        delta = None
        leader_adv = None
        if m3 is not None and m11 is not None:
            delta = round(m3 - m11, 4)
            # Относительное преимущество лидеров (нормируем на масштаб).
            base = max(abs(m3), abs(m11), 1e-9)
            leader_adv = round((m3 - m11) / base, 4)
        deltas.append({
            "factor":                 name,
            "group":                  FACTOR_GROUPS.get(name, "other"),
            "median_top3":            m3,
            "median_top4_10":         m4,
            "median_top11_20":        m11,
            "delta_top3_minus_top20": delta,
            "leader_advantage":       leader_adv,
        })

    # Сортируем по абсолютному относительному преимуществу лидеров.
    deltas.sort(
        key=lambda d: abs(d["leader_advantage"]) if d["leader_advantage"] is not None else -1.0,
        reverse=True,
    )
    return {
        "buckets": {
            "top3":     len(top3),
            "top4_10":  len(top4_10),
            "top11_20": len(top11_20),
        },
        "deltas": deltas,
    }
