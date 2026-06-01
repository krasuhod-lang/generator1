"""BioBrain evolver (NEAT).

A self-learning neuro-evolution layer. It predicts the likely SEO quality of a
draft *before* expensive LLM passes (fast-reject gate), accumulates an
experience buffer of (features → real quality) outcomes, and evolves the best
genome over time. The buffer is persisted to disk so learning survives
restarts, and a background loop (see ``main.py``) calls :meth:`maybe_evolve`
periodically so the brain keeps improving even when no article is being
generated — i.e. it "lives its own life".
"""

from __future__ import annotations

import collections
import math
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Deque, Dict, Iterable, List, Optional, Tuple

from . import storage
from .feature_vector import extract_features, FEATURE_LABELS
from . import snn_layer

_REASON = None
try:  # pragma: no cover
    import neat  # type: ignore
    _OK = True
except Exception as e:  # pragma: no cover
    neat = None  # type: ignore
    _OK = False
    _REASON = f"neat_missing: {e.__class__.__name__}"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# Advice templates: weak dimension → human-readable JARVIS-style hint.
_ADVICE_RULES = (
    ("length",            0.25, "Статья короткая — добавьте разделов и раскройте подтемы."),
    ("heading_structure", 0.20, "Слабая структура заголовков — добавьте H2/H3 для логики."),
    ("list_usage",        0.10, "Мало списков/таблиц — структурируйте перечисления."),
    ("readability",       0.40, "Низкая читабельность — упростите длинные предложения."),
    ("factual_grounding", 0.30, "Мало фактов/цифр с подтверждением — добавьте источники."),
    ("originality",       0.40, "Риск шаблонности — переформулируйте заимствованные места."),
    ("lsi_coverage",      0.45, "Недостаточное LSI-покрытие — добавьте семантические термины."),
    ("intent_or_cover",   0.50, "Интент/обложка не подтверждены — проверьте соответствие SERP."),
)


class BioBrainEvolver:
    def __init__(self, cfg_path: Optional[Path] = None, *, min_buffer_to_evolve: int = 32):
        self.available = _OK
        self.reason = _REASON
        self.total_predictions = 0
        self.fast_rejects = 0
        self.min_buffer_to_evolve = max(1, int(min_buffer_to_evolve))
        self._buffer: Deque[Tuple[List[float], float]] = collections.deque(maxlen=256)
        self._generation = 0
        self._best_genome = None
        self._best_fitness = 0.0
        self._evolve_count = 0
        self._last_evolve_at: Optional[str] = None
        self._last_advice: List[str] = []
        self._cfg_path = cfg_path or (Path(__file__).parent / "config_neat.ini")
        self._config = None
        self._population = None

        st = storage.load_state()
        self._generation = int(st.get("generation", 0) or 0)
        self._best_fitness = float(st.get("mean_fitness", 0.0) or 0.0)
        self._evolve_count = int(st.get("evolve_count", 0) or 0)
        self._last_evolve_at = st.get("last_evolve_at") or None

        # Восстанавливаем буфер опыта, чтобы обучение пережило рестарт.
        for feat, target in storage.load_buffer():
            self._buffer.append((feat, target))

        if self.available:
            self._config = neat.Config(
                neat.DefaultGenome,
                neat.DefaultReproduction,
                neat.DefaultSpeciesSet,
                neat.DefaultStagnation,
                str(self._cfg_path),
            )
            self._population = neat.Population(self._config)
            self._best_genome = storage.load_best_genome()

    def _build_net(self, genome):
        if not self.available or genome is None:
            return None
        return neat.nn.FeedForwardNetwork.create(genome, self._config)

    def _build_advice(self, features: List[float], score: float) -> List[str]:
        """Deterministic, ranked human-readable hints for the weakest dims."""
        hints: List[Tuple[float, str]] = []
        for idx, (label, threshold, message) in enumerate(_ADVICE_RULES):
            if idx >= len(features):
                break
            val = features[idx]
            if val < threshold:
                # severity = how far below threshold (0..1), для ранжирования.
                severity = (threshold - val) / max(1e-6, threshold)
                hints.append((severity, message))
        hints.sort(key=lambda x: x[0], reverse=True)
        return [m for _, m in hints[:3]]

    def predict(self, *, features: Optional[Iterable[float]] = None, text: Optional[str] = None,
                signals: Optional[Dict[str, Any]] = None,
                threshold_fast_reject: float = 0.35) -> Dict[str, Any]:
        vals = list(features) if features is not None else extract_features(text or "", signals=signals)
        if not vals:
            vals = [0.5] * 8

        score = 0.5
        if self.available and self._best_genome is not None:
            try:
                out = self._build_net(self._best_genome).activate(vals)
                score = 1.0 / (1.0 + math.exp(-float(out[0])))
            except Exception:
                score = 0.5

        confidence = snn_layer.snn_confidence(vals)
        advice = self._build_advice(vals, score)
        self._last_advice = advice

        self.total_predictions += 1
        gate = "fast_reject" if score < threshold_fast_reject else "pass"
        if gate == "fast_reject":
            self.fast_rejects += 1

        return {
            "score": score,
            "gate": gate,
            "confidence": confidence,
            "advice": advice,
            "features": vals,
            "genome": self.stats(),
        }

    def record_outcome(self, *, features: Iterable[float], real_spq_overall: float) -> Dict[str, Any]:
        vals = [float(x) for x in features]
        target = max(0.0, min(1.0, float(real_spq_overall) / 100.0))
        self._buffer.append((vals, target))
        # Персистим буфер, чтобы накопленный опыт не терялся при рестарте.
        storage.save_buffer(self._buffer)
        return {"stored": True, "buffer": len(self._buffer)}

    def maybe_evolve(self, *, eval_batch: int = 32) -> Dict[str, Any]:
        """Эволюционировать, только если накоплено достаточно опыта.

        Вызывается фоновым циклом (autonomous life). Возвращает результат
        :meth:`evolve_step` либо причину, по которой эволюция пропущена.
        """
        batch = max(1, min(int(eval_batch), self.min_buffer_to_evolve))
        if len(self._buffer) < self.min_buffer_to_evolve:
            return {"evolved": False, "reason": "insufficient_buffer",
                    "buffer": len(self._buffer), "need": self.min_buffer_to_evolve}
        return self.evolve_step(eval_batch=batch)

    def evolve_step(self, eval_batch: int = 32) -> Dict[str, Any]:
        if not self.available:
            return {"evolved": False, "reason": self.reason}
        if len(self._buffer) < eval_batch:
            return {"evolved": False, "reason": "insufficient_buffer", "buffer": len(self._buffer)}

        sample = list(self._buffer)[-eval_batch:]

        def fitness_fn(genomes, config):
            for _, genome in genomes:
                net = neat.nn.FeedForwardNetwork.create(genome, config)
                mse = 0.0
                for feat, target in sample:
                    out = net.activate(feat)
                    pred = 1.0 / (1.0 + math.exp(-float(out[0])))
                    mse += (pred - target) ** 2
                mse /= max(1, len(sample))
                genome.fitness = max(0.0, 1.0 - mse)

        winner = self._population.run(fitness_fn, 1)
        self._best_genome = winner
        self._generation += 1
        self._evolve_count += 1
        self._last_evolve_at = _now_iso()
        self._best_fitness = float(getattr(winner, "fitness", 0.0) or 0.0)
        storage.save_best_genome(winner)
        storage.save_state({
            "generation": self._generation,
            "nodes": len(getattr(winner, "nodes", {}) or {}),
            "connections": len(getattr(winner, "connections", {}) or {}),
            "mean_fitness": self._best_fitness,
            "evolve_count": self._evolve_count,
            "last_evolve_at": self._last_evolve_at,
        })
        return {"evolved": True, "stats": self.stats()}

    def stats(self) -> Dict[str, Any]:
        nodes = len(getattr(self._best_genome, "nodes", {}) or {}) if self._best_genome is not None else 0
        conns = len(getattr(self._best_genome, "connections", {}) or {}) if self._best_genome is not None else 0
        fr = (self.fast_rejects / self.total_predictions * 100.0) if self.total_predictions else 0.0
        return {
            "available": self.available,
            "reason": self.reason,
            "generation": self._generation,
            "nodes": nodes,
            "connections": conns,
            "mean_fitness": self._best_fitness,
            "total_predictions": self.total_predictions,
            "fast_reject_rate_24h": fr,
            "evolve_count": self._evolve_count,
            "last_evolve_at": self._last_evolve_at,
            "buffer_size": len(self._buffer),
            "min_buffer_to_evolve": self.min_buffer_to_evolve,
            "snn_available": snn_layer.is_available(),
            "last_advice": list(self._last_advice),
            "feature_labels": list(FEATURE_LABELS),
        }
