"""SERP factor correlation engine (Phase 1 of Relevance Analyzer 2.0).

Считает связь каждого числового фактора страницы с её позицией в выдаче
(SERP position 1..N). По умолчанию — ранговая корреляция Спирмена (rho) с
p-value; опционально — Kendall tau как robustness-check.

ВАЖНО (детерминированный baseline, см. ТЗ §12): модуль работает БЕЗ scipy /
pandas. Если `scipy` установлен — используем `scipy.stats` для более точных
p-value; если нет — считаем rho и p-value чистым Python (t-приближение через
регуляризованную неполную бета-функцию, как в Numerical Recipes). Это
позволяет держать прод-образ лёгким и не падать в тестах без scipy.

Контракт:
    compute_factor_correlations(rows, factor_names, *, method=..., ...) -> dict
        rows: List[{ "serp_position": int, "values": {factor: float|None} }]
    → {
        "enabled": True,
        "method": "spearman",
        "backend": "scipy" | "pure_python",
        "n_pages": 12,
        "factor_correlations": [ {factor, rho, p_value, direction,
                                  interpretation, confidence, n, kendall_tau?}, ... ],
      }

Соглашение о знаке (критично для интерпретации): позиция = ранг, где 1 —
лучшая. Поэтому **отрицательная** корреляция «фактор ↔ позиция» означает, что
рост фактора сопутствует УЛУЧШЕНИЮ позиции (меньше номер). Мы переводим это в
человекочитаемое `direction`:
    rho < 0 → "higher_value_better_rank"  (больше значение → выше в топе)
    rho > 0 → "higher_value_worse_rank"   (больше значение → ниже в топе)
"""

from __future__ import annotations

import math
from typing import Dict, List, Optional, Sequence, Tuple

# Опциональный scipy — только для более точных p-value. Отсутствие не критично.
try:  # pragma: no cover — наличие scipy зависит от образа
    from scipy import stats as _scipy_stats  # type: ignore
    _SCIPY_AVAILABLE = True
except Exception:  # pragma: no cover
    _scipy_stats = None  # type: ignore
    _SCIPY_AVAILABLE = False


# ── Ранжирование с усреднением тай-групп (как в Спирмене) ─────────────────────

def _rankdata(values: Sequence[float]) -> List[float]:
    """Средние ранги (1-based) с усреднением связок (ties)."""
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    n = len(values)
    while i < n:
        j = i
        while j + 1 < n and values[order[j + 1]] == values[order[i]]:
            j += 1
        avg_rank = (i + j) / 2.0 + 1.0  # средний ранг для связки [i..j]
        for k in range(i, j + 1):
            ranks[order[k]] = avg_rank
        i = j + 1
    return ranks


def _pearson(x: Sequence[float], y: Sequence[float]) -> float:
    n = len(x)
    if n == 0:
        return 0.0
    mx = sum(x) / n
    my = sum(y) / n
    num = sum((a - mx) * (b - my) for a, b in zip(x, y))
    dx = math.sqrt(sum((a - mx) ** 2 for a in x))
    dy = math.sqrt(sum((b - my) ** 2 for b in y))
    if dx == 0 or dy == 0:
        return 0.0
    return num / (dx * dy)


# ── Student-t survival function через неполную бета-функцию ────────────────────
# Нужна для p-value Спирмена без scipy. Реализация betacf/betai — стандартная
# (Numerical Recipes), точности с избытком хватает для отчётного p-value.

def _betacf(a: float, b: float, x: float) -> float:
    MAXIT = 200
    EPS = 3.0e-12
    FPMIN = 1.0e-300
    qab = a + b
    qap = a + 1.0
    qam = a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    if abs(d) < FPMIN:
        d = FPMIN
    d = 1.0 / d
    h = d
    for m in range(1, MAXIT + 1):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        if abs(d) < FPMIN:
            d = FPMIN
        c = 1.0 + aa / c
        if abs(c) < FPMIN:
            c = FPMIN
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        if abs(d) < FPMIN:
            d = FPMIN
        c = 1.0 + aa / c
        if abs(c) < FPMIN:
            c = FPMIN
        d = 1.0 / d
        de = d * c
        h *= de
        if abs(de - 1.0) < EPS:
            break
    return h


def _betai(a: float, b: float, x: float) -> float:
    """Регуляризованная неполная бета-функция I_x(a, b)."""
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    ln_beta = (
        math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b)
        + a * math.log(x) + b * math.log(1.0 - x)
    )
    bt = math.exp(ln_beta)
    if x < (a + 1.0) / (a + b + 2.0):
        return bt * _betacf(a, b, x) / a
    return 1.0 - bt * _betacf(b, a, 1.0 - x) / b


def _t_two_sided_p(t: float, df: float) -> float:
    """Двусторонний p-value для t-статистики со степенями свободы df."""
    if df <= 0:
        return 1.0
    x = df / (df + t * t)
    # I_x(df/2, 1/2) = вероятность в хвостах (двусторонняя).
    return max(0.0, min(1.0, _betai(df / 2.0, 0.5, x)))


# ── Спирмен и Кендалл ─────────────────────────────────────────────────────────

def spearman(x: Sequence[float], y: Sequence[float]) -> Tuple[float, float]:
    """Возвращает (rho, p_value). Пусто/константа → (0.0, 1.0)."""
    n = len(x)
    if n < 3 or len(y) != n:
        return 0.0, 1.0
    if _SCIPY_AVAILABLE:  # pragma: no cover — путь для прод-образа со scipy
        try:
            res = _scipy_stats.spearmanr(x, y)
            rho = float(res.correlation if hasattr(res, "correlation") else res[0])
            p = float(res.pvalue if hasattr(res, "pvalue") else res[1])
            if math.isnan(rho):
                return 0.0, 1.0
            return round(rho, 6), round(p, 6)
        except Exception:
            pass
    rx = _rankdata(x)
    ry = _rankdata(y)
    rho = _pearson(rx, ry)
    if abs(rho) >= 1.0:
        return round(rho, 6), 0.0
    # t-приближение для p-value (валидно при n ≳ 10, но разумно и меньше).
    t = rho * math.sqrt((n - 2) / max(1e-12, (1.0 - rho * rho)))
    p = _t_two_sided_p(t, n - 2)
    return round(rho, 6), round(p, 6)


def kendall_tau(x: Sequence[float], y: Sequence[float]) -> float:
    """Kendall tau-b (с поправкой на связки). Только точечная оценка."""
    n = len(x)
    if n < 3 or len(y) != n:
        return 0.0
    concordant = 0
    discordant = 0
    tx = 0
    ty = 0
    for i in range(n):
        for j in range(i + 1, n):
            dx = x[i] - x[j]
            dy = y[i] - y[j]
            s = dx * dy
            if s > 0:
                concordant += 1
            elif s < 0:
                discordant += 1
            else:
                if dx == 0:
                    tx += 1
                if dy == 0:
                    ty += 1
    n0 = n * (n - 1) / 2.0
    denom = math.sqrt(max(1e-12, (n0 - tx) * (n0 - ty)))
    if denom == 0:
        return 0.0
    return round((concordant - discordant) / denom, 6)


# ── Интерпретация ─────────────────────────────────────────────────────────────

def _strength_label(abs_rho: float) -> str:
    if abs_rho >= 0.7:
        return "сильная"
    if abs_rho >= 0.4:
        return "умеренная"
    if abs_rho >= 0.2:
        return "слабая"
    return "незначимая"


def _confidence(p_value: float, n: int, abs_rho: float) -> str:
    """Комбинированная уверенность: значимость + размер выборки + сила."""
    if n < 5:
        return "low"
    if p_value < 0.05 and n >= 10 and abs_rho >= 0.3:
        return "high"
    if p_value < 0.1 and abs_rho >= 0.2:
        return "medium"
    return "low"


def _interpretation(factor: str, rho: float, p_value: float, n: int) -> str:
    abs_rho = abs(rho)
    strength = _strength_label(abs_rho)
    if abs_rho < 0.2 or p_value >= 0.1:
        return (
            f"«{factor}»: значимой связи с позицией не обнаружено "
            f"(rho={rho:+.2f}, p={p_value:.3f}, n={n})."
        )
    if rho < 0:
        # больше значение → меньше номер позиции → выше в топе
        return (
            f"«{factor}»: {strength} связь — чем больше значение, тем ВЫШЕ "
            f"позиция в топе (rho={rho:+.2f}, p={p_value:.3f}, n={n})."
        )
    return (
        f"«{factor}»: {strength} связь — чем больше значение, тем НИЖЕ "
        f"позиция в топе (rho={rho:+.2f}, p={p_value:.3f}, n={n})."
    )


def compute_factor_correlations(
    rows: List[dict],
    factor_names: Sequence[str],
    *,
    method: str = "spearman",
    include_kendall: bool = False,
    min_pages: int = 5,
    min_non_null: int = 5,
) -> dict:
    """Считает корреляции факторов с SERP-позицией.

    Args:
        rows: список {"serp_position": int, "values": {factor: float|None}}.
        factor_names: какие факторы корреллировать (порядок сохраняем в fallback).
        method: "spearman" (по умолчанию) — влияет на основной rho.
        include_kendall: если True — добавляем kendall_tau как robustness-check.
        min_pages: минимум страниц с валидной позицией, иначе enabled=False.
        min_non_null: минимум непустых значений фактора, иначе фактор пропускаем.

    Возвращает soft-fail dict (никогда не бросает).
    """
    valid = [
        r for r in (rows or [])
        if r and isinstance(r.get("serp_position"), (int, float))
        and r.get("serp_position") is not None
    ]
    n_pages = len(valid)
    if n_pages < min_pages:
        return {
            "enabled": False,
            "reason": f"not_enough_pages: {n_pages} < {min_pages}",
            "method": method,
            "backend": "scipy" if _SCIPY_AVAILABLE else "pure_python",
            "n_pages": n_pages,
            "factor_correlations": [],
        }

    positions = [float(r["serp_position"]) for r in valid]
    out_rows: List[dict] = []

    for factor in factor_names:
        pairs = [
            (float(r["values"][factor]), pos)
            for r, pos in zip(valid, positions)
            if isinstance((r.get("values") or {}).get(factor), (int, float))
            and r["values"][factor] is not None
        ]
        if len(pairs) < min_non_null:
            continue
        fx = [p[0] for p in pairs]
        py = [p[1] for p in pairs]
        # Константный фактор — корреляция не определена, пропускаем.
        if len(set(fx)) < 2:
            continue
        rho, p_value = spearman(fx, py)
        row = {
            "factor":         factor,
            "rho":            rho,
            "p_value":        p_value,
            "n":              len(pairs),
            "direction":      ("higher_value_better_rank" if rho < 0
                               else "higher_value_worse_rank"),
            "interpretation": _interpretation(factor, rho, p_value, len(pairs)),
            "confidence":     _confidence(p_value, len(pairs), abs(rho)),
        }
        if include_kendall:
            row["kendall_tau"] = kendall_tau(fx, py)
        out_rows.append(row)

    # Сортировка по абсолютной значимости: сильная и значимая связь — вверх.
    out_rows.sort(key=lambda r: (abs(r["rho"]), -r["p_value"]), reverse=True)

    return {
        "enabled": True,
        "method": method,
        "backend": "scipy" if _SCIPY_AVAILABLE else "pure_python",
        "n_pages": n_pages,
        "factor_correlations": out_rows,
    }
