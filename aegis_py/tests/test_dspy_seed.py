"""Tests for aegis_py.app.dspy_seed (Phase 14)."""
from aegis_py.app import dspy_seed


def test_count_seeds_at_least_10():
    n = dspy_seed.count_seeds()
    assert n >= 10, f"need ≥10 seed rows, got {n}"
    assert n >= 50, f"need ≥50 seed rows, got {n}"


def test_seed_rows_have_required_fields():
    rows = dspy_seed.load_seed_dataset(None)
    assert isinstance(rows, list) and len(rows) > 0
    for r in rows:
        assert "user_prompt" in r
        assert "html_output" in r
        assert "quality_score" in r or "spq_overall" in r
        # Quality threshold: seeds must be TOP-1 references (≥ 80).
        score = r.get("spq_overall") or r.get("quality_score") or 0
        assert score >= 80, f"seed quality must be ≥80, got {score}"


def test_seed_niches_returns_list():
    niches = dspy_seed.seed_niches()
    assert isinstance(niches, list)
    assert len(niches) >= 1
    assert {"medicina", "it", "finance"}.issubset(set(niches))


def test_load_seed_dataset_niche_filter():
    all_rows = dspy_seed.load_seed_dataset(None)
    niches = dspy_seed.seed_niches()
    if niches:
        first = niches[0]
        filtered = dspy_seed.load_seed_dataset(first)
        # filtered ⊆ all
        assert len(filtered) <= len(all_rows)
        # all filtered rows belong to the niche
        for r in filtered:
            assert r.get("niche") == first


def test_load_seed_dataset_unknown_niche_returns_all_or_empty():
    """Behaviour-tolerant: either returns [] for unknown niche or falls back."""
    rows = dspy_seed.load_seed_dataset("__nonexistent_niche__")
    assert isinstance(rows, list)
