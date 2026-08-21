import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app import dspy_optimizer as optimizer


def _row(i, spq=80):
    return {
        "id": f"real-{i}",
        "user_prompt": f"Write grounded HTML article about topic {i}",
        "ground_truth_context": f"Only verified evidence about topic {i}",
        "html_output": f"<h1>Topic {i}</h1><h2>Facts</h2><p>Verified evidence {i}</p><ul><li>Constraint</li></ul>",
        "spq_overall": spq,
        "quality_score": {"overall": spq},
    }


def test_empty_real_dataset_never_deploys(monkeypatch, tmp_path):
    monkeypatch.setattr(optimizer, "_STATE_FILE", tmp_path / "status.json")
    result = optimizer.retrain(
        niche=None,
        dry_run=False,
        max_trials=2,
        max_cost_usd=1,
        min_improvement_pct=5,
        real_rows=[],
    )
    assert result["last_status"] == "seed_only"
    assert "artifact_path" not in result


def test_dry_run_does_not_write_artifact(monkeypatch, tmp_path):
    monkeypatch.setattr(optimizer, "_STATE_FILE", tmp_path / "status.json")
    monkeypatch.setattr(optimizer, "COMPILED_WRITER_PATH", tmp_path / "compiled_writer.yaml")
    result = optimizer.retrain(
        niche="test",
        dry_run=True,
        max_trials=2,
        max_cost_usd=1,
        min_improvement_pct=5,
        real_rows=[_row(i) for i in range(5)],
    )
    assert result["last_status"] == "planned"
    assert not (tmp_path / "compiled_writer.yaml").exists()


def test_real_compile_without_lm_is_explicit(monkeypatch, tmp_path):
    monkeypatch.setattr(optimizer, "_STATE_FILE", tmp_path / "status.json")
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    result = optimizer.retrain(
        niche="test",
        dry_run=False,
        max_trials=2,
        max_cost_usd=1,
        min_improvement_pct=5,
        real_rows=[_row(i) for i in range(5)],
    )
    assert result["last_status"] in {"compile_unavailable", "compile_failed"}
    assert "artifact_path" not in result


def test_metric_requires_non_empty_structured_html():
    example = type("Example", (), {"draft_text": "<h1>Alpha</h1><p>Verified fact</p>"})()
    empty = type("Prediction", (), {"draft_text": ""})()
    good = type("Prediction", (), {"draft_text": "<h1>Alpha</h1><p>Verified fact</p>"})()
    assert optimizer._metric(example, empty) == 0.0
    assert optimizer._metric(example, good) > 0.0


def test_artifact_write_is_atomic_and_versioned(monkeypatch, tmp_path):
    artifact = tmp_path / "brain_state" / "compiled_writer.yaml"
    history = tmp_path / "history"
    monkeypatch.setattr(optimizer, "COMPILED_WRITER_PATH", artifact)
    monkeypatch.setattr(optimizer, "HISTORY_DIR", history)

    class Signature:
        instructions = "Use evidence only."

    class Generator:
        signature = Signature()

    class Program:
        generate = Generator()

    first = optimizer._write_compiled_artifact(Program(), "test/model", 0.5, 0.8, 5, None)
    assert artifact.exists()
    assert len(first["artifact_sha"]) == 64
    second = optimizer._write_compiled_artifact(Program(), "test/model", 0.5, 0.81, 6, "shorter_intro")
    assert artifact.exists()
    assert second["artifact_sha"] != first["artifact_sha"]
    assert list(history.glob("compiled_writer.*.yaml"))


def test_controlled_candidate_deploys_only_after_holdout_gain(monkeypatch, tmp_path):
    monkeypatch.setattr(optimizer, "_STATE_FILE", tmp_path / "status.json")
    monkeypatch.setattr(optimizer, "COMPILED_WRITER_PATH", tmp_path / "brain_state" / "compiled_writer.yaml")
    monkeypatch.setattr(optimizer, "HISTORY_DIR", tmp_path / "brain_state" / "history")
    monkeypatch.setattr(optimizer, "_dspy_lm_configure", lambda: (True, "fake/deepseek"))
    monkeypatch.setattr(optimizer, "_compile_candidate", lambda trainset, max_trials: type(
        "Program", (), {"generate": type("Generator", (), {
            "signature": type("Signature", (), {"instructions": "Use evidence only."})()
        })()}
    )())
    monkeypatch.setattr(optimizer, "_evaluate_candidate", lambda program, holdout: 0.95)
    result = optimizer.retrain(
        niche="test",
        dry_run=False,
        max_trials=2,
        max_cost_usd=1,
        min_improvement_pct=5,
        real_rows=[_row(i, spq=70) for i in range(10)],
    )
    assert result["last_status"] == "deployed"
    assert Path(result["artifact_path"]).exists()
    assert len(result["artifact_sha"]) == 64
