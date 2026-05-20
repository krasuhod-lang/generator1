"""Конфигурация forecaster_py.

Все настройки хардкожены (паттерн deepFreeze из ТЗ).
Единственное исключение: FORECASTER_INTERNAL_TOKEN читается из env для auth.
"""

from dataclasses import dataclass, field
from typing import Dict


@dataclass(frozen=True)
class ForecasterConfig:
    """Замороженная конфигурация с дефолтами."""

    # Пределы данных
    min_history_points: int = 10
    max_history_points: int = 200000
    
    # Prophet/SARIMA параметры
    default_horizon_months: int = 12
    prophet_interval_width: float = 0.80  # 80% CI
    sarima_order: tuple = (1, 1, 1)
    sarima_seasonal_order: tuple = (1, 1, 1, 12)
    
    # CTR модель
    ctr_min_data_points: int = 5
    ctr_position_range: tuple = (1.0, 10.0)
    
    # Сценарии
    scenario_pessimistic_slowdown: float = 1.5
    scenario_optimistic_speedup: float = 0.75
    
    # Preprocessing
    anomaly_iqr_multiplier: float = 3.0
    rolling_window: int = 7
    
    # Экспорт
    export_max_rows: int = 100000
    
    # Industry-average CTR для fallback (позиции 1-10)
    default_ctr_curve: Dict[int, float] = field(default_factory=lambda: {
        1: 0.30, 2: 0.15, 3: 0.10, 4: 0.07, 5: 0.05,
        6: 0.04, 7: 0.03, 8: 0.025, 9: 0.02, 10: 0.015
    })


# Глобальный экземпляр
CONFIG = ForecasterConfig()
