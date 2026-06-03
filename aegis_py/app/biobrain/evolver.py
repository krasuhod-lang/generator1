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
    def __init__(self, cfg_path: Optional[Path] = None, *, min_buffer_to_evolve: int = 32,
                 complexity_lambda: float = 0.0015, complexity_scale: float = 60.0):
        self.available = _OK
        self.reason = _REASON
        self.total_predictions = 0
        self.fast_rejects = 0
        self.min_buffer_to_evolve = max(1, int(min_buffer_to_evolve))
        # B6: давление против разрастания связей. λ * (nodes+conns)/scale
        # вычитается из base fitness (1 - mse). Значения подобраны мягкими,
        # чтобы NEAT всё ещё мог расти, но только когда это реально снижает
        # ошибку на hold-out.
        self.complexity_lambda = float(complexity_lambda)
        self.complexity_scale = float(complexity_scale)
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

    def _build_advice(self, features: List[float], score: float,
                      attribution: Optional[Dict[str, float]] = None) -> List[str]:
        """Deterministic, ranked human-readable hints for the weakest dims.

        When ``attribution`` is provided (numerical contribution of every
        feature to the predicted score, see :meth:`_compute_attribution`),
        the ranking is replaced by «куда бить точечно»: dimensions with the
        most *negative* contribution to score come first. Statics rules
        (`_ADVICE_RULES`) remain as fallback when attribution is unavailable
        (e.g. genome not yet trained).
        """
        # ── B3: gradient-style attribution path (preferred when available) ─
        if attribution and any(abs(v) > 1e-9 for v in attribution.values()):
            ranked: List[Tuple[float, str]] = []
            for idx, (label, threshold, message) in enumerate(_ADVICE_RULES):
                if idx >= len(features):
                    break
                contrib = float(attribution.get(label, 0.0))
                # Negative contribution = эта фича сейчас тянет score вниз.
                # Чем ниже (более отрицательная) — тем выше приоритет.
                if contrib < 0:
                    ranked.append((-contrib, message))
            if ranked:
                ranked.sort(key=lambda x: x[0], reverse=True)
                return [m for _, m in ranked[:3]]

        # ── Fallback: статические правила по абсолютному значению фичи ──
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

    def _activate_score(self, vals: List[float]) -> float:
        """Internal: NEAT activation → sigmoid score in [0,1]. 0.5 if no genome."""
        if not self.available or self._best_genome is None:
            return 0.5
        try:
            net = self._build_net(self._best_genome)
            out = net.activate(vals)
            return 1.0 / (1.0 + math.exp(-float(out[0])))
        except Exception:
            return 0.5

    def _compute_attribution(self, vals: List[float], base_score: float,
                             *, eps: float = 0.05) -> Dict[str, float]:
        """Per-feature contribution via central numerical derivative.

        For each input dimension perturb by ±eps, average the score delta —
        positive value means «эта фича сейчас тащит score вверх», negative
        means «тянет вниз». Cheap (2*N forward passes) and works on any
        feedforward NEAT genome. When genome is unavailable returns zeros.
        """
        if not self.available or self._best_genome is None:
            return {label: 0.0 for label in FEATURE_LABELS}
        result: Dict[str, float] = {}
        for idx, label in enumerate(FEATURE_LABELS):
            if idx >= len(vals):
                result[label] = 0.0
                continue
            original = vals[idx]
            up = list(vals); up[idx] = max(0.0, min(1.0, original + eps))
            dn = list(vals); dn[idx] = max(0.0, min(1.0, original - eps))
            s_up = self._activate_score(up)
            s_dn = self._activate_score(dn)
            # Симметричная производная * (current - 0.5) даёт «вклад относительно
            # нейтрального уровня»: если score падает при увеличении фичи —
            # contrib < 0 → точка для удара.
            grad = (s_up - s_dn) / (2.0 * max(1e-6, eps))
            # Контрибуция = grad * (1 - val) если val<0.5, иначе grad * val.
            # Упрощение: contrib = grad * (val - 0.5), знаковое.
            contrib = grad * (original - 0.5)
            result[label] = float(contrib)
        return result

    def predict(self, *, features: Optional[Iterable[float]] = None, text: Optional[str] = None,
                signals: Optional[Dict[str, Any]] = None,
                threshold_fast_reject: float = 0.35) -> Dict[str, Any]:
        vals = list(features) if features is not None else extract_features(text or "", signals=signals)
        if not vals:
            vals = [0.5] * 8

        score = self._activate_score(vals)

        confidence = snn_layer.snn_confidence(vals)
        # B3: attribution — точечный рейтинг «куда бить» (per-feature).
        attribution = self._compute_attribution(vals, score)
        advice = self._build_advice(vals, score, attribution=attribution)
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
            "attribution": attribution,
            "features": vals,
            "feature_labels": list(FEATURE_LABELS),
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

        # ── B6: hold-out split — последние 10% буфера, минимум 4 примера ──
        all_samples = list(self._buffer)
        holdout_n = max(4, int(len(all_samples) * 0.1))
        holdout = all_samples[-holdout_n:]
        train_pool = all_samples[:-holdout_n] if len(all_samples) - holdout_n >= eval_batch else all_samples
        sample = train_pool[-eval_batch:]

        # Сохраняем mae предыдущего лучшего на hold-out для anti-regression.
        prev_holdout_mae = self._holdout_mae(self._best_genome, holdout) \
            if self._best_genome is not None else None

        # ── B6: complexity_penalty штрафует разрастание связей ──
        # fitness = (1 - mse) - λ * (nodes + connections) / scale
        # Без давления NEAT в тестовых батчах склонен раздувать топологию ради
        # подгонки шума, поэтому держим λ небольшим (см. complexity_lambda).
        lam = float(self.complexity_lambda)
        scale = max(1.0, float(self.complexity_scale))

        def fitness_fn(genomes, config):
            for _, genome in genomes:
                net = neat.nn.FeedForwardNetwork.create(genome, config)
                mse = 0.0
                for feat, target in sample:
                    out = net.activate(feat)
                    pred = 1.0 / (1.0 + math.exp(-float(out[0])))
                    mse += (pred - target) ** 2
                mse /= max(1, len(sample))
                base = max(0.0, 1.0 - mse)
                size = (len(getattr(genome, "nodes", {}) or {}) +
                        len(getattr(genome, "connections", {}) or {}))
                penalty = lam * (size / scale)
                genome.fitness = max(0.0, base - penalty)

        winner = self._population.run(fitness_fn, 1)

        # ── B6: anti-regression на hold-out — откат если новый хуже ──
        new_holdout_mae = self._holdout_mae(winner, holdout)
        rolled_back = False
        if (prev_holdout_mae is not None
                and new_holdout_mae is not None
                and new_holdout_mae > prev_holdout_mae + 1e-3):
            # Новый чемпион хуже на отложенной выборке — откатываемся.
            rolled_back = True
        else:
            self._best_genome = winner
            self._best_fitness = float(getattr(winner, "fitness", 0.0) or 0.0)
            storage.save_best_genome(winner)

        self._generation += 1
        self._evolve_count += 1
        self._last_evolve_at = _now_iso()
        nodes = len(getattr(self._best_genome, "nodes", {}) or {}) if self._best_genome else 0
        conns = len(getattr(self._best_genome, "connections", {}) or {}) if self._best_genome else 0
        storage.save_state({
            "generation": self._generation,
            "nodes": nodes,
            "connections": conns,
            "mean_fitness": self._best_fitness,
            "evolve_count": self._evolve_count,
            "last_evolve_at": self._last_evolve_at,
        })

        # ── B6: persist generation snapshot for Node-side versioning. ──
        gen_entry = {
            "ts": self._last_evolve_at,
            "generation": self._generation,
            "evolve_count": self._evolve_count,
            "nodes": nodes,
            "connections": conns,
            "mean_fitness": self._best_fitness,
            "holdout_mae": new_holdout_mae,
            "prev_holdout_mae": prev_holdout_mae,
            "buffer_size": len(self._buffer),
            "complexity_lambda": lam,
            "rolled_back": rolled_back,
        }
        storage.append_generation(gen_entry)

        return {"evolved": True, "rolled_back": rolled_back, "stats": self.stats(),
                "generation_entry": gen_entry}

    def _holdout_mae(self, genome, holdout: List[Tuple[List[float], float]]) -> Optional[float]:
        """Mean absolute error of ``genome`` on a hold-out set (None if N/A)."""
        if not self.available or genome is None or not holdout:
            return None
        try:
            net = neat.nn.FeedForwardNetwork.create(genome, self._config)
        except Exception:
            return None
        try:
            err = 0.0
            for feat, target in holdout:
                out = net.activate(feat)
                pred = 1.0 / (1.0 + math.exp(-float(out[0])))
                err += abs(pred - target)
            return err / max(1, len(holdout))
        except Exception:
            return None

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
