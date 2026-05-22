"""Optional Brian2-based confidence layer."""

from __future__ import annotations

from typing import Iterable

_REASON = None
try:  # pragma: no cover
    import brian2  # noqa: F401
    _OK = True
except Exception as e:  # pragma: no cover
    _OK = False
    _REASON = f"brian2_missing: {e.__class__.__name__}"


def is_available() -> bool:
    return _OK


def unavailable_reason() -> str | None:
    return _REASON


def snn_confidence(features: Iterable[float]) -> float:
    # Lightweight fallback: approximate spike confidence by feature energy.
    vals = [max(0.0, min(1.0, float(x))) for x in features]
    if not vals:
        return 0.5
    return max(0.0, min(1.0, sum(vals) / len(vals)))
