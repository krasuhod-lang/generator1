"""Расчёт прогноза трафика: demand × CTR × scenario.

Комбинирует прогноз спроса, CTR-модель и сценарии позиций.
"""

import logging
from typing import Optional

import numpy as np
import pandas as pd

from .ctr_model import CTRModel
from .scenarios import ScenarioType, apply_scenario_to_forecast

logger = logging.getLogger("forecaster_py.traffic_calc")


def calculate_traffic_forecast(
    demand_forecast_df: pd.DataFrame,
    position_curve: np.ndarray,
    ctr_model: CTRModel,
    scenario: ScenarioType = "baseline",
    query_name: str = "unknown"
) -> pd.DataFrame:
    """Рассчитывает прогноз трафика для одного сценария.
    
    Args:
        demand_forecast_df: DataFrame с колонками date, yhat, yhat_lower, yhat_upper
        position_curve: массив ожидаемых позиций (длина = len(demand_forecast_df))
        ctr_model: обученная CTR модель
        scenario: тип сценария
        query_name: имя запроса для результата
    
    Returns:
        DataFrame с прогнозом трафика
    """
    if len(demand_forecast_df) != len(position_curve):
        raise ValueError(
            f"Длина прогноза ({len(demand_forecast_df)}) != "
            f"длине кривой позиций ({len(position_curve)})"
        )
    
    # Применяем сценарий к прогнозу спроса
    demand, demand_lower, demand_upper = apply_scenario_to_forecast(
        demand_forecast_df["yhat"].values,
        demand_forecast_df["yhat_lower"].values,
        demand_forecast_df["yhat_upper"].values,
        scenario,
    )

    # Спрос не может быть отрицательным — модели вроде Prophet/SARIMA
    # с короткими рядами могут давать отрицательные yhat_lower; обрезаем.
    demand       = np.maximum(demand,       0.0)
    demand_lower = np.maximum(demand_lower, 0.0)
    demand_upper = np.maximum(demand_upper, 0.0)

    # Предсказываем CTR для каждой позиции
    ctr = ctr_model.predict_ctr(position_curve)

    # Рассчитываем трафик (по построению неотрицателен, т.к. demand≥0 и ctr∈[0,1])
    traffic = demand * ctr
    traffic_lower = demand_lower * ctr
    traffic_upper = demand_upper * ctr
    
    result = pd.DataFrame({
        "date": demand_forecast_df["date"],
        "query": query_name,
        "scenario": scenario,
        "demand_forecast": demand,
        "demand_lower": demand_lower,
        "demand_upper": demand_upper,
        "position": position_curve,
        "ctr": ctr,
        "traffic_forecast": traffic,
        "traffic_lower": traffic_lower,
        "traffic_upper": traffic_upper
    })
    
    return result


def calculate_multi_scenario_forecast(
    demand_forecast_df: pd.DataFrame,
    position_curves: dict[ScenarioType, np.ndarray],
    ctr_model: CTRModel,
    query_name: str = "unknown"
) -> dict[ScenarioType, pd.DataFrame]:
    """Рассчитывает прогноз для всех сценариев.
    
    Args:
        demand_forecast_df: DataFrame с прогнозом спроса
        position_curves: словарь {scenario: position_array}
        ctr_model: обученная CTR модель
        query_name: имя запроса
    
    Returns:
        Словарь {scenario: forecast_df}
    """
    results = {}
    
    for scenario, position_curve in position_curves.items():
        try:
            forecast = calculate_traffic_forecast(
                demand_forecast_df,
                position_curve,
                ctr_model,
                scenario,
                query_name
            )
            results[scenario] = forecast
        except Exception as e:
            logger.error(f"Ошибка расчёта сценария {scenario}: {e}")
            raise
    
    return results


def aggregate_traffic_summary(
    forecasts: dict[ScenarioType, pd.DataFrame]
) -> dict:
    """Агрегирует сводную статистику по прогнозам.
    
    Args:
        forecasts: словарь {scenario: forecast_df}
    
    Returns:
        Словарь с суммарным трафиком по сценариям
    """
    summary = {}
    
    for scenario, df in forecasts.items():
        total_traffic = df["traffic_forecast"].sum()
        total_traffic_lower = df["traffic_lower"].sum()
        total_traffic_upper = df["traffic_upper"].sum()
        
        avg_position = df["position"].mean()
        avg_ctr = df["ctr"].mean()
        
        summary[scenario] = {
            "total_traffic": float(total_traffic),
            "total_traffic_lower": float(total_traffic_lower),
            "total_traffic_upper": float(total_traffic_upper),
            "avg_position": float(avg_position),
            "avg_ctr": float(avg_ctr),
            "months": len(df)
        }
    
    return summary
