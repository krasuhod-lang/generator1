"""Тесты scenarios модуля."""

import numpy as np
import pytest

from forecaster_py.app.scenarios import (
    build_position_curve,
    generate_scenarios,
    apply_scenario_to_forecast
)


def test_build_position_curve_linear():
    """Проверяет линейную кривую позиций."""
    curve = build_position_curve(15.0, 3.0, 12, shape="linear")
    
    assert len(curve) == 12
    assert curve[0] == pytest.approx(15.0, abs=0.1)
    assert curve[-1] == pytest.approx(3.0, abs=0.1)
    # Линейное убывание
    assert all(curve[i] >= curve[i+1] for i in range(len(curve)-1))


def test_build_position_curve_ease_out():
    """Проверяет ease_out кривую."""
    curve = build_position_curve(15.0, 3.0, 12, shape="ease_out")
    
    assert len(curve) == 12
    assert curve[0] == pytest.approx(15.0, abs=0.1)
    assert curve[-1] == pytest.approx(3.0, abs=0.1)


def test_generate_scenarios():
    """Проверяет генерацию трёх сценариев."""
    scenarios = generate_scenarios(15.0, 3.0, 12, shape="linear")
    
    assert "pessimistic" in scenarios
    assert "baseline" in scenarios
    assert "optimistic" in scenarios
    
    assert len(scenarios["pessimistic"]) == 12
    assert len(scenarios["baseline"]) == 12
    assert len(scenarios["optimistic"]) == 12
    
    # Pessimistic должен быть медленнее
    # В середине пути pessimistic ближе к начальной позиции
    mid = 6
    assert scenarios["pessimistic"][mid] > scenarios["baseline"][mid]
    assert scenarios["optimistic"][mid] < scenarios["baseline"][mid]


def test_apply_scenario_baseline():
    """Проверяет применение baseline сценария."""
    demand = np.array([1000, 1100, 1200])
    lower = np.array([900, 1000, 1100])
    upper = np.array([1100, 1200, 1300])
    
    d, l, u = apply_scenario_to_forecast(demand, lower, upper, "baseline")
    
    np.testing.assert_array_equal(d, demand)
    np.testing.assert_array_equal(l, lower)
    np.testing.assert_array_equal(u, upper)


def test_apply_scenario_pessimistic():
    """Проверяет применение pessimistic сценария."""
    demand = np.array([1000, 1100, 1200])
    lower = np.array([900, 1000, 1100])
    upper = np.array([1100, 1200, 1300])
    
    d, l, u = apply_scenario_to_forecast(demand, lower, upper, "pessimistic")
    
    # Pessimistic использует нижнюю границу
    np.testing.assert_array_equal(d, lower)
    assert all(d <= demand)


def test_apply_scenario_optimistic():
    """Проверяет применение optimistic сценария."""
    demand = np.array([1000, 1100, 1200])
    lower = np.array([900, 1000, 1100])
    upper = np.array([1100, 1200, 1300])
    
    d, l, u = apply_scenario_to_forecast(demand, lower, upper, "optimistic")
    
    # Optimistic использует верхнюю границу
    np.testing.assert_array_equal(d, upper)
    assert all(d >= demand)
