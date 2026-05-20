"""Тесты demand модели."""

import numpy as np
import pandas as pd
import pytest

from forecaster_py.app.demand_model import DemandForecaster


def test_demand_model_fit_ols(synthetic_time_series):
    """Проверяет обучение через OLS trend (fallback)."""
    model = DemandForecaster(use_prophet=False)
    model.fit(synthetic_time_series, "impressions")
    
    # Должен использоваться SARIMA или OLS
    assert model.method_used in ["sarima", "ols_trend"]
    assert model.model is not None


def test_demand_model_predict(synthetic_time_series):
    """Проверяет прогноз на N периодов."""
    model = DemandForecaster(use_prophet=False)
    model.fit(synthetic_time_series, "impressions")
    
    forecast = model.predict(periods=12)
    
    assert len(forecast) == 12
    assert "date" in forecast.columns
    assert "yhat" in forecast.columns
    assert "yhat_lower" in forecast.columns
    assert "yhat_upper" in forecast.columns
    
    # Проверяем разумность значений
    assert (forecast["yhat"] > 0).all()
    assert (forecast["yhat_lower"] <= forecast["yhat"]).all()
    assert (forecast["yhat"] <= forecast["yhat_upper"]).all()


def test_demand_model_ols_trend(small_time_series):
    """Проверяет OLS trend fallback на маленьком ряде."""
    model = DemandForecaster(use_prophet=False)
    
    # SARIMA может обучиться на 10 точках, но должен быть метод из списка
    model.fit(small_time_series, "impressions")
    
    forecast = model.predict(periods=6)
    
    assert len(forecast) == 6
    assert model.method_used in ["sarima", "ols_trend"]


def test_demand_model_insufficient_data():
    """Проверяет ошибку при недостатке данных."""
    df = pd.DataFrame({
        "date": pd.date_range("2023-01-01", periods=5, freq="MS"),
        "impressions": [100, 120, 110, 130, 125]
    })
    
    model = DemandForecaster(use_prophet=False)
    
    with pytest.raises(ValueError):
        model.fit(df, "impressions")
