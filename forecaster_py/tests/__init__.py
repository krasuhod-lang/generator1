"""Pytest conftest с фикстурами для тестов."""

import numpy as np
import pandas as pd
import pytest


@pytest.fixture
def synthetic_time_series():
    """Синтетический временной ряд для тестов (24 месяца)."""
    dates = pd.date_range("2022-01-01", periods=24, freq="MS")
    
    # Тренд + сезонность + шум
    t = np.arange(24)
    trend = 1000 + 50 * t
    seasonality = 200 * np.sin(2 * np.pi * t / 12)
    noise = np.random.RandomState(42).normal(0, 50, 24)
    
    impressions = trend + seasonality + noise
    impressions = np.maximum(impressions, 100)  # Минимум 100
    
    return pd.DataFrame({
        "date": dates,
        "query": "test query",
        "impressions": impressions,
        "clicks": impressions * 0.05,  # 5% CTR
        "position": np.random.RandomState(42).uniform(5, 15, 24)
    })


@pytest.fixture
def ctr_training_data():
    """Данные для обучения CTR модели."""
    positions = np.array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    impressions = np.array([10000, 8000, 6000, 5000, 4000, 3500, 3000, 2500, 2000, 1500])
    
    # CTR убывает с позицией
    ctr_values = np.array([0.30, 0.18, 0.12, 0.09, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02])
    clicks = impressions * ctr_values
    
    return pd.DataFrame({
        "position": positions,
        "impressions": impressions,
        "clicks": clicks
    })


@pytest.fixture
def small_time_series():
    """Маленький временной ряд (10 точек) для тестов fallback."""
    dates = pd.date_range("2023-01-01", periods=10, freq="MS")
    
    return pd.DataFrame({
        "date": dates,
        "query": "small query",
        "impressions": np.random.RandomState(123).randint(500, 1500, 10),
        "clicks": np.random.RandomState(124).randint(20, 80, 10),
        "position": np.random.RandomState(125).uniform(8, 12, 10)
    })
