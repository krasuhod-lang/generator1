"""DSPy MIPROv2 optimizer.

Тянет aegis_dspy_dataset из PostgreSQL (через psycopg/SQLAlchemy в реальной
имплементации; здесь — заглушка), запускает Bayesian-оптимизацию системного
промпта и сохраняет результат в brain_state/compiled_writer.yaml.

Графейс-деградирует: если dspy-ai не установлен → is_available() == False.
"""

import datetime
import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

_REASON = None
try:  # pragma: no cover
    import dspy  # type: ignore
    _DSPY_OK = True
except Exception as e:  # pragma: no cover
    dspy = None  # type: ignore
    _DSPY_OK = False
    _REASON = f"dspy_missing: {e.__class__.__name__}"


_STATE_FILE = Path(os.environ.get("AEGIS_DSPY_STATE_FILE", "/tmp/aegis_dspy_status.json"))


def is_available() -> bool:
    return _DSPY_OK


def unavailable_reason() -> Optional[str]:
    return _REASON


def status() -> Dict[str, Any]:
    if _STATE_FILE.exists():
        try:
            return json.loads(_STATE_FILE.read_text("utf-8"))
        except Exception:
            pass
    return {"last_run_at": None, "last_status": "never_ran", "available": is_available()}


def _save_status(payload: Dict[str, Any]) -> None:
    try:
        _STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        _STATE_FILE.write_text(json.dumps(payload), "utf-8")
    except Exception:
        pass


def retrain(*, niche: Optional[str], dry_run: bool, max_trials: int,
            max_cost_usd: float, min_improvement_pct: float) -> Dict[str, Any]:
    """Запускает (или эмулирует в dry_run) Bayesian-оптимизацию.

    Реальная имплементация:
      1. SELECT user_prompt, html_output, spq_overall, ppo_weight
         FROM aegis_dspy_dataset WHERE used_in_retrain IS NULL
         AND (niche = $1 OR $1 IS NULL) ORDER BY created_at DESC LIMIT 500;
      2. metric = weighted Spq * ppo_weight.
      3. dspy.MIPROv2(prompt_model=..., metric=metric, num_trials=max_trials).
      4. Если improvement_pct ≥ min_improvement_pct → перезаписать
         brain_state/compiled_writer.yaml.
      5. INSERT INTO aegis_brain_versions(...).

    В dry_run возвращает план без реальных изменений.
    """
    started = datetime.datetime.utcnow().isoformat() + "Z"
    payload: Dict[str, Any] = {
        "started_at": started,
        "niche": niche,
        "dry_run": dry_run,
        "max_trials": max_trials,
        "max_cost_usd": max_cost_usd,
        "min_improvement_pct": min_improvement_pct,
        "last_status": "planned" if dry_run else "skipped_no_dataset",
    }
    if dry_run:
        _save_status(payload)
        return payload
    # ── РЕАЛЬНАЯ ЛОГИКА — добавляется при подключении dspy-ai + БД. ──
    payload["note"] = "production retrain requires dspy-ai + psycopg + GEMINI_API_KEY"
    _save_status(payload)
    return payload
