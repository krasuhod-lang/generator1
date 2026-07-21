"""Tests for aegis_py.app.dspy_optimizer Phase 14 (cold-start + ε-greedy)."""
import random

from aegis_py.app import dspy_optimizer as opt


def test_mutation_kinds_nonempty():
    assert isinstance(opt.MUTATION_KINDS, tuple)
    assert len(opt.MUTATION_KINDS) >= 5
    assert {
        "aio_first_paragraph",
        "entity_dense_list",
        "faq_schema_block",
        "contrast_semantics",
        "comparison_table_first",
        "multimodal_placeholders",
    }.issubset(set(opt.MUTATION_KINDS))
    for k in opt.MUTATION_KINDS:
        assert isinstance(k, str) and len(k) > 0


def test_should_mutate_zero_never_fires():
    rng = random.Random(42)
    for _ in range(200):
        assert opt.should_mutate(0.0, rng=rng) is False


def test_should_mutate_negative_treated_as_zero():
    rng = random.Random(1)
    for _ in range(50):
        assert opt.should_mutate(-0.5, rng=rng) is False


def test_should_mutate_clamped_to_max_rate():
    # rate=1.0 should be clamped to max_rate (0.20 default) → fires ~20%.
    rng = random.Random(1234)
    fires = sum(opt.should_mutate(1.0, rng=rng) for _ in range(2000))
    # Expected ~400/2000=20%, allow generous CI band.
    assert 200 <= fires <= 600, f"expected ~400 fires, got {fires}"


def test_pick_mutation_deterministic_for_same_seed_key():
    a = opt.pick_mutation(seed_key="okna|2026-W21")
    b = opt.pick_mutation(seed_key="okna|2026-W21")
    assert a == b
    assert a in opt.MUTATION_KINDS


def test_pick_mutation_different_for_different_seed_keys():
    seen = set()
    for w in range(20):
        seen.add(opt.pick_mutation(seed_key=f"okna|2026-W{w:02d}"))
    # Should hit several different kinds across 20 weeks.
    assert len(seen) >= 2


def test_apply_mutation_adds_marker():
    out = opt.apply_mutation("Base prompt.", "shorter_intro")
    assert "Base prompt." in out
    assert "[MUTATION/ε-greedy]" in out
    aio = opt.apply_mutation("Base prompt.", "aio_first_paragraph")
    assert "Base prompt." in aio
    assert "[MUTATION/ε-greedy]" in aio
    assert "130–170" in aio


def test_apply_mutation_unknown_kind_returns_prompt():
    out = opt.apply_mutation("Base.", "no_such_kind")
    assert out == "Base."


def test_apply_mutation_empty_prompt():
    out = opt.apply_mutation("", "shorter_intro")
    assert "[MUTATION/ε-greedy]" in out


def test_merge_with_seeds_cold_start_includes_seeds():
    """When real_rows is empty and cold-start ON, result includes seeds."""
    res = opt.merge_with_seeds(
        [],
        niche=None,
        min_rows=10,
        enabled=True,
    )
    assert res["used_seeds"] is True
    assert res["rows_real"] == 0
    assert res["rows_seed"] >= 1
    assert len(res["rows"]) == res["rows_seed"]


def test_merge_with_seeds_skips_when_disabled():
    res = opt.merge_with_seeds(
        [],
        niche=None,
        min_rows=10,
        enabled=False,
    )
    assert res["used_seeds"] is False
    assert res["rows"] == []


def test_merge_with_seeds_skips_when_enough_real_rows():
    real = [{"user_prompt": f"r{i}", "html_output": "h"} for i in range(20)]
    res = opt.merge_with_seeds(
        real,
        niche=None,
        min_rows=10,
        enabled=True,
    )
    assert res["used_seeds"] is False
    assert res["rows_seed"] == 0
    assert len(res["rows"]) == 20
