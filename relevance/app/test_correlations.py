"""Tests for the correlation engine (correlations.py).

Проверяем: знак rho (позиция = ранг, 1 — лучший), p-value через t-приближение
совпадает со scipy-эталоном до 3 знаков, soft-fail при малой выборке,
пропуск константных / разреженных факторов, направление и уверенность.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import correlations  # noqa: E402


def test_t_two_sided_p_matches_scipy_reference():
    # scipy.stats.t.sf(2.121, 8)*2 ≈ 0.0666 ; t.sf(1.0,10)*2 ≈ 0.341
    assert abs(correlations._t_two_sided_p(2.121, 8) - 0.0666) < 0.001
    assert abs(correlations._t_two_sided_p(1.0, 10) - 0.3409) < 0.001


def test_spearman_perfect_positive():
    x = list(range(1, 11))
    rho, p = correlations.spearman(x, x)
    assert rho == 1.0
    assert p == 0.0


def test_spearman_perfect_negative():
    x = list(range(1, 11))
    y = list(range(10, 0, -1))
    rho, p = correlations.spearman(x, y)
    assert rho == -1.0


def test_spearman_handles_ties():
    x = [1, 1, 2, 2, 3, 3]
    y = [1, 2, 2, 3, 3, 4]
    rho, p = correlations.spearman(x, y)
    assert 0.5 < rho <= 1.0
    assert 0.0 <= p <= 1.0


def test_spearman_too_few_points():
    assert correlations.spearman([1, 2], [1, 2]) == (0.0, 1.0)


def test_kendall_tau_monotonic():
    x = list(range(1, 8))
    assert correlations.kendall_tau(x, x) == 1.0
    assert correlations.kendall_tau(x, list(reversed(x))) == -1.0


def _rows_factor_better_at_top(n=12):
    # factor 'bm25' decreases with position → better factor at top (pos 1)
    rows = []
    for pos in range(1, n + 1):
        rows.append({
            "serp_position": pos,
            "values": {"bm25": 100 - pos * 5, "const": 7, "sparse": None},
        })
    return rows


def test_factor_correlation_direction_and_sign():
    rows = _rows_factor_better_at_top()
    out = correlations.compute_factor_correlations(rows, ["bm25", "const", "sparse"])
    assert out["enabled"] is True
    facs = {r["factor"]: r for r in out["factor_correlations"]}
    # bm25 растёт → позиция улучшается → rho < 0 → higher_value_better_rank
    assert "bm25" in facs
    assert facs["bm25"]["rho"] < 0
    assert facs["bm25"]["direction"] == "higher_value_better_rank"
    # константный фактор пропускается
    assert "const" not in facs
    # разреженный (все None) фактор пропускается
    assert "sparse" not in facs


def test_soft_fail_when_not_enough_pages():
    rows = [{"serp_position": 1, "values": {"bm25": 1}},
            {"serp_position": 2, "values": {"bm25": 2}}]
    out = correlations.compute_factor_correlations(rows, ["bm25"], min_pages=5)
    assert out["enabled"] is False
    assert "not_enough_pages" in out["reason"]
    assert out["factor_correlations"] == []


def test_include_kendall_adds_tau():
    rows = _rows_factor_better_at_top()
    out = correlations.compute_factor_correlations(rows, ["bm25"], include_kendall=True)
    assert "kendall_tau" in out["factor_correlations"][0]


def test_sorted_by_absolute_significance():
    rows = []
    for pos in range(1, 13):
        rows.append({
            "serp_position": pos,
            "values": {
                "strong": 100 - pos * 8,           # near-perfect monotonic
                "weak": (pos % 3),                  # noisy / weak
            },
        })
    out = correlations.compute_factor_correlations(rows, ["weak", "strong"])
    facs = [r["factor"] for r in out["factor_correlations"]]
    # strong должен идти раньше weak (сортировка по |rho|)
    assert facs.index("strong") < facs.index("weak")
