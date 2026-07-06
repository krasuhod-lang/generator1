"""Tests for the SERP factor-matrix assembler (factors.py).

Детерминированные фикстуры: BM25/структура/trust монотонно лучше у верхних
позиций → матрица должна это сохранить, top3/top20 дифференциал должен видеть
преимущество лидеров.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import factors  # noqa: E402


def _mk_doc(pos):
    lex = {
        "bm25_score": 100 - pos * 5,
        "tf_idf_cosine": round(0.9 - pos * 0.02, 4),
        "lsi_coverage_pct": 90 - pos * 3,
        "tokens": 2000 - pos * 50,
        "text_chars": 12000 - pos * 300,
        "word_count": 2000 - pos * 40,
    }
    sig = {
        "ux_profile": {
            "h2_count": 20 - pos, "h3_count": 10, "headings_per_1k_words": 8,
            "paragraph_count": 40, "has_toc": 1 if pos <= 4 else 0,
            "has_faq_early": 0, "media_count": 5, "avg_paragraph_chars": 300,
            "short_paragraph_share_pct": 20, "above_the_fold_words": 80,
            "word_count": 2000,
        },
        "trust_links": {"external_links": 10, "trust_links": 5 if pos <= 3 else 1, "trust_share_pct": 30},
        "freshness": {"age_modified_days": pos * 30, "is_fresh_365": pos <= 6},
        "title_meta": {"title_chars": 55, "h1_chars": 40, "title_query_exact_hits": 1,
                       "title_query_token_coverage_pct": 80},
        "url_factors": {"depth_slashes": 2, "is_https": True},
        "exact_occurrences": {"total": 10 - pos, "first_100_words": 1},
        "intent_signals": {"commercial_score": 0.2},
        "lexical_diversity": {"ttr": 0.5, "mtld": 60},
        "schema_types": ["Article", "FAQPage"],
        "effort_score": 50 - pos,
    }
    return {"url": f"u{pos}", "serp_position": pos, "lex_row": lex, "signals": sig}


def _matrix(n=12):
    return factors.build_factor_matrix([_mk_doc(p) for p in range(1, n + 1)])


def test_matrix_shape_and_factor_names():
    m = _matrix()
    assert len(m["rows"]) == 12
    assert len(m["factors"]) == len(factors.FACTOR_NAMES)
    # каждый row содержит значения для всех факторов
    for row in m["rows"]:
        assert set(row["values"].keys()) == set(factors.FACTOR_NAMES)
        assert isinstance(row["serp_position"], int)


def test_bool_coerced_to_float():
    m = _matrix()
    row1 = m["rows"][0]
    assert row1["values"]["is_https"] in (0.0, 1.0)
    assert row1["values"]["is_fresh_365"] in (0.0, 1.0)


def test_schema_types_counted():
    m = _matrix()
    assert m["rows"][0]["values"]["schema_types_count"] == 2.0


def test_missing_signal_yields_none():
    doc = {"url": "x", "serp_position": 1, "lex_row": None, "signals": None}
    m = factors.build_factor_matrix([doc])
    vals = m["rows"][0]["values"]
    assert vals["bm25_score"] is None
    assert vals["h2_count"] is None


def test_top3_vs_top20_delta_detects_leader_advantage():
    m = _matrix()
    d = factors.top3_vs_top20_delta(m["rows"])
    assert d["buckets"]["top3"] == 3
    assert d["buckets"]["top11_20"] == 2
    # bm25_score у лидеров должен быть больше, чем у 11-20
    bm25 = next(x for x in d["deltas"] if x["factor"] == "bm25_score")
    assert bm25["median_top3"] > bm25["median_top11_20"]
    assert bm25["delta_top3_minus_top20"] > 0


def test_empty_input_is_safe():
    m = factors.build_factor_matrix([])
    assert m["rows"] == []
    d = factors.top3_vs_top20_delta([])
    assert d["buckets"]["top3"] == 0
    assert d["deltas"] == []
