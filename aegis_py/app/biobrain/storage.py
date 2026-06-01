"""Persistence helpers for BioBrain."""

from __future__ import annotations

import json
import os
import pickle
from pathlib import Path
from typing import Any, Optional

ROOT = Path(os.environ.get("AEGIS_BIOBRAIN_DIR", str(Path(__file__).resolve().parents[3] / "brain_state")))
BEST_FILE = ROOT / "biobrain_best.pkl"
STATE_FILE = ROOT / "biobrain_state.json"


def save_best_genome(genome: Any) -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    with BEST_FILE.open("wb") as f:
        pickle.dump(genome, f)


def load_best_genome() -> Optional[Any]:
    if not BEST_FILE.exists():
        return None
    try:
        with BEST_FILE.open("rb") as f:
            return pickle.load(f)
    except Exception:
        return None


def save_state(state: dict) -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state), encoding="utf-8")


def load_state() -> dict:
    if not STATE_FILE.exists():
        return {}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


BUFFER_FILE = ROOT / "biobrain_buffer.json"


def save_buffer(samples: Any, *, max_items: int = 256) -> None:
    """Persist the experience buffer so learning survives restarts.

    ``samples`` is an iterable of ``(features, target)`` pairs. Only the most
    recent ``max_items`` are kept. Best-effort: never raises.
    """
    try:
        ROOT.mkdir(parents=True, exist_ok=True)
        items = list(samples)[-max_items:]
        payload = [
            {"f": [float(x) for x in feat], "t": float(target)}
            for feat, target in items
        ]
        BUFFER_FILE.write_text(json.dumps(payload), encoding="utf-8")
    except Exception:
        pass


def load_buffer() -> list:
    """Load the persisted experience buffer as a list of ``(features, target)``."""
    if not BUFFER_FILE.exists():
        return []
    try:
        raw = json.loads(BUFFER_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []
    out = []
    for row in raw if isinstance(raw, list) else []:
        try:
            feat = [float(x) for x in row.get("f", [])]
            target = float(row.get("t"))
            if feat:
                out.append((feat, target))
        except Exception:
            continue
    return out
