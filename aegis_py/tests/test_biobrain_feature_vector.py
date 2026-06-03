from aegis_py.app.biobrain.feature_vector import extract_features


def test_feature_vector_is_stable_and_bounded():
    text = "<h2>Тест</h2><p>SEO текст 2026 и FAQ</p><ul><li>one</li></ul>"
    a = extract_features(text, has_cover_image=True)
    b = extract_features(text, has_cover_image=True)
    assert a == b
    assert len(a) == 8
    assert all(0.0 <= x <= 1.0 for x in a)


def test_eeat_signals_blend_into_dim_fact():
    """B2: E-E-A-T add-on signals lift dim 4 (factual_grounding)."""
    from aegis_py.app.biobrain.feature_vector import extract_features
    base = extract_features("<p>x</p>")
    rich = extract_features(
        "<p>x</p>",
        signals={
            "fact_check": 0.5,
            "eeat_citations": 1.0,
            "eeat_author_bio": True,
            "schema_article": True,
        },
    )
    # Blend of (0.5, 1.0, 1.0, 1.0) = 0.875 — strictly greater than the
    # text-only proxy and the base fact_check alone.
    assert rich[4] > base[4]
    assert rich[4] > 0.8


def test_serp_structural_fit_blends_into_intent_dim():
    """B2: SERP-fit signals reach dim 7 (intent_or_cover)."""
    from aegis_py.app.biobrain.feature_vector import extract_features
    rich = extract_features(
        "<p>x</p>",
        signals={"intent_ok": True, "intent_match_score": 1.0,
                 "serp_structural_fit": 1.0},
    )
    assert abs(rich[7] - 1.0) < 1e-9


def test_nan_signals_are_ignored_not_treated_as_zero():
    """B2: NaN/None inputs must not pull the feature down to 0."""
    import math
    from aegis_py.app.biobrain.feature_vector import extract_features
    base = extract_features("<p>hello</p>", signals={"fact_check": 0.7})
    nan_sig = extract_features(
        "<p>hello</p>",
        signals={"fact_check": 0.7, "eeat_citations": float("nan"),
                 "eeat_author_bio": None},
    )
    # NaN/None must not lower the dimension — it's the same as fact_check alone.
    assert abs(base[4] - nan_sig[4]) < 1e-9


def test_faq_schema_lifts_list_usage_dim():
    """B2: FAQPage schema signal blends into dim 2 (list_usage)."""
    from aegis_py.app.biobrain.feature_vector import extract_features
    base = extract_features("<p>plain</p>")
    rich = extract_features("<p>plain</p>", signals={"faq_schema": True})
    assert rich[2] > base[2]
