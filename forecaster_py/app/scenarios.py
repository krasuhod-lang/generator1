"""Сценарии роста позиций: pessimistic, baseline, optimistic.

Генерирует кривые изменения позиций во времени.
"""

import logging
from typing import Literal

import numpy as np

from .config import CONFIG

logger = logging.getLogger("forecaster_py.scenarios")

ScenarioType = Literal["pessimistic", "baseline", "optimistic"]
ShapeType = Literal["linear", "ease_out", "ease_in"]


def build_position_curve(
    from_pos: float,
    to_pos: float,
    horizon_months: int,
    shape: ShapeType = "linear"
) -> np.ndarray:
    """Строит кривую изменения позиций от from_pos до to_pos за horizon_months.
    
    Args:
        from_pos: начальная позиция
        to_pos: целевая позиция
        horizon_months: горизонт в месяцах
        shape: форма кривой (linear, ease_out, ease_in)
    
    Returns:
        Массив позиций длиной horizon_months
    """
    if horizon_months <= 0:
        raise ValueError("horizon_months должен быть > 0")
    
    t = np.linspace(0, 1, horizon_months)
    
    if shape == "linear":
        progress = t
    elif shape == "ease_out":
        # Быстрый старт, замедление в конце
        progress = 1 - (1 - t) ** 2
    elif shape == "ease_in":
        # Медленный старт, ускорение в конце
        progress = t ** 2
    else:
        raise ValueError(f"Неподдерживаемая форма кривой: {shape}")
    
    positions = from_pos + (to_pos - from_pos) * progress
    
    return positions


def generate_scenarios(
    from_pos: float,
    to_pos: float,
    horizon_months: int,
    shape: ShapeType = "ease_out"
) -> dict[ScenarioType, np.ndarray]:
    """Генерирует три сценария роста позиций.
    
    Args:
        from_pos: начальная позиция
        to_pos: целевая позиция
        horizon_months: горизонт в месяцах
        shape: форма базовой кривой
    
    Returns:
        Словарь {scenario_name: positions_array}
    """
    # Baseline: точно как задано
    baseline = build_position_curve(from_pos, to_pos, horizon_months, shape)
    
    # Pessimistic: достигаем целевой позиции на 1.5× медленнее
    # Это значит, что в середине пути мы ещё ближе к начальной позиции
    slowdown = CONFIG.scenario_pessimistic_slowdown
    t = np.linspace(0, 1, horizon_months)
    t_slow = np.clip(t / slowdown, 0, 1)
    
    if shape == "linear":
        progress_slow = t_slow
    elif shape == "ease_out":
        progress_slow = 1 - (1 - t_slow) ** 2
    elif shape == "ease_in":
        progress_slow = t_slow ** 2
    else:
        progress_slow = t_slow
    
    pessimistic = from_pos + (to_pos - from_pos) * progress_slow
    
    # Optimistic: достигаем на 0.75× быстрее
    speedup = CONFIG.scenario_optimistic_speedup
    t_fast = np.clip(t / speedup, 0, 1)
    
    if shape == "linear":
        progress_fast = t_fast
    elif shape == "ease_out":
        progress_fast = 1 - (1 - t_fast) ** 2
    elif shape == "ease_in":
        progress_fast = t_fast ** 2
    else:
        progress_fast = t_fast
    
    optimistic = from_pos + (to_pos - from_pos) * progress_fast
    
    return {
        "pessimistic": pessimistic,
        "baseline": baseline,
        "optimistic": optimistic
    }


def apply_scenario_to_forecast(
    demand_forecast: np.ndarray,
    demand_lower: np.ndarray,
    demand_upper: np.ndarray,
    scenario: ScenarioType
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Применяет сценарий к прогнозу спроса (выбирает нужные границы).
    
    Args:
        demand_forecast: базовый прогноз (yhat)
        demand_lower: нижняя граница (yhat_lower)
        demand_upper: верхняя граница (yhat_upper)
        scenario: тип сценария
    
    Returns:
        Кортеж (demand, lower, upper) для данного сценария
    """
    if scenario == "baseline":
        return demand_forecast, demand_lower, demand_upper
    elif scenario == "pessimistic":
        # Используем нижнюю границу как основной прогноз
        # и дополнительно уменьшаем разброс
        margin = (demand_forecast - demand_lower) * 0.5
        return demand_lower, demand_lower - margin, demand_forecast
    elif scenario == "optimistic":
        # Используем верхнюю границу как основной прогноз
        margin = (demand_upper - demand_forecast) * 0.5
        return demand_upper, demand_forecast, demand_upper + margin
    else:
        raise ValueError(f"Неизвестный сценарий: {scenario}")
