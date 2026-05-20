"""Тесты preprocessing модуля."""

import numpy as np
import pandas as pd
import pytest

from forecaster_py.app.preprocessing import (
    clean_data,
    detect_and_smooth_anomalies,
    resample_to_frequency
)


def test_clean_data_removes_nan(synthetic_time_series):
    """Проверяет удаление NaN."""
    df = synthetic_time_series.copy()
    df.loc[5, "impressions"] = np.nan
    
    cleaned = clean_data(df, "impressions")
    
    assert len(cleaned) == len(df) - 1
    assert not cleaned["impressions"].isna().any()


def test_clean_data_removes_duplicates(synthetic_time_series):
    """Проверяет удаление дубликатов по дате."""
    df = synthetic_time_series.copy()
    duplicate_row = df.iloc[10:11].copy()
    df = pd.concat([df, duplicate_row], ignore_index=True)
    
    cleaned = clean_data(df, "impressions")
    
    assert len(cleaned) == len(synthetic_time_series)


def test_clean_data_removes_negatives(synthetic_time_series):
    """Проверяет удаление отрицательных значений."""
    df = synthetic_time_series.copy()
    df.loc[3, "impressions"] = -100
    
    cleaned = clean_data(df, "impressions")
    
    assert len(cleaned) == len(df) - 1
    assert (cleaned["impressions"] > 0).all()


def test_detect_anomalies_iqr_fallback(synthetic_time_series):
    """Проверяет детекцию аномалий через IQR (без Kats)."""
    df = synthetic_time_series.copy()
    
    # Добавляем явную аномалию
    df.loc[10, "impressions"] = 10000  # Резкий всплеск
    
    smoothed = detect_and_smooth_anomalies(df, "impressions", use_kats=False)
    
    assert len(smoothed) == len(df)
    # Аномалия должна быть сглажена
    assert smoothed.loc[10, "impressions"] < df.loc[10, "impressions"]


def test_resample_to_monthly(synthetic_time_series):
    """Проверяет ресемплинг к месячной частоте."""
    df = synthetic_time_series.copy()
    
    resampled = resample_to_frequency(df, freq="MS", agg="sum")
    
    assert len(resampled) == 24
    assert "date" in resampled.columns
