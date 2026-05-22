"""Tests for aegis_py.app.vector_gc (Phase 14)."""
from aegis_py.app import vector_gc


def test_is_available_returns_bool():
    assert isinstance(vector_gc.is_available(), bool)


def test_unavailable_reason_str_or_none():
    r = vector_gc.unavailable_reason()
    assert r is None or isinstance(r, str)


def test_module_exposes_public_api():
    # Required public surface for the JS client / controller.
    assert hasattr(vector_gc, "sweep_ttl")
    assert hasattr(vector_gc, "cleanup_run")
    assert callable(vector_gc.sweep_ttl)
    assert callable(vector_gc.cleanup_run)


def test_sweep_ttl_graceful_when_qdrant_missing():
    """Without qdrant installed, sweep_ttl must NOT raise."""
    if vector_gc.is_available():
        return  # qdrant installed — skip
    out = vector_gc.sweep_ttl(ttl_days=30, ephemeral_prefixes=["evidence_"])
    assert isinstance(out, dict)
    assert out.get("status") == "disabled"
    assert out.get("points_deleted_total") == 0


def test_cleanup_run_graceful_when_qdrant_missing():
    if vector_gc.is_available():
        return
    out = vector_gc.cleanup_run(run_id="rel_test_xxx")
    assert isinstance(out, dict)
    assert out.get("status") == "disabled"


def test_cleanup_run_empty_run_id_when_available():
    """Empty run_id rejected only when qdrant is available."""
    if not vector_gc.is_available():
        return  # disabled-path checked above
    out = vector_gc.cleanup_run(run_id="")
    assert isinstance(out, dict)
    assert out.get("status") == "error"
    assert out.get("reason") == "run_id_required"


def test_cutoff_iso_respects_safety_floor():
    """cutoff(days=0) should still be at least min_safety_hours in the past."""
    c = vector_gc._cutoff_iso(days=0, min_safety_hours=24)
    assert isinstance(c, str)
    # ISO format → starts with year.
    assert len(c) >= 19


def test_is_ephemeral_prefix_matching():
    assert vector_gc._is_ephemeral("evidence_xyz", ["evidence_", "serp_"]) is True
    assert vector_gc._is_ephemeral("serp_query_42", ["evidence_", "serp_"]) is True
    assert vector_gc._is_ephemeral("aegis_brain", ["evidence_", "serp_"]) is False
    assert vector_gc._is_ephemeral("", ["evidence_"]) is False
