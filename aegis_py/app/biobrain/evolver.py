"""BioBrain evolver (NEAT)."""

from __future__ import annotations

import collections
import math
from pathlib import Path
from typing import Any, Deque, Dict, Iterable, List, Optional, Tuple

from . import storage
from .feature_vector import extract_features

_REASON = None
try:  # pragma: no cover
    import neat  # type: ignore
    _OK = True
except Exception as e:  # pragma: no cover
    neat = None  # type: ignore
    _OK = False
    _REASON = f"neat_missing: {e.__class__.__name__}"


class BioBrainEvolver:
    def __init__(self, cfg_path: Optional[Path] = None):
        self.available = _OK
        self.reason = _REASON
        self.total_predictions = 0
        self.fast_rejects = 0
        self._buffer: Deque[Tuple[List[float], float]] = collections.deque(maxlen=256)
        self._generation = 0
        self._best_genome = None
        self._best_fitness = 0.0
        self._cfg_path = cfg_path or (Path(__file__).parent / "config_neat.ini")
        self._config = None
        self._population = None

        st = storage.load_state()
        self._generation = int(st.get("generation", 0) or 0)
        self._best_fitness = float(st.get("mean_fitness", 0.0) or 0.0)

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

    def predict(self, *, features: Optional[Iterable[float]] = None, text: Optional[str] = None,
                threshold_fast_reject: float = 0.35) -> Dict[str, Any]:
        vals = list(features) if features is not None else extract_features(text or "")
        if not vals:
            vals = [0.5] * 8

        score = 0.5
        if self.available and self._best_genome is not None:
            try:
                out = self._build_net(self._best_genome).activate(vals)
                score = 1.0 / (1.0 + math.exp(-float(out[0])))
            except Exception:
                score = 0.5

        self.total_predictions += 1
        gate = "fast_reject" if score < threshold_fast_reject else "pass"
        if gate == "fast_reject":
            self.fast_rejects += 1

        return {
            "score": score,
            "gate": gate,
            "features": vals,
            "genome": self.stats(),
        }

    def record_outcome(self, *, features: Iterable[float], real_spq_overall: float) -> Dict[str, Any]:
        vals = [float(x) for x in features]
        target = max(0.0, min(1.0, float(real_spq_overall) / 100.0))
        self._buffer.append((vals, target))
        return {"stored": True, "buffer": len(self._buffer)}

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
        self._best_fitness = float(getattr(winner, "fitness", 0.0) or 0.0)
        storage.save_best_genome(winner)
        storage.save_state({
            "generation": self._generation,
            "nodes": len(getattr(winner, "nodes", {}) or {}),
            "connections": len(getattr(winner, "connections", {}) or {}),
            "mean_fitness": self._best_fitness,
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
        }
