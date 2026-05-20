"""Тесты traffic_calc модуля."""

import numpy as np
import pandas as pd
import pytest

from forecaster_py.app.ctr_model import CTRModel
from forecaster_py.app.traffic_calc import (
    calculate_traffic_forecast,
    calculate_multi_scenario_forecast,
    aggregate_traffic_summary
)


def test_calculate_traffic_forecast(ctr_training_data):
    """Проверяет расчёт прогноза трафика."""
    # Создаём прогноз спроса
    demand_df = pd.DataFrame({
        "date": pd.date_range("2024-01-01", periods=6, freq="MS"),
        "yhat": [1000, 1100, 1200, 1300, 1400, 1500],
        "yhat_lower": [900, 1000, 1100, 1200, 1300, 1400],
        "yhat_upper": [1100, 1200, 1300, 1400, 1500, 1600]
    })
    
    # Кривая позиций
    positions = np.array([10, 8, 7, 6, 5, 4])
    
    # CTR модель
    ctr_model = CTRModel()
    ctr_model.fit(ctr_training_data)
    
    # Расчёт
    forecast = calculate_traffic_forecast(
        demand_df,
        positions,
        ctr_model,
        scenario="baseline",
        query_name="test"
    )
    
    assert len(forecast) == 6
    assert "traffic_forecast" in forecast.columns
    assert "ctr" in forecast.columns
    assert (forecast["traffic_forecast"] > 0).all()


def test_calculate_multi_scenario(ctr_training_data):
    """Проверяет расчёт для нескольких сценариев."""
    demand_df = pd.DataFrame({
        "date": pd.date_range("2024-01-01", periods=6, freq="MS"),
        "yhat": [1000, 1100, 1200, 1300, 1400, 1500],
        "yhat_lower": [900, 1000, 1100, 1200, 1300, 1400],
        "yhat_upper": [1100, 1200, 1300, 1400, 1500, 1600]
    })
    
    position_curves = {
        "pessimistic": np.array([10, 9, 8, 8, 7, 7]),
        "baseline": np.array([10, 8, 7, 6, 5, 4]),
        "optimistic": np.array([10, 7, 5, 4, 3, 3])
    }
    
    ctr_model = CTRModel()
    ctr_model.fit(ctr_training_data)
    
    forecasts = calculate_multi_scenario_forecast(
        demand_df,
        position_curves,
        ctr_model,
        "test"
    )
    
    assert len(forecasts) == 3
    assert "pessimistic" in forecasts
    assert "baseline" in forecasts
    assert "optimistic" in forecasts


def test_aggregate_summary(ctr_training_data):
    """Проверяет агрегацию сводки."""
    demand_df = pd.DataFrame({
        "date": pd.date_range("2024-01-01", periods=6, freq="MS"),
        "yhat": [1000] * 6,
        "yhat_lower": [900] * 6,
        "yhat_upper": [1100] * 6
    })
    
    position_curves = {
        "baseline": np.array([5, 5, 5, 5, 5, 5]),
    }
    
    ctr_model = CTRModel()
    ctr_model.fit(ctr_training_data)
    
    forecasts = calculate_multi_scenario_forecast(
        demand_df,
        position_curves,
        ctr_model,
        "test"
    )
    
    summary = aggregate_traffic_summary(forecasts)
    
    assert "baseline" in summary
    assert "total_traffic" in summary["baseline"]
    assert summary["baseline"]["total_traffic"] > 0
    assert summary["baseline"]["months"] == 6
